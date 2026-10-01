use crate::error::ApiError;
use chrono::{DateTime, Utc};
use scraper::{Html, Selector};
use url::Url;

pub const PARSER_VERSION: &str = "tg-native-5";

pub fn normalize_channel(raw: &str) -> Option<String> {
    let raw = raw.trim().trim_start_matches('@');
    let url = if raw.starts_with("https://") {
        raw.to_owned()
    } else if raw.starts_with("t.me/") || raw.starts_with("telegram.me/") {
        format!("https://{raw}")
    } else {
        format!("https://t.me/s/{raw}")
    };
    channel(&url)
}

pub fn channel(url: &str) -> Option<String> {
    let url = Url::parse(url).ok()?;
    if url.scheme() != "https" || !matches!(url.host_str()?, "t.me" | "telegram.me") {
        return None;
    }
    let mut parts = url.path_segments()?.filter(|s| !s.is_empty());
    let first = parts.next()?;
    let name = if first == "s" { parts.next()? } else { first };
    if name.len() < 3
        || name.len() > 64
        || !name.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'_')
        || matches!(name, "c" | "joinchat" | "share" | "addstickers")
    {
        return None;
    }
    Some(name.to_ascii_lowercase())
}

// Explicit title boundaries only. Ambiguous aggregate posts are isolated by the worker.
pub fn segments(text: &str) -> Vec<String> {
    let starts_title = |line: &str| {
        ["名称", "资源名称", "资源标题", "剧集名称", "标题"]
            .iter()
            .any(|p| {
                line.trim()
                    .trim_start_matches(['🗄', '📺', '🎬', ' '])
                    .strip_prefix(p)
                    .is_some_and(|s| s.starts_with(':') || s.starts_with('：'))
            })
    };
    let mut out = Vec::new();
    let mut current = String::new();
    for line in text.lines() {
        if starts_title(line) && !current.trim().is_empty() {
            out.push(current);
            current = String::new();
        }
        current.push_str(line);
        current.push('\n');
    }
    if !current.trim().is_empty() {
        out.push(current);
    }
    out
}

#[derive(Debug)]
pub struct Message {
    pub id: i64,
    pub html: String,
    pub published: Option<DateTime<Utc>>,
}
pub fn messages(raw: &str, expected: &str) -> Result<Vec<Message>, ApiError> {
    let doc = Html::parse_document(raw);
    let sel = Selector::parse(".tgme_widget_message[data-post]").unwrap();
    let time = Selector::parse("time[datetime]").unwrap();
    let mut out = Vec::new();
    for node in doc.select(&sel).take(500) {
        let Some((channel, id)) = node
            .value()
            .attr("data-post")
            .and_then(|s| s.rsplit_once('/'))
        else {
            continue;
        };
        if !channel.eq_ignore_ascii_case(expected) {
            continue;
        }
        let Ok(id) = id.parse::<i64>() else {
            continue;
        };
        if id <= 0 {
            continue;
        }
        let published = node
            .select(&time)
            .next()
            .and_then(|n| n.value().attr("datetime"))
            .and_then(|s| DateTime::parse_from_rfc3339(s).ok())
            .map(|t| t.with_timezone(&Utc))
            .filter(|t| t.timestamp() >= 0);
        out.push(Message {
            id,
            html: node.html(),
            published,
        });
    }
    out.sort_by_key(|m| m.id);
    out.dedup_by_key(|m| m.id);
    if out.is_empty() {
        return Err(ApiError::Upstream(
            "页面没有可识别的频道消息，可能访问受限或频道不公开；不将其当作历史采集完成".into(),
        ));
    }
    Ok(out)
}

pub fn previous_cursor(raw: &str, expected: &str, current: Option<i64>) -> Option<i64> {
    let doc = Html::parse_document(raw);
    let sel =
        Selector::parse("a.tme_messages_more[href], a.tme_messages_more[data-before]").unwrap();
    doc.select(&sel)
        .filter_map(|n| {
            let value = if let Some(v) = n.value().attr("data-before") {
                v.parse().ok()
            } else {
                let href = n.value().attr("href")?;
                let url = Url::parse("https://t.me").ok()?.join(href).ok()?;
                if channel(url.as_str()).as_deref() != Some(expected) {
                    return None;
                }
                url.query_pairs()
                    .find(|(k, _)| k == "before")
                    .and_then(|(_, v)| v.parse().ok())
            };
            value.filter(|v| *v > 0 && current.is_none_or(|c| *v < c))
        })
        .min()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn channel_validation() {
        assert_eq!(
            channel("https://t.me/s/Test_channel?q=x"),
            Some("test_channel".into())
        );
        assert_eq!(channel("https://t.me.evil.com/s/demo"), None);
        assert_eq!(channel("https://t.me/+private"), None);
    }
    #[test]
    fn title_sections_split() {
        assert_eq!(
            segments("名称：甲\nhttps://pan.quark.cn/s/a\n名称：乙\nhttps://pan.quark.cn/s/b")
                .len(),
            2
        );
    }
    #[test]
    fn parse_page_identity_and_cursor() {
        let html = r#"<a class="tme_messages_more" href="/s/demo?before=10"></a><div class="tgme_widget_message" data-post="demo/12"><time datetime="2026-09-29T01:00:00Z"></time></div>"#;
        assert_eq!(messages(html, "demo").unwrap()[0].id, 12);
        assert_eq!(previous_cursor(html, "demo", None), Some(10));
    }
}
