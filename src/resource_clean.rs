use crate::models::{Link, SearchResult};
use regex::Regex;
use scraper::{Html, Selector};
use std::{collections::BTreeSet, sync::LazyLock};
use url::Url;

static URLS: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"(?i)(?:https?://|magnet:\?)[^\s<>\"'，。；]+"#).unwrap());
static URL_CODE_APPENDIX: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?i)(?:提取码|密码|访问码|%E6%8F%90%E5%8F%96%E7%A0%81|%E5%AF%86%E7%A0%81|%E8%AE%BF%E9%97%AE%E7%A0%81)\s*(?::|：|%3A|%EF%BC%9A)?\s*([a-zA-Z0-9]{4,8})?"#).unwrap()
});
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

/// 剥掉分享链接尾部粘连的半个括号/问号等胶水字符（含百分号编码形态）。
pub(crate) fn trim_url_glue(head: &str) -> &str {
    let mut head = head;
    loop {
        let mut current =
            head.trim_end_matches(['（', '(', '?', '&', '#', '：', ':', '*', '`', ' ']);
        for encoded in ["%EF%BC%88", "%EF%BC%89", "%28", "%29", "%3F"] {
            if let Some(start) = current.len().checked_sub(encoded.len())
                && current
                    .get(start..)
                    .is_some_and(|tail| tail.eq_ignore_ascii_case(encoded))
            {
                current = &current[..start];
            }
            current =
                current.trim_end_matches(['（', '(', '?', '&', '#', '：', ':', '*', '`', ' ']);
        }
        if current.len() == head.len() {
            return head;
        }
        head = current;
    }
}

/// Split a trailing extraction-code appendix off a share URL. Channels paste
/// the code glued to the link ("…aKQ提取码：z2m1"), often percent-encoded once
/// stored ("…aKQ%E6%8F%90%E5%8F%96%E7%A0%81%EF%BC%9Az2m1"), or inside a query
/// value ("?pwd=mckj（提取码：mckj）"); the extractor must not keep it as part
/// of the URL path or query. Returns the cleaned URL and the trailing code.
pub fn split_url_password(raw: &str) -> (String, Option<String>) {
    // 磁力链接的 dn 参数可以含中文，不能按网盘分享正文截断。
    if raw.trim().starts_with("magnet:?") {
        return (raw.trim().to_owned(), None);
    }
    // Drop trailing junk first ("#"-only fragments, unclosed BBCode like
    // "[/float") so the appendix regex can anchor at the real end.
    let mut trimmed = raw.trim();
    loop {
        let before = trimmed;
        trimmed = trimmed.trim_end_matches(['#', ' ', '\t']);
        if let Some(open) = trimmed.rfind("[/") {
            let tail = &trimmed[open..];
            if tail.len() <= 12
                && tail[2..]
                    .bytes()
                    .all(|b| b.is_ascii_alphabetic() || b == b']')
            {
                trimmed = &trimmed[..open];
            }
        }
        if trimmed.len() == before.len() {
            break;
        }
    }
    let Some(caps) = URL_CODE_APPENDIX.captures(trimmed) else {
        return (cut_non_ascii(trimmed).to_owned(), None);
    };
    // 首次出现即截断：提取码标签之后的全部内容（含紧贴的正文）都不属于链接。
    let mut code = caps.get(1).map(|m| m.as_str().to_owned());
    if let Some(code_match) = caps.get(1)
        && trimmed[code_match.end()..]
            .bytes()
            .next()
            .is_some_and(|b| b.is_ascii_alphanumeric())
        && code.as_deref().is_some_and(|c| c.len() > 4)
    {
        // 码后面还紧贴着更多字母数字，说明粘了正文；主流提取码为 4 位。
        code = Some(code.unwrap()[..4].to_owned());
    }
    (
        trim_url_glue(&cut_non_ascii(&trimmed[..caps.get(0).unwrap().start()])).to_owned(),
        code,
    )
}

/// The same cleanup is used for extracted, structured and persisted share links.
pub(crate) fn normalize_link(mut link: Link) -> Link {
    let (url, tail_code) = split_url_password(&link.url);
    link.url = url.trim().trim_end_matches(['*', '`']).to_owned();
    if let Some(kind) = cloud_type(&link.url) {
        link.r#type = kind.into();
    }
    link.password = link.password.as_deref().and_then(|password| {
        let (value, code) = split_url_password(password);
        let value = trim_url_glue(&value);
        (!value.is_empty()).then(|| value.to_owned()).or(code)
    });
    if link.password.is_none() {
        link.password = Url::parse(&link.url)
            .ok()
            .and_then(|url| {
                url.query_pairs()
                    .find(|(key, value)| {
                        !value.is_empty()
                            && matches!(
                                key.as_ref(),
                                "pwd"
                                    | "password"
                                    | "passcode"
                                    | "code"
                                    | "accessCode"
                                    | "passCode"
                            )
                    })
                    .map(|(_, value)| value.into_owned())
            })
            .or(tail_code);
    }
    link
}

