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
fn apply_html(
    spec: &TransformSpec,
    payload: &str,
    keyword: &str,
    source: &str,
    limit: usize,
) -> Result<Vec<SearchResult>, ApiError> {
    let html = Html::parse_document(payload);
    let selector = Selector::parse(spec.item_selector.as_deref().unwrap_or("body"))
        .map_err(|e| ApiError::BadRequest(format!("item_selector 无效: {e}")))?;
    let mut out = Vec::new();
    for node in html.select(&selector).take(limit) {
        let mut obj = serde_json::Map::new();
        for (key, expr) in &spec.fields {
            let value = html_field(key, node, expr);
            obj.insert(key.clone(), value);
        }
        let html_fields = spec
            .fields
            .keys()
            .map(|key| (key.clone(), Value::String(format!("$.{key}"))))
            .collect::<serde_json::Map<_, _>>();
        let tg = node.value().classes().any(|c| c == "tgme_widget_message");
        if tg {
            let sel = Selector::parse(".tgme_widget_message_text").unwrap();
            let Some(body) = node.select(&sel).next() else {
                continue;
            };
            let plain = html_text_with_breaks(body);
            let segments = crate::telegram::segments(&plain);
            for segment in segments {
                let (name, desc) = telegram_parts(&segment);
                let mut fields = obj.clone();
                fields.insert("name".into(), Value::String(name));
                fields.insert("description".into(), Value::String(desc));
                static TAGS: std::sync::LazyLock<Regex> =
                    std::sync::LazyLock::new(|| Regex::new(r"#[\p{L}\p{N}_]+").unwrap());
                let tags = TAGS
                    .find_iter(&segment)
                    .map(|m| m.as_str().trim_start_matches('#').to_owned())
                    .collect::<Vec<_>>();
                if !tags.is_empty() {
                    fields.insert("tags".into(), serde_json::to_value(tags).unwrap());
                }
                let links = crate::resource_clean::extract_links(&segment);
                fields.insert("links".into(), serde_json::to_value(links).unwrap());
                let identities = fields
                    .keys()
                    .map(|k| (k.clone(), Value::String(format!("$.{k}"))))
                    .collect();
                if let Some(item) =
                    build_result(&Value::Object(fields), &identities, keyword, source)
                {
                    out.push(item);
                }
            }
        } else if let Some(item) = build_result(&Value::Object(obj), &html_fields, keyword, source)
        {
            out.push(item);
        }
        if out.len() >= limit {
            out.truncate(limit);
            break;
        }
    }
    Ok(out)
}

