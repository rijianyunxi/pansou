//! One snapshot update per completed logical request; retries are not separate requests.
use crate::{app::AppState, models::Source};
use serde_json::{Value, json};
use sqlx::PgPool;

const RECENT_LIMIT: usize = 100;
const HOUR_MS: i64 = 3_600_000;

/// Final attempt's measured stages. None means the stage was not reached/measured.
/// A business-specific success predicate is not currently available in the DSL.
#[derive(Default)]
pub(super) struct Observation {
    pub network: Option<bool>,
    pub http: Option<bool>,
    pub parsing: Option<bool>,
    pub results: Option<bool>,
    pub error_category: Option<&'static str>,
}

impl Observation {
    fn error_message(&self) -> &'static str {
        match self.error_category {
            Some("configuration") => "资源源地址配置无效",
            Some("network") => "资源源网络请求或响应读取失败",
            Some("http") => "资源源返回非成功 HTTP 状态",
            Some("parsing") => "资源源响应解析失败",
            _ => "资源源出站策略不可用或请求未完成",
        }
    }
}

pub(super) async fn record_source_health(
    state: &AppState,
    source: &Source,
    ok: bool,
    result_count: usize,
    elapsed_ms: u128,
    observation: &Observation,
    max_failures: i64,
) {
    if let Err(error) = update_snapshot(
        &state.pool,
        source,
        ok,
        result_count,
        elapsed_ms,
        observation,
        max_failures,
    )
    .await
    {
        // Failed reads/locks must not overwrite a valid snapshot with default counters.
        tracing::warn!(source=%source.id, %error, "source health snapshot update failed");
    }
}

async fn update_snapshot(
    pool: &PgPool,
    source: &Source,
    ok: bool,
    result_count: usize,
    elapsed_ms: u128,
    observation: &Observation,
    max_failures: i64,
) -> Result<(), sqlx::Error> {
    let mut tx = pool.begin().await?;
    // Bound contention so optional telemetry does not hold up a search indefinitely.
    sqlx::query("SET LOCAL lock_timeout='2s'")
        .execute(&mut *tx)
        .await?;
    sqlx::query("SET LOCAL statement_timeout='3s'")
        .execute(&mut *tx)
        .await?;
    // INSERT handles the first concurrent requests too: FOR UPDATE cannot lock a missing row.
    sqlx::query!(
        "INSERT INTO source_health(source_id) VALUES($1) ON CONFLICT(source_id) DO NOTHING",
        source.id,
    )
    .execute(&mut *tx)
    .await?;
    let row = sqlx::query!(
        "SELECT snapshot_json, clock_timestamp() AS \"observed_at!\" FROM source_health WHERE source_id=$1 FOR UPDATE",
        source.id,
    ).fetch_one(&mut *tx).await?;
    let now = row.observed_at.timestamp_millis();
    let snapshot = reduce_snapshot(
        row.snapshot_json,
        source,
        ok,
        result_count,
        elapsed_ms,
        observation,
        max_failures,
        now,
    );
    sqlx::query!(
        "UPDATE source_health SET snapshot_json=$2,updated_at=now() WHERE source_id=$1",
        source.id,
        snapshot,
    )
    .execute(&mut *tx)
    .await?;
    tx.commit().await
}

fn count(value: &Value, key: &str) -> i64 {
    value.get(key).and_then(Value::as_i64).unwrap_or(0).max(0)
}

fn append_recent(before: Option<&str>, pass: bool) -> String {
    let mut recent = before.unwrap_or("").to_owned();
    recent.push(if pass { '1' } else { '0' });
    let chars: Vec<_> = recent.chars().rev().take(RECENT_LIMIT).collect();
    chars.into_iter().rev().collect()
}

fn dimension(previous: &Value, observed: Option<bool>, empty: bool) -> Value {
    let observations = count(previous, "observedCount") + i64::from(observed.is_some());
    let passes = count(previous, "passCount") + i64::from(observed == Some(true));
    let recent = observed.map_or_else(
        || {
            previous
                .get("recent")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_owned()
        },
        |pass| append_recent(previous.get("recent").and_then(Value::as_str), pass),
    );
    json!({
        "state": match observed { None => "unknown", Some(true) => "pass", Some(false) if empty => "empty", Some(false) => "fail" },
        "passRate": (observations > 0).then(|| passes as f64 / observations as f64),
        "observedCount": observations, "passCount": passes, "recent": recent,
    })
}

