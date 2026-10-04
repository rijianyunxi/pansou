use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Link {
    pub r#type: String,
    pub url: String,
    pub password: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SearchResult {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    pub datetime: Option<String>,
    pub cloud_types: Vec<String>,
    pub links: Vec<Link>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub images: Option<Vec<String>>,
}
#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct Source {
    pub id: String,
    pub name: String,
    pub description: String,
    pub url: String,
    pub method: String,
    pub format: String,
    pub priority: i32,
    pub enabled: bool,
    pub request: Option<Value>,
    pub transform: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SearchRequest {
    pub kw: String,
    pub channels: Option<Vec<String>>,
    pub source_ids: Option<Vec<String>>,
    pub conc: Option<usize>,
}
#[derive(Debug, Clone, Serialize)]
pub struct SourceMeta {
    pub id: String,
    pub name: String,
    pub priority: i32,
    pub status: String,
    #[serde(rename = "resultCount")]
    pub result_count: usize,
    #[serde(rename = "elapsedMs")]
    pub elapsed_ms: u128,
    #[serde(rename = "transformMs")]
    pub transform_ms: Option<u128>,
    #[serde(rename = "proxyNodes")]
    pub proxy_nodes: Vec<Value>,
    /// Raw results emitted by an external live source; clients handle cross-source duplicates.
    pub results: Vec<SearchResult>,
}
#[derive(Debug, Clone, Serialize)]
pub struct SearchResponse {
    /// Number of returned records, including cross-source duplicates.
    pub total: usize,
    /// Flat local-first results. TG resources carry no per-source search metadata.
    pub results: Vec<SearchResult>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sources: Option<Vec<SourceMeta>>,
}
#[derive(Debug, Serialize)]
pub struct UserView {
    pub id: i64,
    pub username: String,
    pub nickname: Option<String>,
    pub role: String,
    pub status: String,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn search_response_contract_keeps_statistics_and_source_results() {
        let result = SearchResult {
            id: "result-1".into(),
            name: "demo".into(),
            description: Some("description".into()),
            datetime: Some("2026-09-29 12:00:00".into()),
            cloud_types: vec!["quark".into()],
            links: vec![Link {
                r#type: "quark".into(),
                url: "https://pan.quark.cn/s/demo".into(),
                password: None,
            }],
            images: None,
        };
        let value = serde_json::to_value(SearchResponse {
            total: 1,
            results: vec![result.clone()],
            sources: Some(vec![SourceMeta {
                id: "pansearch".into(),
                name: "PanSearch".into(),
                priority: 0,
                status: "success".into(),
                result_count: 1,
                elapsed_ms: 25,
                transform_ms: Some(3),
                proxy_nodes: vec![json!({"nodeId":"edge-1","status":"success"})],
                results: vec![result],
            }]),
        })
        .unwrap();
        assert_eq!(value["total"], 1);
        assert!(value["results"].is_array());
        assert!(value["results"][0].get("tags").is_none());
        assert_eq!(value["results"][0]["cloud_types"], json!(["quark"]));
        assert!(value["sources"][0]["results"][0].get("tags").is_none());
        let source = &value["sources"][0];
        for key in [
            "id",
            "name",
            "priority",
            "status",
            "resultCount",
            "elapsedMs",
            "transformMs",
            "proxyNodes",
            "results",
        ] {
            assert!(
                source.get(key).is_some(),
                "missing source contract field: {key}"
            );
        }
        assert_eq!(source["resultCount"], 1);
        assert_eq!(source["transformMs"], 3);
    }
}
