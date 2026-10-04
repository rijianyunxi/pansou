use crate::{
    error::ApiError,
    models::{Link, SearchResult},
};
use chrono::{DateTime, FixedOffset, NaiveDate, NaiveDateTime, Utc};
use regex::Regex;
use scraper::{Html, Selector, node::Node};
use serde::Deserialize;
use serde_json::Value;
use std::collections::HashSet;
use url::Url;

mod html;
use html::{apply_html, apply_pansearch_html};

#[derive(Debug, Deserialize)]
struct TransformSpec {
    kind: String,
    #[serde(default)]
    items: Option<String>,
    #[serde(default)]
    item_selector: Option<String>,
    fields: serde_json::Map<String, Value>,
    #[serde(default)]
    limit: Option<usize>,
}

pub fn validate(dsl: &str) -> Result<(), ApiError> {
    if dsl.len() > 65536 {
        return Err(ApiError::BadRequest("DSL 不能超过64KiB".into()));
    }
    let spec: TransformSpec = serde_json::from_str(dsl)
        .map_err(|e| ApiError::BadRequest(format!("无效 Rust transform DSL：{e}")))?;
    if !matches!(spec.kind.as_str(), "html" | "json") {
        return Err(ApiError::BadRequest("DSL kind 仅支持 html/json".into()));
    }
    if let Some(selector) = spec.item_selector {
        Selector::parse(&selector).map_err(|_| ApiError::BadRequest("无效消息CSS选择器".into()))?;
    }
    Ok(())
}

pub fn apply(
    transform: &str,
    payload: &str,
    format: &str,
    keyword: &str,
    source: &str,
) -> Result<Vec<SearchResult>, ApiError> {
    let spec: TransformSpec = serde_json::from_str(transform)
        .map_err(|e| ApiError::BadRequest(format!("transform 必须是 Rust 原生 JSON DSL：{e}")))?;
    let limit = spec.limit.unwrap_or(200).min(500);
    if source == "pansearch" && spec.kind == "html" {
        return apply_pansearch_html(payload, keyword, source, limit);
    }
    match spec.kind.as_str() {
        "json" => apply_json(&spec, payload, keyword, source, limit),
        "html" => apply_html(&spec, payload, keyword, source, limit),
        _ => Err(ApiError::BadRequest(format!(
            "不支持的 transform kind: {} (format={format})",
            spec.kind
        ))),
    }
}
fn apply_json(
    spec: &TransformSpec,
    payload: &str,
    keyword: &str,
    source: &str,
    limit: usize,
) -> Result<Vec<SearchResult>, ApiError> {
    let raw_root: Value = serde_json::from_str(payload)
        .map_err(|e| ApiError::BadRequest(format!("上游 JSON 无效: {e}")))?;
    // xiaokupan uses a compact TSON envelope instead of a normal JSON
    // response. Decode that envelope before applying the native JSON DSL.
    let root = decode_tson(&raw_root);
    let items = spec
        .items
        .as_deref()
        .map(|p| select_json_values(&root, p))
        .unwrap_or_else(|| vec![&root]);
    Ok(items
        .into_iter()
        .take(limit)
        .filter_map(|item| build_result(item, &spec.fields, keyword, source))
        .collect())
}
fn build_result(
    item: &Value,
    fields: &serde_json::Map<String, Value>,
    _keyword: &str,
    source: &str,
) -> Option<SearchResult> {
    let get = |key: &str| fields.get(key).and_then(|expr| value_for(item, expr));
    let name = clean_text(&scalar(get("name").or_else(|| get("title"))).unwrap_or_default());
    if name.is_empty() {
        return None;
    }
    let description = scalar(get("description").or_else(|| get("desc")))
        .map(|description| clean_text(&description))
        .filter(|description| !description.is_empty() && description.trim() != name.trim());
    let datetime = normalize_datetime(scalar(get("datetime").or_else(|| get("date"))));
    let links = links_from(get("links").or_else(|| get("url")));
    let id = scalar(get("id"))
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| {
            format!(
                "{source}-{}",
                stable_hash(
                    &links
                        .iter()
                        .map(|l| crate::resource_clean::link_identity(&l.url))
                        .collect::<Vec<_>>()
                        .join("|")
                )
            )
        });
    if links.is_empty() {
        return None;
    }
    let cloud_types = links
        .iter()
        .map(|l| l.r#type.clone())
        .collect::<HashSet<_>>()
        .into_iter()
        .collect();
    let images = array_strings(get("images").or_else(|| get("image")));
    let result = crate::resource_clean::normalize(SearchResult {
        id,
        name,
        description,
        datetime,
        cloud_types,
        links,
        images: (!images.is_empty()).then_some(images),
    });
    (!result.name.is_empty() && !result.links.is_empty()).then_some(result)
}
fn value_for<'a>(item: &'a Value, expr: &Value) -> Option<&'a Value> {
    match expr {
        Value::String(path) => select_json(item, path),
        Value::Object(map) => map.get("path").and_then(|p| value_for(item, p)),
        _ => None,
    }
}
fn select_json<'a>(root: &'a Value, path: &str) -> Option<&'a Value> {
    select_json_values(root, path).into_iter().next()
}
fn select_json_values<'a>(root: &'a Value, path: &str) -> Vec<&'a Value> {
    let path = path.trim();
    if path == "$" {
        return vec![root];
    }
    let path = path
        .strip_prefix("$.")
        .or_else(|| path.strip_prefix("$"))
        .unwrap_or(path);
    let mut current = vec![root];
    for segment in path.split('.').filter(|s| !s.is_empty()) {
        let mut next = Vec::new();
        let wildcard_array = segment == "[*]";
        let wildcard_object = segment == "*";
        let wildcard_object_arrays = segment == "*[*]";
        let key = segment.strip_suffix("[*]").filter(|x| !x.is_empty());
        for value in current {
            if wildcard_object_arrays {
                match value {
                    Value::Object(map) => {
                        for child in map.values() {
                            if let Some(items) = child.as_array() {
                                next.extend(items.iter());
                            }
                        }
                    }
                    Value::Array(items) => {
                        for child in items {
                            if let Some(items) = child.as_array() {
                                next.extend(items.iter());
                            }
                        }
                    }
                    _ => {}
                }
            } else if let Some(key) = key {
                if let Some(items) = value.get(key).and_then(Value::as_array) {
                    next.extend(items.iter());
                }
            } else if wildcard_array {
                if let Some(items) = value.as_array() {
                    next.extend(items.iter());
                }
            } else if wildcard_object {
                match value {
                    Value::Object(map) => next.extend(map.values()),
                    Value::Array(items) => next.extend(items.iter()),
                    _ => {}
                }
            } else if let Ok(index) = segment.parse::<usize>() {
                if let Some(item) = value.get(index) {
                    next.push(item);
                }
            } else if let Some(item) = value.get(segment) {
                next.push(item);
            }
        }
        current = next;
        if current.is_empty() {
            break;
        }
    }
    current
}