fn apply_pansearch_html(
    payload: &str,
    keyword: &str,
    source: &str,
    limit: usize,
) -> Result<Vec<SearchResult>, ApiError> {
    let script = Regex::new(r#"<script[^>]*id=[\"']__NEXT_DATA__[\"'][^>]*>(?s:(.*?))</script>"#)
        .expect("valid next data selector");
    let raw = script
        .captures(payload)
        .and_then(|captures| captures.get(1))
        .ok_or_else(|| ApiError::BadRequest("PanSearch 未找到 __NEXT_DATA__".into()))?
        .as_str();
    let root: Value = serde_json::from_str(raw)
        .map_err(|e| ApiError::BadRequest(format!("PanSearch 数据无效: {e}")))?;
    let items = select_json_values(&root, "$.props.pageProps.data.data[*]");
    let identity = [
        "id",
        "name",
        "description",
        "datetime",
        "links",
        "tags",
        "images",
    ]
    .into_iter()
    .map(|key| (key.to_owned(), Value::String(key.to_owned())))
    .collect::<serde_json::Map<_, _>>();
    let mut out = Vec::new();
    for item in items.into_iter().take(limit) {
        let Some(object) = item.as_object() else {
            continue;
        };
        let content = object
            .get("content")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let fragment = Html::parse_fragment(content);
        let text = fragment.root_element().text().collect::<Vec<_>>().join("");
        let name = text
            .split_once("描述：")
            .map(|(head, _)| head.trim().trim_start_matches("名称：").trim().to_owned())
            .unwrap_or_else(|| text.trim().to_owned());
        if name.is_empty() {
            continue;
        }
        let description = text
            .split_once("描述：")
            .map(|(_, tail)| {
                tail.split("链接：")
                    .next()
                    .unwrap_or(tail)
                    .trim()
                    .to_owned()
            })
            .filter(|value| !value.is_empty());
        let links = fragment
            .select(&Selector::parse("a.resource-link").expect("valid PanSearch link selector"))
            .filter_map(|node| node.value().attr("href"))
            .map(|url| Value::String(url.to_owned()))
            .collect::<Vec<_>>();
        let Some(id) = object.get("id") else {
            continue;
        };
        let mut normalized = serde_json::Map::new();
        normalized.insert("id".into(), id.clone());
        normalized.insert("name".into(), Value::String(name));
        normalized.insert(
            "description".into(),
            description.map(Value::String).unwrap_or(Value::Null),
        );
        normalized.insert(
            "datetime".into(),
            object.get("time").cloned().unwrap_or(Value::Null),
        );
        normalized.insert("links".into(), Value::Array(links));
        normalized.insert(
            "tags".into(),
            object
                .get("pan")
                .cloned()
                .map(|v| Value::Array(vec![v]))
                .unwrap_or(Value::Null),
        );
        normalized.insert(
            "images".into(),
            object.get("image").cloned().unwrap_or(Value::Null),
        );
        if let Some(result) = build_result(&Value::Object(normalized), &identity, keyword, source) {
            out.push(result);
        }
    }
    Ok(out)
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
    let tags = array_strings(get("tags"))
        .into_iter()
        .map(|tag| clean_text(&tag))
        // `plugin:*` was internal source-runtime metadata in the old
        // implementation. It is not part of the public SearchResult contract
        // and must never leak through `/api/search` or `/api/search/json`.
        .filter(|tag| !tag.is_empty() && !tag.to_ascii_lowercase().starts_with("plugin:"))
        .collect::<Vec<_>>();
    let images = array_strings(get("images").or_else(|| get("image")));
    let result = crate::resource_clean::normalize(SearchResult {
        id,
        name,
        description,
        datetime,
        cloud_types,
        links,
        tags: (!tags.is_empty()).then_some(tags),
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
fn html_field(key: &str, node: scraper::ElementRef<'_>, expr: &Value) -> Value {
    let Some(selector) = expr.as_str() else {
        return Value::Null;
    };
    let mut parts = selector.splitn(2, "::");
    let css = parts.next().unwrap_or("body");
    let attr = parts.next();
    let Ok(sel) = Selector::parse(css) else {
        return Value::Null;
    };
    let selected = node.select(&sel).collect::<Vec<_>>();
    if selected.is_empty() {
        return Value::Null;
    }
    if key == "links" && attr == Some("href") {
        return Value::Array(
            selected
                .into_iter()
                .filter_map(|el| {
                    let href = el.value().attr("href")?;
                    if href.starts_with("?")
                        || href.starts_with("#")
                        || href.starts_with("javascript:")
                    {
                        return None;
                    }
                    Some(Value::String(href.to_owned()))
                })
                .collect(),
        );
    }
    let element = selected[0];
    if selector == ".tgme_widget_message_text" {
        let text = html_text_with_breaks(element);
        let (name, description) = telegram_parts(&text);
        return match key {
            "name" => Value::String(name),
            "description" => Value::String(description),
            _ => Value::String(text.trim().to_owned()),
        };
    }
    attr.map(|name| {
        element
            .value()
            .attr(name)
            .map(|v| Value::String(v.to_owned()))
            .unwrap_or(Value::Null)
    })
    .unwrap_or_else(|| {
        Value::String(
            element
                .text()
                .collect::<Vec<_>>()
                .join(" ")
                .trim()
                .to_owned(),
        )
    })
}

fn html_text_with_breaks(element: scraper::ElementRef<'_>) -> String {
    fn walk(element: scraper::ElementRef<'_>, out: &mut String) {
        for child in element.children() {
            match child.value() {
                Node::Text(text) => out.push_str(text),
                Node::Element(tag) if tag.name() == "br" => out.push('\n'),
                Node::Element(tag) if tag.name() == "a" => {
                    if tag
                        .attr("href")
                        .is_some_and(|u| crate::telegram::channel(u).is_some())
                    {
                        continue;
                    }
                    if let Some(url) = tag.attr("href")
                        && crate::resource_clean::cloud_type(url).is_some()
                    {
                        out.push(' ');
                        out.push_str(url);
                        out.push(' ');
                    } else if let Some(child) = scraper::ElementRef::wrap(child) {
                        walk(child, out);
                    }
                }
                Node::Element(_) => {
                    if let Some(child) = scraper::ElementRef::wrap(child) {
                        walk(child, out);
                    }
                }
                _ => {}
            }
        }
    }
    let mut out = String::new();
    walk(element, &mut out);
    out
}

fn telegram_parts(text: &str) -> (String, String) {
    fn strip_decoration(s: &str) -> &str {
        s.trim_start_matches(|c: char| {
            c.is_whitespace()
                || matches!(c, '|' | '｜' | '·')
                || ('\u{2600}'..='\u{27ff}').contains(&c)
                || ('\u{2b00}'..='\u{2bff}').contains(&c)
                || ('\u{1f000}'..='\u{1faff}').contains(&c)
                || matches!(c, '\u{fe0f}' | '\u{200d}')
        })
    }
    fn metadata(line: &str) -> bool {
        line.starts_with('#')
            || [
                "标签",
                "大小",
                "via ",
                "频道",
                "来源",
                "来自",
                "关注",
                "广告",
                "版权",
                "群组",
                "投稿",
                "评论区",
                "【评论区",
                "网盘专搜",
                "社工导航",
                "提取码",
                "密码",
                "访问码",
                "分享：",
                "分享:",
                "此频道",
            ]
            .iter()
            .any(|p| line.starts_with(p))
    }
    fn title(line: &str) -> bool {
        ["名称", "资源名称", "资源标题", "剧集名称", "标题"]
            .iter()
            .any(|p| {
                line.strip_prefix(p)
                    .is_some_and(|v| v.starts_with(':') || v.starts_with('：'))
            })
    }
    let text = text
        .replace(" 描述：", "\n描述：")
        .replace(" 简介：", "\n简介：")
        .replace(" 描述:", "\n描述:");
    let lines = text
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .map(strip_decoration)
        .collect::<Vec<_>>();
    let name_index = lines.iter().position(|l| title(l)).or_else(|| {
        lines
            .iter()
            .position(|l| !metadata(l) && !crate::resource_clean::clean_field(l).is_empty())
    });
    let Some(name_index) = name_index else {
        return (String::new(), String::new());
    };
    let name = crate::resource_clean::clean_field(lines[name_index]);
    let mut description = Vec::new();
    for line in lines.iter().skip(name_index + 1) {
        if metadata(line) {
            continue;
        }
        let line = ["介绍", "描述", "简介"]
            .iter()
            .find_map(|p| {
                line.strip_prefix(p)
                    .filter(|tail| tail.is_empty() || tail.starts_with([' ', ':', '：']))
                    .map(|tail| tail.trim_start_matches([' ', ':', '：']))
            })
            .unwrap_or(line);
        let clean = crate::resource_clean::clean_field(line);
        // URL rows may leave only separators or emoji after removal.
        let clean = strip_decoration(&clean).trim_matches([' ', '|', '｜']);
        if clean.chars().any(|c| c.is_alphanumeric()) && clean != name {
            description.push(clean.to_owned());
        }
    }
    (name, description.join("\n"))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn cleans_html_markup_and_entities_from_json_text_fields() {
        let raw = r#"{"data":[{"id":"1","title":"<b>demo</b>","description":"<p>简介&nbsp;内容 &amp; 更多</p>","links":[{"url":"https://pan.baidu.com/s/abc"}],"tags":["<em>tag</em>"]}]}"#;
        let spec = r#"{"kind":"json","items":"$.data[*]","fields":{"id":"id","name":"title","description":"description","links":"links","tags":"tags"}}"#;
        let result = apply(spec, raw, "json", "demo", "test").unwrap();
        assert_eq!(result[0].name, "demo");
        assert_eq!(result[0].description.as_deref(), Some("简介 内容 & 更多"));
        assert_eq!(
            result[0].tags.as_deref(),
            Some(["tag".to_owned()].as_slice())
        );
    }
    #[test]
    fn removes_internal_plugin_tags_from_public_results() {
        let raw = r#"{"data":[{"id":"1","title":"demo","links":[{"url":"https://pan.baidu.com/s/abc"}],"tags":["plugin:wanou","电影"]}]}"#;
        let spec = r#"{"kind":"json","items":"$.data[*]","fields":{"id":"id","name":"title","links":"links","tags":"tags"}}"#;
        let result = apply(spec, raw, "json", "demo", "wanou").unwrap();
        assert_eq!(
            result[0].tags.as_deref(),
            Some(["电影".to_owned()].as_slice())
        );
    }
    #[test]
    fn parses_native_json_transform() {
        let raw = r#"{"data":[{"id":"1","title":"demo","links":[{"url":"https://pan.baidu.com/s/abc"}]}]}"#;
        let spec = r#"{"kind":"json","items":"$.data[*]","fields":{"id":"id","name":"title","links":"links"}}"#;
        let result = apply(spec, raw, "json", "demo", "test").unwrap();
        assert_eq!(result[0].name, "demo");
        assert_eq!(result[0].cloud_types, vec!["baidu"]);
    }
    #[test]
    fn parses_native_html_transform() {
        let raw = r#"<article><h2>demo</h2><a class='share' href='https://pan.quark.cn/s/abc'>link</a></article>"#;
        let spec = r#"{"kind":"html","item_selector":"article","fields":{"name":"h2","links":"a.share::href"}}"#;
        let result = apply(spec, raw, "html", "demo", "test").unwrap();
        assert_eq!(result[0].links[0].r#type, "quark");
    }

    #[test]
    fn parses_xiaokupan_tson_payload() {
        let raw = serde_json::json!({
            "t": 10,
            "p": {"k": ["result"], "v": [{
                "t": 10,
                "p": {"k": ["searchResults"], "v": [{
                    "t": 10,
                    "p": {"k": ["merged_by_type"], "v": [{
                        "t": 10,
                        "p": {"k": ["115"], "v": [{
                            "t": 9,
                            "a": [{
                                "t": 10,
                                "p": {"k": ["url", "password", "note", "datetime"], "v": [
                                    {"t": 1, "s": "https://115cdn.com/s/demo"},
                                    {"t": 1, "s": "abcd"},
                                    {"t": 1, "s": "demo"},
                                    {"t": 1, "s": "2026-09-28T00:00:00Z"}
                                ]}
                            }]
                        }]}
                    }]}
                }]}
            }]}
        })
        .to_string();
        let spec = r#"{"kind":"json","items":"$.result.searchResults.merged_by_type.*[*]","fields":{"id":"$.url","name":"$.note","description":"$.note","datetime":"$.datetime","links":"$"}}"#;
        let result = apply(spec, &raw, "json", "demo", "xiaokupan").unwrap();
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].links[0].r#type, "115");
        assert_eq!(result[0].links[0].password.as_deref(), Some("abcd"));
        assert_eq!(result[0].description, None);
        assert_eq!(result[0].datetime.as_deref(), Some("2026-09-28 08:00:00"));
    }

    #[test]
    fn parses_wanou_vod_payload_without_mixing_fields() {
        let raw = r#"{"list":[{"vod_id":42,"vod_name":"测试影片","vod_content":"单独的影片简介","vod_time":"2026-09-29 09:30:00","vod_down_url":"夸克$https://pan.quark.cn/s/demo$$$百度$https://pan.baidu.com/s/demo","vod_tag":"电影","vod_pic":"https://img.example/demo.jpg"}]}"#;
        let spec = r#"{"kind":"json","items":"$.list[*]","fields":{"id":"$.vod_id","name":"$.vod_name","description":"$.vod_content","datetime":"$.vod_time","links":"$.vod_down_url","tags":"$.vod_tag","images":"$.vod_pic"}}"#;
        let result = apply(spec, raw, "json", "测试", "wanou").unwrap();
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].name, "测试影片");
        assert_eq!(result[0].description.as_deref(), Some("单独的影片简介"));
        assert_eq!(result[0].datetime.as_deref(), Some("2026-09-29 09:30:00"));
        assert_eq!(result[0].links.len(), 2);
        assert!(result[0].cloud_types.contains(&"quark".to_owned()));
        assert!(result[0].cloud_types.contains(&"baidu".to_owned()));
    }
    #[test]
    fn parses_pansearch_next_data() {
        let raw = r#"<html><script id="__NEXT_DATA__" type="application/json">{"props":{"pageProps":{"data":{"data":[{"id":1,"content":"名称：demo\n\n描述：desc\n\n链接：<a class=\"resource-link\" href=\"https://pan.quark.cn/s/demo\">link</a>","pan":"quark","image":"https://img.test/a.jpg","time":"2026-09-28T16:00:00+08:00"}]}}}}</script></html>"#;
        let spec = r#"{"kind":"html","item_selector":"body","fields":{"name":"body","links":"a.resource-link::href"}}"#;
        let result = apply(spec, raw, "html", "demo", "pansearch").unwrap();
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].links[0].r#type, "quark");
        assert_eq!(result[0].datetime.as_deref(), Some("2026-09-28 16:00:00"));
    }

    #[test]
    fn telegram_tag_heading_and_footer_do_not_become_title_or_description() {
        let raw = r#"<div class="tgme_widget_message"><div class="tgme_widget_message_text">#电影 #剧情<br/>🗄 片名 (2026)<br/>📜介绍 正常简介<br/>💾 https://pan.quark.cn/s/abc | 💾 https://pan.baidu.com/s/abc<br/>百度网盘：https://pan.baidu.com/s/abc<br/>光鸭云盘：https://www.guangyapan.com/s/abc<br/>UC 网盘：https://drive.uc.cn/s/abc<br/>来自：搜集频道<br/>⚠️ 版权：<a href="https://t.me/feedback/1">版权反馈</a><br/>📢 <a href="https://t.me/channel">频道</a> 👥 <a href="https://t.me/group">群组</a> 🔍<br/>⬇️【评论区可搜索】 | 🔍网盘专搜</div></div>"#;
        let spec = r#"{"kind":"html","item_selector":".tgme_widget_message","fields":{"name":".tgme_widget_message_text","links":".tgme_widget_message_text a::href"}}"#;
        let results = apply(spec, raw, "html", "", "demo").unwrap();
        assert_eq!(results[0].name, "片名 (2026)");
        assert_eq!(results[0].description.as_deref(), Some("正常简介"));
        assert_eq!(results[0].links.len(), 4);
        assert_eq!(results[0].links[2].r#type, "guangya");
        assert_eq!(
            results[0].tags.as_ref().unwrap(),
            &vec!["电影".to_owned(), "剧情".to_owned()]
        );
    }
    #[test]
    fn telegram_multiple_explicit_resources_have_independent_passwords() {
        let raw = r#"<div class="tgme_widget_message"><div class="tgme_widget_message_text">名称：甲<br/>描述：甲简介<br/>https://pan.quark.cn/s/a 密码：AB12<br/>名称：乙<br/>描述：乙简介<br/>https://pan.baidu.com/s/b 密码：CD34</div></div>"#;
        let spec = r#"{"kind":"html","item_selector":".tgme_widget_message","fields":{"name":".tgme_widget_message_text","links":".tgme_widget_message_text a::href"}}"#;
        let r = apply(spec, raw, "html", "", "demo").unwrap();
        assert_eq!(r.len(), 2);
        assert_eq!(r[0].name, "甲");
        assert_eq!(r[1].name, "乙");
        assert_eq!(r[0].links[0].password.as_deref(), Some("AB12"));
        assert_eq!(r[1].links[0].password.as_deref(), Some("CD34"));
    }
    #[test]
    fn splits_telegram_name_description_and_links() {
        let raw = r#"<div class="tgme_widget_message"><div class="tgme_widget_message_text">名称：demo (2026)<br/>描述：long description<br/>移动：<a href="https://yun.139.com/shareweb/#/w/i/demo">mobile</a><br/>标签：#demo<br/><a href="https://t.me/channel/1">post</a></div><time datetime="2026-09-28T15:41:57+00:00"></time></div>"#;
        let spec = r#"{"kind":"html","item_selector":".tgme_widget_message","fields":{"name":".tgme_widget_message_text","description":".tgme_widget_message_text","datetime":"time::datetime","links":".tgme_widget_message_text a::href"}}"#;
        let result = apply(spec, raw, "html", "demo", "telegram").unwrap();
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].name, "demo (2026)");
        assert_eq!(result[0].description.as_deref(), Some("long description"));
        assert_eq!(result[0].links.len(), 1);
        assert_eq!(result[0].links[0].r#type, "mobile");
    }
}
