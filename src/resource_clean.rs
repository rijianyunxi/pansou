use crate::models::{Link, SearchResult};
use regex::Regex;
use scraper::{Html, Selector};
use std::{collections::BTreeSet, sync::LazyLock};
use url::Url;

static URLS: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"(?i)(?:https?://|magnet:\?)[^\s<>\"'，。；]+"#).unwrap());
static LABELS: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)(?:(?:夸克|百度|光鸭|阿里|移动|UC|迅雷|123|115|天翼)\s*(?:网盘|云盘)?|链接|下载|网盘|提取码|密码|访问码)\s*[:：]\s*(?:[a-z0-9]{4,8})?\s*$").unwrap()
});
static PREFIX: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^\s*(?:名称|资源名称|资源标题|剧集名称|标题|描述|简介|介绍)\s*[:：]\s*").unwrap()
});
static PASSWORD: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?:提取码|密码|访问码)\s*[:：]?\s*([a-zA-Z0-9]{4,8})").unwrap());

pub fn text(raw: &str) -> String {
    let html = Html::parse_fragment(raw);
    html.root_element()
        .descendants()
        .filter_map(|n| {
            if n.ancestors().any(|a| {
                a.value()
                    .as_element()
                    .is_some_and(|e| matches!(e.name(), "script" | "style"))
            }) {
                return None;
            }
            n.value().as_text().map(|t| t.to_string())
        })
        .collect::<Vec<_>>()
        .join(" ")
        .replace(['\u{200b}', '\u{feff}'], "")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

pub fn clean_field(raw: &str) -> String {
    let value = text(raw);
    let value = URLS.replace_all(&value, "");
    let value = PASSWORD.replace_all(&value, "");
    let value = LABELS.replace_all(&value, "");
    PREFIX
        .replace(&value, "")
        .trim_matches([' ', '|', '｜', ':', '：', '-', '·'])
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

pub fn cloud_type(raw: &str) -> Option<&'static str> {
    if raw.starts_with("magnet:?") {
        return Some("magnet");
    }
    let u = Url::parse(raw).ok()?;
    if !matches!(u.scheme(), "http" | "https") {
        return None;
    }
    let host = u.host_str()?.to_lowercase();
    let path = u.path();
    let exact = |h: &str| host == h || host.ends_with(&format!(".{h}"));
    if exact("yun.139.com")
        && (u
            .fragment()
            .is_some_and(|f| f.contains("/w/i/") || f.contains("/i/"))
            || path.contains("/share"))
    {
        return Some("mobile");
    }
    for (h, t) in [
        ("pan.baidu.com", "baidu"),
        ("pan.quark.cn", "quark"),
        ("guangyapan.com", "guangya"),
        ("alipan.com", "aliyun"),
        ("aliyundrive.com", "aliyun"),
        ("drive.uc.cn", "uc"),
        ("123pan.com", "123"),
        ("123pan.cn", "123"),
        ("123684.com", "123"),
        ("123865.com", "123"),
        ("pan.xunlei.com", "xunlei"),
        ("115.com", "115"),
        ("115cdn.com", "115"),
        ("cloud.189.cn", "tianyi"),
        ("jianguoyun.com", "jianguoyun"),
    ] {
        if exact(h)
            && (path.starts_with("/s/")
                || path.starts_with("/t/")
                || path.starts_with("/web/share")
                || path.starts_with("/share")
                || (t == "jianguoyun" && path.starts_with("/p/")))
        {
            return Some(t);
        }
    }
    // Lanzou uses multiple share hosts; match registered suffixes, not arbitrary substrings.
    if [
        "lanzou.com",
        "lanzoui.com",
        "lanzous.com",
        "lanzouq.com",
        "lanzouo.com",
        "lanzoux.com",
        "lanzoub.com",
        "lanzouj.com",
        "lanzout.com",
        "lanzouy.com",
    ]
    .iter()
    .any(|h| exact(h))
        && path.len() > 1
    {
        return Some("lanzou");
    }
    None
}

pub fn link_identity(raw: &str) -> String {
    let raw = raw.trim().trim_end_matches(['*', '`']);
    let Ok(mut u) = Url::parse(raw) else {
        return raw.trim().into();
    };
    let pairs = u
        .query_pairs()
        .filter(|(k, _)| {
            !matches!(
                k.as_ref(),
                "pwd" | "password" | "utm_source" | "utm_medium" | "utm_campaign"
            )
        })
        .map(|(k, v)| (k.into_owned(), v.into_owned()))
        .collect::<Vec<_>>();
    u.set_query(None);
    if !pairs.is_empty() {
        u.query_pairs_mut().extend_pairs(pairs);
    }
    if cloud_type(raw) != Some("mobile") {
        u.set_fragment(None);
    }
    let path = u.path().trim_end_matches('/').to_owned();
    if !path.is_empty() {
        u.set_path(&path);
    }
    u.to_string()
}

pub fn extract_links(raw: &str) -> Vec<Link> {
    let html = Html::parse_fragment(raw);
    let anchors = Selector::parse("a[href]").unwrap();
    let mut candidates = html
        .select(&anchors)
        .filter_map(|a| a.value().attr("href").map(str::to_owned))
        .collect::<Vec<_>>();
    let plain = text(raw);
    candidates.extend(URLS.find_iter(&plain).map(|m| {
        m.as_str()
            .trim_end_matches([')', ']', ';', '*', '`'])
            .to_owned()
    }));
    let mut out = Vec::new();
    for url in candidates {
        let url = url.trim().trim_end_matches(['*', '`']).to_owned();
        let Some(kind) = cloud_type(&url) else {
            continue;
        };
        let mut password = Url::parse(&url).ok().and_then(|u| {
            u.query_pairs()
                .find(|(k, _)| matches!(k.as_ref(), "pwd" | "password"))
                .map(|(_, v)| v.into_owned())
        });
        if password.is_none() {
            // Bind a password only inside the same line after this share, before the next URL.
            let lines = raw
                .replace("<br>", "\n")
                .replace("<br/>", "\n")
                .replace("<br />", "\n");
            for line in lines.lines() {
                let line = text(line);
                if let Some(pos) = line.find(&url) {
                    let tail = &line[pos + url.len()..];
                    let tail = URLS.find(tail).map(|m| &tail[..m.start()]).unwrap_or(tail);
                    password = PASSWORD.captures(tail).map(|c| c[1].to_owned());
                    break;
                }
            }
        }
        let identity = link_identity(&url);
        if let Some(existing) = out
            .iter_mut()
            .find(|l: &&mut Link| link_identity(&l.url) == identity)
        {
            if existing.password.is_none() {
                existing.password = password;
            }
        } else {
            out.push(Link {
                r#type: kind.into(),
                url,
                password,
            });
        }
    }
    out
}

pub fn normalize(mut result: SearchResult) -> SearchResult {
    result.name = clean_field(&result.name);
    result.description = result
        .description
        .map(|s| clean_field(&s))
        .filter(|s| !s.is_empty() && s != &result.name);
    for link in &mut result.links {
        link.url = link.url.trim().trim_end_matches(['*', '`']).to_owned();
        if let Some(kind) = cloud_type(&link.url) {
            link.r#type = kind.into();
        }
        if let Some(password) = &mut link.password {
            *password = password.trim().trim_end_matches(['*', '`']).to_owned();
        }
    }
    let mut seen = BTreeSet::new();
    result.links.retain(|l| seen.insert(link_identity(&l.url)));
    result.cloud_types = result
        .links
        .iter()
        .map(|l| l.r#type.clone())
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect();
    if result
        .datetime
        .as_deref()
        .is_some_and(|s| s.starts_with("0001-") || s.starts_with("0000-"))
    {
        result.datetime = None;
    }
    result
}

pub fn grams(value: &str) -> Vec<String> {
    let chars = value.to_lowercase().chars().collect::<Vec<_>>();
    let mut grams = BTreeSet::new();
    for c in &chars {
        if c.is_alphanumeric() {
            grams.insert(c.to_string());
        }
    }
    for pair in chars.windows(2) {
        if pair.iter().all(|c| c.is_alphanumeric()) {
            grams.insert(pair.iter().collect());
        }
    }
    grams.into_iter().collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn mobile_share_hash_is_identity() {
        assert_ne!(
            link_identity("https://yun.139.com/shareweb/#/w/i/a"),
            link_identity("https://yun.139.com/shareweb/#/w/i/b")
        );
    }
    #[test]
    fn rejects_navigation_and_fake_domains() {
        assert_eq!(cloud_type("https://pan.baidu.com.evil.com/s/x"), None);
        assert_eq!(cloud_type("https://t.me/test/1"), None);
    }
    #[test]
    fn clears_urls_without_losing_prose() {
        assert_eq!(
            clean_field("<p>简介：很好看的剧 https://pan.quark.cn/s/demo</p>"),
            "很好看的剧"
        );
    }
    #[test]
    fn markdown_share_formatting_is_not_part_of_url_or_password() {
        let links = extract_links("百度网盘：**https://pan.baidu.com/s/demo?pwd=AB12**");
        assert_eq!(links[0].url, "https://pan.baidu.com/s/demo?pwd=AB12");
        assert_eq!(links[0].password.as_deref(), Some("AB12"));
    }
    #[test]
    fn grams_cover_short_chinese() {
        assert!(grams("兰香如故").contains(&"兰香".into()));
    }
}