fn decode_tson(value: &Value) -> Value {
    let Some(object) = value.as_object() else {
        return match value {
            Value::Array(items) => Value::Array(items.iter().map(decode_tson).collect()),
            _ => value.clone(),
        };
    };
    match object.get("t").and_then(Value::as_i64) {
        Some(10) => {
            let keys = object
                .get("p")
                .and_then(|p| p.get("k"))
                .and_then(Value::as_array);
            let values = object
                .get("p")
                .and_then(|p| p.get("v"))
                .and_then(Value::as_array);
            let mut out = serde_json::Map::new();
            if let (Some(keys), Some(values)) = (keys, values) {
                for (key, value) in keys.iter().zip(values.iter()) {
                    if let Some(key) = key.as_str() {
                        out.insert(key.to_owned(), decode_tson(value));
                    }
                }
            }
            Value::Object(out)
        }
        Some(9) => Value::Array(
            object
                .get("a")
                .and_then(Value::as_array)
                .map(|a| a.iter().map(decode_tson).collect())
                .unwrap_or_default(),
        ),
        Some(1) => object.get("s").cloned().unwrap_or(Value::Null),
        Some(0) => object
            .get("s")
            .and_then(|v| {
                v.as_i64().map(|n| Value::Number(n.into())).or_else(|| {
                    v.as_str()
                        .and_then(|s| s.parse::<i64>().ok())
                        .map(|n| Value::Number(n.into()))
                })
            })
            .unwrap_or(Value::Null),
        _ => Value::Object(
            object
                .iter()
                .map(|(k, v)| (k.clone(), decode_tson(v)))
                .collect(),
        ),
    }
}
fn normalize_datetime(value: Option<String>) -> Option<String> {
    let raw = value?.trim().to_owned();
    if raw.is_empty() {
        return None;
    }
    if let Ok(parsed) = DateTime::parse_from_rfc3339(&raw) {
        let zone = FixedOffset::east_opt(8 * 60 * 60).expect("UTC+8");
        return Some(
            parsed
                .with_timezone(&zone)
                .format("%Y-%m-%d %H:%M:%S")
                .to_string(),
        );
    }
    for format in [
        "%Y-%m-%d %H:%M:%S%.f",
        "%Y-%m-%d %H:%M:%S",
        "%Y-%m-%dT%H:%M:%S%.f",
        "%Y-%m-%dT%H:%M:%S",
    ] {
        if let Ok(parsed) = NaiveDateTime::parse_from_str(&raw, format) {
            return Some(parsed.format("%Y-%m-%d %H:%M:%S").to_string());
        }
    }
    if let Ok(parsed) = NaiveDate::parse_from_str(&raw, "%Y-%m-%d") {
        return Some(parsed.format("%Y-%m-%d 00:00:00").to_string());
    }
    if let Ok(number) = raw.parse::<i64>() {
        let milliseconds = if number.abs() < 1_000_000_000_000 {
            number.saturating_mul(1000)
        } else {
            number
        };
        if let Some(parsed) = DateTime::<Utc>::from_timestamp_millis(milliseconds) {
            let zone = FixedOffset::east_opt(8 * 60 * 60).expect("UTC+8");
            return Some(
                parsed
                    .with_timezone(&zone)
                    .format("%Y-%m-%d %H:%M:%S")
                    .to_string(),
            );
        }
    }
    None
}