/// 分享链接本身必为 ASCII；频道消息常把正文直接粘在链接后，从首个非 ASCII
/// 字符处截断（百分号编码保持不变，磁力链接的中文 dn 参数由调用方另行处理）。
fn cut_non_ascii(head: &str) -> &str {
    head.char_indices()
        .find(|(_, c)| !c.is_ascii())
        .map_or(head, |(i, _)| &head[..i])
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
        let (url, tail_code) = split_url_password(&url);
        let url = url.trim().trim_end_matches(['*', '`']).to_owned();
        let Some(kind) = cloud_type(&url) else {
            continue;
        };
        let mut password = Url::parse(&url).ok().and_then(|u| {
            u.query_pairs()
                .find(|(k, _)| matches!(k.as_ref(), "pwd" | "password"))
                .map(|(_, v)| {
                    // A glued appendix can also sit inside the query value
                    // itself ("?pwd=mckj（提取码：mckj）").
                    let (value, code) = split_url_password(&v);
                    if code.is_some() {
                        value
                    } else {
                        v.into_owned()
                    }
                })
        });
        if password.is_none() {
            // Bind a password only inside the same line after this share, before the next URL.
            let lines = raw
                .replace("<br>", "\n")
                .replace("<br/>", "\n")
                .replace("<br />", "\n");
            for line in lines.lines() {
                let line = text(line);
                if let Some(pos) = line.find(url.as_str()) {
                    let tail = &line[pos + url.len()..];
                    let tail = URLS.find(tail).map(|m| &tail[..m.start()]).unwrap_or(tail);
                    password = PASSWORD.captures(tail).map(|c| c[1].to_owned());
                    break;
                }
            }
        }
        if password.is_none() {
            password = tail_code;
        }
        let normalized = normalize_link(Link {
            r#type: kind.into(),
            url,
            password,
        });
        let identity = link_identity(&normalized.url);
        if let Some(existing) = out
            .iter_mut()
            .find(|l: &&mut Link| link_identity(&l.url) == identity)
        {
            if existing.password.is_none() {
                existing.password = normalized.password;
            }
        } else {
            out.push(normalized);
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
        *link = normalize_link(link.clone());
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
    fn glued_extraction_code_suffixes_are_split_off_urls() {
        for (raw, url, code) in [
            (
                "https://pan.baidu.com/s/1jzgJOGnGzpl0CoitZm_aKQ提取码：z2m1",
                "https://pan.baidu.com/s/1jzgJOGnGzpl0CoitZm_aKQ",
                Some("z2m1"),
            ),
            (
                "https://pan.baidu.com/s/1jzgJOGnGzpl0CoitZm_aKQ%E6%8F%90%E5%8F%96%E7%A0%81%EF%BC%9Az2m1",
                "https://pan.baidu.com/s/1jzgJOGnGzpl0CoitZm_aKQ",
                Some("z2m1"),
            ),
            (
                "https://www.123684.com/s/kyeA-s2trv%E6%8F%90%E5%8F%96%E7%A0%81:ZY4K",
                "https://www.123684.com/s/kyeA-s2trv",
                Some("ZY4K"),
            ),
            (
                "https://www.123684.com/s/IpPUVv-0pDj?%E6%8F%90%E5%8F%96%E7%A0%81:JZMM",
                "https://www.123684.com/s/IpPUVv-0pDj",
                Some("JZMM"),
            ),
            (
                "https://pan.baidu.com/s/1VzJ_PMnZYN_7BrIwRSCjrg?pwd=mckj（提取码：mckj）",
                "https://pan.baidu.com/s/1VzJ_PMnZYN_7BrIwRSCjrg?pwd=mckj",
                Some("mckj"),
            ),
            (
                "https://pan.baidu.com/s/1abc提取码：",
                "https://pan.baidu.com/s/1abc",
                None,
            ),
            (
                "https://www.123865.com/s/oec7Vv-pLwWh%E6%8F%90%E5%8F%96%E7%A0%81%EF%BC%9AZY4K#",
                "https://www.123865.com/s/oec7Vv-pLwWh",
                Some("ZY4K"),
            ),
            (
                "https://www.123pan.com/s/HQ7rVv-j8EWA.html提取码:HoTW[/float",
                "https://www.123pan.com/s/HQ7rVv-j8EWA.html",
                Some("HoTW"),
            ),
            (
                "https://www.123pan.com/s/HQ7rVv-q8EWA.html%E6%8F%90%E5%8F%96%E7%A0%81:UP5D%E5%86%A0%E5%86%9B%E7%9A%84%E5%89%A7%E6%83%85%E7%AE%80%E4%BB%8B",
                "https://www.123pan.com/s/HQ7rVv-q8EWA.html",
                Some("UP5D"),
            ),
            (
                "https://www.123pan.com/s/HQ7rVv-c8EWA.html%E6%8F%90%E5%8F%96%E7%A0%81:R21frective",
                "https://www.123pan.com/s/HQ7rVv-c8EWA.html",
                Some("R21f"),
            ),
        ] {
            let (cleaned, tail) = split_url_password(raw);
            assert_eq!(cleaned, url, "{raw}");
            assert_eq!(tail.as_deref(), code, "{raw}");
        }
        let (cleaned, tail) = split_url_password("https://pan.baidu.com/s/1abc?pwd=ab12");
        assert_eq!(cleaned, "https://pan.baidu.com/s/1abc?pwd=ab12");
        assert_eq!(tail, None);
    }
    #[test]
    fn extraction_binds_the_glued_code_without_keeping_it_in_the_url() {
        let links = extract_links("https://pan.baidu.com/s/1jzgJOGnGzpl0CoitZm_aKQ提取码：z2m1");
        assert_eq!(
            links[0].url,
            "https://pan.baidu.com/s/1jzgJOGnGzpl0CoitZm_aKQ"
        );
        assert_eq!(links[0].password.as_deref(), Some("z2m1"));
        let links = extract_links(
            "https://pan.baidu.com/s/1VzJ_PMnZYN_7BrIwRSCjrg?pwd=mckj（提取码：mckj）",
        );
        assert_eq!(
            links[0].url,
            "https://pan.baidu.com/s/1VzJ_PMnZYN_7BrIwRSCjrg?pwd=mckj"
        );
        assert_eq!(links[0].password.as_deref(), Some("mckj"));
        let encoded =
            extract_links("https://www.123684.com/s/kyeA-s2trv%E6%8F%90%E5%8F%96%E7%A0%81:ZY4K");
        assert_eq!(encoded[0].url, "https://www.123684.com/s/kyeA-s2trv");
        assert_eq!(encoded[0].password.as_deref(), Some("ZY4K"));
    }
    #[test]
    fn all_drive_suffixes_and_stored_codes_use_the_same_cleanup() {
        for (raw, stored, expected_url, expected_code) in [
            (
                "https://115cdn.com/s/abc?password=yd45&#%E8%AE%BF%E9%97%AE%E7%A0%81%EF%BC%9Ayd45",
                Some("yd45"),
                "https://115cdn.com/s/abc?password=yd45",
                "yd45",
            ),
            (
                "https://pan.xunlei.com/s/abc#%ef%bc%88%e6%8f%90%e5%8f%96%e7%a0%81%ef%bc%9adexg",
                None,
                "https://pan.xunlei.com/s/abc",
                "dexg",
            ),
            (
                "https://cloud.189.cn/t/abc%E8%AE%BF%E9%97%AE%E7%A0%81%EF%BC%9Aw0aa",
                Some(""),
                "https://cloud.189.cn/t/abc",
                "w0aa",
            ),
            (
                "https://www.123684.com/s/abc?%E6%8F%90%E5%8F%96%E7%A0%81:JZMM",
                None,
                "https://www.123684.com/s/abc",
                "JZMM",
            ),
            (
                "https://pan.baidu.com/s/1abc?pwd=mckj%EF%BC%88%E6%8F%90%E5%8F%96%E7%A0%81%EF%BC%9Amckj%EF%BC%89",
                Some("mckj（提取码：mckj）"),
                "https://pan.baidu.com/s/1abc?pwd=mckj",
                "mckj",
            ),
            (
                "https://pan.quark.cn/s/abc?passcode=AB12#/list/share",
                None,
                "https://pan.quark.cn/s/abc?passcode=AB12#/list/share",
                "AB12",
            ),
            (
                "https://www.alipan.com/s/abc",
                Some("提取码：AB12"),
                "https://www.alipan.com/s/abc",
                "AB12",
            ),
        ] {
            let link = normalize_link(Link {
                r#type: "others".into(),
                url: raw.into(),
                password: stored.map(str::to_owned),
            });
            assert_eq!(link.url, expected_url);
            assert_eq!(link.password.as_deref(), Some(expected_code));
            assert_eq!(normalize_link(link.clone()).url, link.url);
            assert_eq!(normalize_link(link.clone()).password, link.password);
        }
    }
    #[test]
    fn chinese_magnet_names_and_mobile_routes_remain_intact() {
        for raw in [
            "magnet:?xt=urn:btih:abc&dn=中文片名",
            "https://yun.139.com/shareweb/#/w/i/abc",
        ] {
            let (url, code) = split_url_password(raw);
            assert_eq!(url, raw);
            assert_eq!(code, None);
        }
    }
    #[test]
    fn duplicate_share_without_code_can_gain_its_glued_code() {
        let links =
            extract_links("https://pan.xunlei.com/s/abc https://pan.xunlei.com/s/abc提取码：AB12");
        assert_eq!(links.len(), 1);
        assert_eq!(links[0].password.as_deref(), Some("AB12"));
    }
    #[test]
    fn grams_cover_short_chinese() {
        assert!(grams("兰香如故").contains(&"兰香".into()));
    }
}