// Nearest-rank empirical quantile over the actual retained response times.
fn percentile(sorted: &[u64], percent: usize) -> Option<u64> {
    if sorted.is_empty() {
        return None;
    }
    let rank = (sorted.len() * percent).div_ceil(100);
    sorted.get(rank.saturating_sub(1)).copied()
}

fn reduce_snapshot(
    mut snapshot: Value,
    source: &Source,
    ok: bool,
    result_count: usize,
    elapsed_ms: u128,
    observation: &Observation,
    max_failures: i64,
    now: i64,
) -> Value {
    if !snapshot.is_object() {
        snapshot = json!({});
    }
    let requests_before = count(&snapshot, "requestCount");
    let requests = requests_before + 1;
    let successes = count(&snapshot, "successCount") + i64::from(ok);
    let total_failures = snapshot
        .get("totalFailureCount")
        .and_then(Value::as_i64)
        .unwrap_or_else(|| count(&snapshot, "failureCount"))
        .max(0)
        + i64::from(!ok);
    let failures = if ok {
        0
    } else {
        count(&snapshot, "failureCount") + 1
    };
    let zero_results = count(&snapshot, "zeroResultCount") + i64::from(ok && result_count == 0);
    let result_total = count(&snapshot, "resultCount") + result_count as i64;
    let elapsed_ms = elapsed_ms.min(u64::MAX as u128) as u64;
    // Old snapshots stored only a rounded average. Preserve their approximate total once;
    // new updates keep the unrounded sum so repeated rounding cannot distort the mean.
    let total_response_time = snapshot
        .get("totalResponseTimeMs")
        .and_then(Value::as_f64)
        .unwrap_or_else(|| {
            snapshot
                .get("avgResponseTime")
                .and_then(Value::as_f64)
                .unwrap_or(0.0)
                .max(0.0)
                * requests_before as f64
        })
        + elapsed_ms as f64;
    let recent = append_recent(snapshot.get("recent").and_then(Value::as_str), ok);
    let category = if ok {
        None
    } else {
        Some(observation.error_category.unwrap_or("outbound"))
    };
    let message = if ok {
        None
    } else {
        Some(observation.error_message())
    };
    let mut outcomes = snapshot
        .get("recentOutcomes")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    outcomes.push(json!({"at":now, "ok":ok, "resultCount":result_count,
        "responseTimeMs":elapsed_ms, "errorCategory":category, "message":message}));
    if outcomes.len() > RECENT_LIMIT {
        outcomes.drain(..outcomes.len() - RECENT_LIMIT);
    }
    let mut times: Vec<_> = outcomes
        .iter()
        .filter_map(|v| v.get("responseTimeMs").and_then(Value::as_u64))
        .collect();
    times.sort_unstable();

    let hour = now - now.rem_euclid(HOUR_MS);
    let mut buckets = snapshot
        .get("history")
        .and_then(|h| h.get("buckets"))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    // Keep the current clock hour and the preceding 23, rather than 24 active hours.
    buckets.retain(|b| {
        b.get("t")
            .and_then(Value::as_i64)
            .is_some_and(|t| t > hour - 24 * HOUR_MS && t <= hour)
    });
    if !buckets
        .iter()
        .any(|b| b.get("t").and_then(Value::as_i64) == Some(hour))
    {
        buckets.push(json!({"t":hour,"n":0,"s":0,"f":0,"z":0,"e":{}}));
    }
    if let Some(bucket) = buckets
        .iter_mut()
        .find(|b| b.get("t").and_then(Value::as_i64) == Some(hour))
    {
        bucket["n"] = json!(count(bucket, "n") + 1);
        let key = if ok { "s" } else { "f" };
        bucket[key] = json!(count(bucket, key) + 1);
        if ok && result_count == 0 {
            bucket["z"] = json!(count(bucket, "z") + 1);
        }
        if let Some(category) = category {
            if !bucket.get("e").is_some_and(Value::is_object) {
                bucket["e"] = json!({});
            }
            bucket["e"][category] = json!(count(&bucket["e"], category) + 1);
        }
    }
    buckets.sort_by_key(|b| b.get("t").and_then(Value::as_i64).unwrap_or(0));
    // Previous dimensions copied the overall rate and cannot be reconstructed.
    let previous_dimensions = if snapshot
        .get("dimensionSchemaVersion")
        .and_then(Value::as_i64)
        == Some(2)
    {
        snapshot
            .get("dimensions")
            .cloned()
            .unwrap_or_else(|| json!({}))
    } else {
        json!({})
    };
    let dimensions = json!({
        "network": dimension(&previous_dimensions["network"], observation.network, false),
        "http": dimension(&previous_dimensions["http"], observation.http, false),
        "business": dimension(&previous_dimensions["business"], None, false),
        "parsing": dimension(&previous_dimensions["parsing"], observation.parsing, false),
        "results": dimension(&previous_dimensions["results"], observation.results, true),
    });
    let object = snapshot
        .as_object_mut()
        .expect("snapshot was normalized to an object");
    // Preserve legacy timestamps, but never let public aliases shadow fresh data.
    for (alias, key) in [
        ("lastSuccessAt", "lastSuccessTime"),
        ("lastFailureAt", "lastFailureTime"),
    ] {
        if let Some(value) = object.remove(alias) {
            object.entry(key).or_insert(value);
        }
    }
    object.remove("healthy");
    object.remove("recentFailures");
    for (key, value) in [
        ("name", json!(source.name)),
        ("recent", json!(recent)),
        ("requestCount", json!(requests)),
        ("successCount", json!(successes)),
        ("failureCount", json!(failures)),
        ("totalFailureCount", json!(total_failures)),
        ("failureWindowCount", json!(failures)),
        ("resultCount", json!(result_total)),
        ("zeroResultCount", json!(zero_results)),
        ("isHealthy", json!(ok)),
        (
            "circuitState",
            json!(if failures >= max_failures {
                "open"
            } else {
                "closed"
            }),
        ),
        ("totalResponseTimeMs", json!(total_response_time)),
        (
            "avgResponseTime",
            json!((total_response_time / requests as f64).round() as u64),
        ),
        ("p50ResponseTime", json!(percentile(&times, 50))),
        ("p95ResponseTime", json!(percentile(&times, 95))),
        (
            "responseTimeWindow",
            json!({"kind":"last_requests","limit":RECENT_LIMIT,"sampleCount":times.len(),"method":"nearest_rank"}),
        ),
        (
            "parsingSuccessRate",
            dimensions["parsing"]["passRate"].clone(),
        ),
        ("lastErrorMessage", json!(message.unwrap_or(""))),
        ("recentOutcomes", json!(outcomes)),
        ("history", json!({"windowHours":24,"buckets":buckets})),
        ("dimensionSchemaVersion", json!(2)),
        ("dimensions", dimensions),
    ] {
        object.insert(key.into(), value);
    }
    object.insert(
        if ok {
            "lastSuccessTime"
        } else {
            "lastFailureTime"
        }
        .into(),
        json!(now),
    );
    snapshot
}

pub(super) async fn source_circuit_open(
    state: &AppState,
    source_id: &str,
    max_failures: i64,
) -> bool {
    let snapshot = sqlx::query_scalar!(
        "SELECT snapshot_json FROM source_health WHERE source_id=$1",
        source_id,
    )
    .fetch_optional(&state.pool)
    .await;
    let snapshot = match snapshot {
        Ok(Some(value)) => value,
        Ok(None) => return false,
        Err(error) => {
            tracing::warn!(source=source_id, %error, "source circuit snapshot read failed");
            return false;
        }
    };
    let failures = count(&snapshot, "failureCount");
    let last_failure = snapshot
        .get("lastFailureTime")
        .and_then(Value::as_i64)
        .unwrap_or(0);
    failures >= max_failures
        && chrono::Utc::now()
            .timestamp_millis()
            .saturating_sub(last_failure)
            < 60_000
}
