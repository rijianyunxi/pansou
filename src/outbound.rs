//! Owner-local node selection. Higher weight wins; direct is an explicit built-in node.
use crate::{app::AppState, error::ApiError};
use serde::{Deserialize, Serialize};
use sqlx::{PgPool, Postgres, Row, Transaction};
use std::collections::HashSet;
pub const DIRECT: &str = "direct";
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NodeWeight {
    pub node_id: String,
    pub weight: i32,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Policy {
    #[serde(default)]
    pub nodes: Vec<NodeWeight>,
    #[serde(default)]
    pub version: i64,
    #[serde(default, skip_serializing_if = "is_false")]
    pub inherit: bool,
}
fn is_false(v: &bool) -> bool {
    !*v
}
impl Policy {
    pub fn direct() -> Self {
        Self {
            nodes: vec![NodeWeight {
                node_id: DIRECT.into(),
                weight: 10,
            }],
            version: 0,
            inherit: false,
        }
    }
    pub fn validate(&self, channel: bool) -> Result<(), ApiError> {
        if self.inherit {
            if !channel || !self.nodes.is_empty() {
                return Err(ApiError::BadRequest(
                    "默认节点仅供频道继承，不能同时选择独立节点".into(),
                ));
            }
            return Ok(());
        }
        if self.nodes.is_empty() || self.nodes.len() > 50 {
            return Err(ApiError::BadRequest(
                "请选择1～50个节点，直连也需明确勾选".into(),
            ));
        }
        let mut ids = HashSet::new();
        for n in &self.nodes {
            if n.node_id.is_empty() || !ids.insert(&n.node_id) || !(0..=10000).contains(&n.weight) {
                return Err(ApiError::BadRequest(
                    "节点重复或权重不在0～10000范围".into(),
                ));
            }
        }
        Ok(())
    }
}
#[derive(Clone, Copy)]
pub enum Owner<'a> {
    Source(&'a str),
    Channel(&'a str),
    Default,
}
fn ids(o: Owner<'_>) -> (Option<&str>, Option<&str>, Option<&str>) {
    match o {
        Owner::Source(s) => (Some(s), None, None),
        Owner::Channel(c) => (None, Some(c), None),
        Owner::Default => (None, None, Some("telegram")),
    }
}
pub const POLICY_COLUMNS: &str = "p.inherit,p.version,COALESCE((SELECT jsonb_agg(jsonb_build_object('nodeId',n.node_id,'weight',n.weight) ORDER BY n.weight DESC,n.node_id DESC) FROM outbound_policy_nodes n WHERE n.policy_id=p.id),'[]'::jsonb) members";
pub fn from_row(r: &sqlx::postgres::PgRow) -> Result<Policy, ApiError> {
    Ok(Policy {
        nodes: serde_json::from_value(r.get::<serde_json::Value, _>("members"))
            .map_err(|e| ApiError::Internal(format!("节点配置损坏：{e}")))?,
        version: r.get("version"),
        inherit: r.get("inherit"),
    })
}
pub async fn read(pool: &PgPool, owner: Owner<'_>) -> Result<Option<Policy>, ApiError> {
    let (s, c, d) = ids(owner);
    sqlx::query(&format!("SELECT {POLICY_COLUMNS} FROM outbound_policies p WHERE source_id=$1 OR channel_id=$2 OR default_key=$3")).bind(s).bind(c).bind(d).fetch_optional(pool).await?.as_ref().map(from_row).transpose()
}
pub async fn save(
    tx: &mut Transaction<'_, Postgres>,
    owner: Owner<'_>,
    p: &Policy,
) -> Result<(), ApiError> {
    p.validate(matches!(owner, Owner::Channel(_)))?;
    let (s, c, d) = ids(owner);
    let row=sqlx::query("SELECT id,version FROM outbound_policies WHERE source_id=$1 OR channel_id=$2 OR default_key=$3 FOR UPDATE").bind(s).bind(c).bind(d).fetch_optional(&mut **tx).await?;
    let id = if let Some(r) = row {
        if p.version != r.get::<i64, _>("version") {
            return Err(ApiError::Conflict(
                "节点配置已被其他操作修改，请重新加载".into(),
            ));
        }
        let id = r.get::<i64, _>("id");
        sqlx::query("UPDATE outbound_policies SET inherit=$2,version=version+1,updated_at=now() WHERE id=$1").bind(id).bind(p.inherit).execute(&mut **tx).await?;
        id
    } else {
        if p.version != 0 {
            return Err(ApiError::Conflict("节点配置版本已失效".into()));
        }
        sqlx::query_scalar::<_,i64>("INSERT INTO outbound_policies(source_id,channel_id,default_key,inherit) VALUES($1,$2,$3,$4) RETURNING id").bind(s).bind(c).bind(d).bind(p.inherit).fetch_one(&mut **tx).await?
    };
    let selected = p
        .nodes
        .iter()
        .map(|n| n.node_id.clone())
        .collect::<Vec<_>>();
    let found = sqlx::query_scalar::<_, i64>("SELECT count(*) FROM proxy_nodes WHERE id=ANY($1)")
        .bind(&selected)
        .fetch_one(&mut **tx)
        .await?;
    if found != selected.len() as i64 {
        return Err(ApiError::BadRequest(
            "选中的节点不存在，请刷新节点列表".into(),
        ));
    }
    sqlx::query("DELETE FROM outbound_policy_nodes WHERE policy_id=$1 AND NOT(node_id=ANY($2))")
        .bind(id)
        .bind(&selected)
        .execute(&mut **tx)
        .await?;
    let weights = p.nodes.iter().map(|n| n.weight).collect::<Vec<_>>();
    sqlx::query("INSERT INTO outbound_policy_nodes(policy_id,node_id,weight) SELECT $1,id,weight FROM unnest($2::text[],$3::int[]) x(id,weight) ON CONFLICT(policy_id,node_id) DO UPDATE SET weight=excluded.weight WHERE outbound_policy_nodes.weight IS DISTINCT FROM excluded.weight").bind(id).bind(selected).bind(weights).execute(&mut **tx).await?;
    Ok(())
}
#[derive(Debug, Clone)]
pub struct Candidate {
    pub id: String,
    pub name: String,
    pub base_url: String,
}
pub struct Plan {
    pub version: i64,
    remaining: Vec<NodeWeight>,
    attempted: bool,
    allow_retry: bool,
}
fn sort_nodes(nodes: &mut [NodeWeight]) {
    nodes.sort_by(|a, b| {
        b.weight
            .cmp(&a.weight)
            .then_with(|| b.node_id.cmp(&a.node_id))
    });
}
impl Plan {
    pub async fn load(pool: &PgPool, owner: Owner<'_>, method: &str) -> Result<Self, ApiError> {
        let mut p = read(pool, owner)
            .await?
            .ok_or_else(|| ApiError::Upstream("未配置节点，拒绝隐式直连".into()))?;
        if p.inherit {
            p = read(pool, Owner::Default)
                .await?
                .ok_or_else(|| ApiError::Upstream("TG 默认节点未配置".into()))?;
        }
        p.validate(false)?;
        sort_nodes(&mut p.nodes);
        Ok(Self {
            version: p.version,
            remaining: p.nodes,
            attempted: false,
            allow_retry: method == "GET" || method == "HEAD",
        })
    }
    pub async fn next(&mut self, pool: &PgPool) -> Result<Option<Option<Candidate>>, ApiError> {
        if self.attempted && !self.allow_retry {
            return Ok(None);
        }
        while !self.remaining.is_empty() {
            let member = self.remaining.remove(0);
            if member.node_id == DIRECT {
                self.attempted = true;
                return Ok(Some(None));
            }
            let r=sqlx::query("UPDATE proxy_nodes SET quota_day=CURRENT_DATE,quota_used=CASE WHEN quota_day=CURRENT_DATE THEN quota_used+1 ELSE 1 END,probe_in_flight=(circuit_state='open'),probe_lease_until=CASE WHEN circuit_state='open' THEN now()+interval '30 seconds' ELSE NULL END,updated_at=now() WHERE id=$1 AND kind='proxy' AND enabled AND (daily_limit<=0 OR quota_day IS DISTINCT FROM CURRENT_DATE OR quota_used<daily_limit) AND (circuit_state='closed' OR (circuit_state='open' AND (NOT probe_in_flight OR probe_lease_until<=now()) AND (opened_until IS NULL OR opened_until<=now()))) RETURNING id,name,base_url").bind(&member.node_id).fetch_optional(pool).await?;
            if let Some(r) = r {
                self.attempted = true;
                return Ok(Some(Some(Candidate {
                    id: r.get("id"),
                    name: r.get("name"),
                    base_url: r.get("base_url"),
                })));
            }
        }
        Ok(None)
    }
}
pub async fn record_failure(
    state: &AppState,
    node: &Candidate,
    status: Option<u16>,
    message: &str,
    policy: &crate::policy::UserPolicy,
) {
    let _=sqlx::query("UPDATE proxy_nodes SET probe_in_flight=false,probe_lease_until=NULL,failure_count=failure_count+1,circuit_state=CASE WHEN failure_count+1 >= $2 THEN 'open' ELSE 'closed' END,opened_until=CASE WHEN failure_count+1 >= $2 THEN now()+($3 * interval '1 second') ELSE NULL END,last_status=$4,last_error=$5,last_failure_at=now(),updated_at=now() WHERE id=$1").bind(&node.id).bind(policy.proxy_circuit_breaker_max_failures).bind(policy.proxy_circuit_breaker_timeout_seconds).bind(status.map(i32::from)).bind(message.chars().take(500).collect::<String>()).execute(&state.pool).await;
}
pub async fn record_success(state: &AppState, node: &Candidate, status: u16) {
    let _=sqlx::query("UPDATE proxy_nodes SET probe_in_flight=false,probe_lease_until=NULL,circuit_state='closed',failure_count=0,opened_until=NULL,last_status=$2,last_error=NULL,last_success_at=now(),updated_at=now() WHERE id=$1").bind(&node.id).bind(i32::from(status)).execute(&state.pool).await;
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn priority_is_weight_desc_with_stable_ties() {
        let mut n = vec![
            NodeWeight {
                node_id: "a".into(),
                weight: 20,
            },
            NodeWeight {
                node_id: DIRECT.into(),
                weight: 0,
            },
            NodeWeight {
                node_id: "z".into(),
                weight: 20,
            },
            NodeWeight {
                node_id: "b".into(),
                weight: 50,
            },
        ];
        sort_nodes(&mut n);
        assert_eq!(
            n.iter().map(|n| n.node_id.as_str()).collect::<Vec<_>>(),
            vec!["b", "z", "a", DIRECT]
        );
    }
    #[test]
    fn selection_rejects_duplicates_empty_and_bad_weight() {
        let mut p = Policy::direct();
        assert!(p.validate(false).is_ok());
        p.nodes.push(p.nodes[0].clone());
        assert!(p.validate(false).is_err());
        p.nodes.clear();
        assert!(p.validate(false).is_err());
        p.inherit = true;
        assert!(p.validate(true).is_ok());
        assert!(p.validate(false).is_err());
        p.inherit = false;
        p.nodes.push(NodeWeight {
            node_id: DIRECT.into(),
            weight: -1,
        });
        assert!(p.validate(false).is_err());
    }
}
