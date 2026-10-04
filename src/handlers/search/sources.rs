use crate::{app::AppState, error::ApiError, models::Source};

/// Local channels define visibility only; they have no search priority or per-source output.
pub(crate) struct SearchSources {
    pub(crate) local_channels: Vec<String>,
    pub(crate) live_sources: Vec<Source>,
}

pub(crate) async fn load_sources(
    state: &AppState,
    ids: Option<&Vec<String>>,
    channels: Option<&Vec<String>>,
) -> Result<SearchSources, ApiError> {
    if let Some(channels) = channels {
        let live_sources = channels
            .iter()
            .map(|value| {
                let channel = crate::telegram::normalize_channel(value)
                    .ok_or_else(|| ApiError::BadRequest("无效公开频道".into()))?;
                Ok(Source {
                    id: format!("custom:{channel}"),
                    name: format!("@{channel}"),
                    description: String::new(),
                    url: format!("https://t.me/s/{channel}"),
                    method: "GET".into(),
                    format: "html".into(),
                    priority: 0,
                    enabled: true,
                    request: None,
                    transform: crate::telegram::BUILTIN_TRANSFORM.to_owned(),
                })
            })
            .collect::<Result<Vec<_>, ApiError>>()?;
        return Ok(SearchSources {
            local_channels: vec![],
            live_sources,
        });
    }
    let filter = ids.map(Vec::as_slice);
    let rows = sqlx::query_as::<_, Source>(
        "SELECT id,name,description,url,method,format,priority,enabled,request_json AS request,transform FROM resource_sources WHERE enabled=true AND kind='live' AND ($1::text[] IS NULL OR id=ANY($1)) ORDER BY priority,id",
    ).bind(filter).fetch_all(&state.pool).await?;
    let local_channels =
        sqlx::query_scalar::<_, String>("SELECT id FROM crawl_channels ORDER BY id")
            .fetch_all(&state.pool)
            .await?;
    let mut live_sources = Vec::new();
    for source in rows {
        if crate::telegram::channel(&source.url).is_some() {
            continue;
        }
        live_sources.push(source);
    }
    Ok(SearchSources {
        local_channels,
        live_sources,
    })
}
