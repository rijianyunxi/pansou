use super::*;
#[test]
fn cleans_html_markup_and_entities_from_json_text_fields() {
    let raw = r#"{"data":[{"id":"1","title":"<b>demo</b>","description":"<p>简介&nbsp;内容 &amp; 更多</p>","links":[{"url":"https://pan.baidu.com/s/abc"}],"tags":["<em>tag</em>"]}]}"#;
    let spec = r#"{"kind":"json","items":"$.data[*]","fields":{"id":"id","name":"title","description":"description","links":"links","tags":"tags"}}"#;
    let result = apply(spec, raw, "json", "demo", "test").unwrap();
    assert_eq!(result[0].name, "demo");
    assert_eq!(result[0].description.as_deref(), Some("简介 内容 & 更多"));
    assert!(
        serde_json::to_value(&result[0])
            .unwrap()
            .get("tags")
            .is_none()
    );
}
#[test]
fn discards_all_upstream_tags_from_parsed_resources() {
    let raw = r#"{"data":[{"id":"1","title":"demo","links":[{"url":"https://pan.baidu.com/s/abc"}],"tags":["plugin:wanou","电影"]}]}"#;
    let spec = r#"{"kind":"json","items":"$.data[*]","fields":{"id":"id","name":"title","links":"links","tags":"tags"}}"#;
    let result = apply(spec, raw, "json", "demo", "wanou").unwrap();
    assert!(
        serde_json::to_value(&result[0])
            .unwrap()
            .get("tags")
            .is_none()
    );
}
#[test]
fn parses_native_json_transform() {
    let raw =
        r#"{"data":[{"id":"1","title":"demo","links":[{"url":"https://pan.baidu.com/s/abc"}]}]}"#;
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
    let spec = r#"{"kind":"json","items":"$.list[*]","fields":{"id":"$.vod_id","name":"$.vod_name","description":"$.vod_content","datetime":"$.vod_time","links":"$.vod_down_url","images":"$.vod_pic"}}"#;
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
    assert!(
        serde_json::to_value(&results[0])
            .unwrap()
            .get("tags")
            .is_none()
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
