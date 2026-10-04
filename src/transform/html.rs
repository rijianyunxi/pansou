use super::*;

pub(super) fn apply_html(
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

pub(super) fn apply_pansearch_html(
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

pub(super) fn telegram_parts(text: &str) -> (String, String) {
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