fn clean_text(value: &str) -> String {
    let value = value.trim();
    if value.is_empty() {
        return String::new();
    }
    let fragment = Html::parse_fragment(value);
    let text = fragment.root_element().text().collect::<Vec<_>>().join(" ");
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}
fn scalar(v: Option<&Value>) -> Option<String> {
    match v? {
        Value::String(s) => Some(s.trim().to_owned()),
        Value::Number(n) => Some(n.to_string()),
        Value::Bool(b) => Some(b.to_string()),
        _ => None,
    }
}
fn array_strings(v: Option<&Value>) -> Vec<String> {
    match v {
        Some(Value::Array(a)) => a.iter().filter_map(|x| scalar(Some(x))).collect(),
        Some(x) => scalar(Some(x)).into_iter().collect(),
        None => vec![],
    }
}
fn links_from(v: Option<&Value>) -> Vec<Link> {
    let values = match v {
        Some(Value::Array(a)) => a.clone(),
        Some(x) => vec![x.clone()],
        None => vec![],
    };
    let mut links = Vec::new();
    let url_pattern = Regex::new(r#"(?i)(?:https?://[^\s$<>\"']+|magnet:\?[^\s$<>\"']+)"#)
        .expect("valid resource URL pattern");
    for value in values {
        let (urls, pw) = match value {
            Value::Object(m) => (
                scalar(m.get("url")).into_iter().collect::<Vec<_>>(),
                scalar(m.get("password")),
            ),
            Value::String(s) => {
                let urls = url_pattern
                    .find_iter(&s)
                    .map(|matched| {
                        matched
                            .as_str()
                            .trim_end_matches([',', '，', '。', ';'])
                            .to_owned()
                    })
                    .collect();
                (urls, None)
            }
            _ => (Vec::new(), None),
        };
        for url in urls {
            if !is_resource_url(&url) {
                continue;
            }
            links.push(Link {
                r#type: infer_type(&url),
                url,
                password: pw.clone(),
            });
        }
    }
    links
}
fn is_resource_url(url: &str) -> bool {
    if url.starts_with("magnet:") {
        return true;
    }
    Url::parse(url)
        .map(|u| {
            if !matches!(u.scheme(), "http" | "https") {
                return false;
            }
            let host = u.host_str().unwrap_or_default().to_ascii_lowercase();
            !matches!(host.as_str(), "t.me" | "telegram.me" | "telegram.org")
                && !host.ends_with(".t.me")
                && !host.ends_with(".telegram.me")
                && !host.ends_with(".telegram.org")
        })
        .unwrap_or(false)
}
fn infer_type(url: &str) -> String {
    if let Some(kind) = crate::resource_clean::cloud_type(url) {
        return kind.into();
    }
    if url.starts_with("magnet:") {
        return "magnet".into();
    }
    let host = Url::parse(url)
        .ok()
        .and_then(|u| u.host_str().map(str::to_lowercase))
        .unwrap_or_default();
    for (needle, kind) in [
        ("pan.baidu.com", "baidu"),
        ("pan.quark.cn", "quark"),
        ("115cdn.com", "115"),
        ("115.com", "115"),
        ("aliyundrive.com", "aliyun"),
        ("alipan.com", "aliyun"),
        ("drive.uc.cn", "uc"),
        ("115.com", "115"),
        ("123pan.com", "123"),
        ("123pan.cn", "123"),
        ("xunlei.com", "xunlei"),
        ("189.cn", "tianyi"),
        ("139.com", "mobile"),
        ("lanzou", "lanzou"),
        ("jianguoyun.com", "jianguoyun"),
    ] {
        if host == needle || host.ends_with(&format!(".{needle}")) {
            return kind.into();
        }
    }
    "others".into()
}
fn stable_hash(s: &str) -> String {
    use sha2::{Digest, Sha256};
    let mut h = Sha256::new();
    h.update(s.as_bytes());
    hex_string(&h.finalize()[..8])
}
fn hex_string(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}
#[cfg(test)]
mod tests;
