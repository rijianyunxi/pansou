use serde_json::{Value, json};
use sqlx::{PgPool, Row};
/// Read-only report. Never applies migrations or prints credentials/DSL bodies.
pub async fn report(pool: &PgPool) -> anyhow::Result<Value> {
    let migrated=sqlx::query_scalar::<_,bool>("SELECT EXISTS(SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='outbound_policies')").fetch_one(pool).await?;
    if migrated {
        return Ok(json!({"migrated":true,"conflicts":[]}));
    }
    let mixed=sqlx::query("SELECT g.id,g.name,g.fallback_action FROM proxy_groups g WHERE EXISTS(SELECT 1 FROM proxy_group_nodes m JOIN proxy_nodes n ON n.id=m.node_id WHERE m.group_id=g.id AND n.base_url='') AND EXISTS(SELECT 1 FROM proxy_group_nodes m JOIN proxy_nodes n ON n.id=m.node_id WHERE m.group_id=g.id AND n.base_url<>'')").fetch_all(pool).await?;
    let dsl=sqlx::query_scalar::<_,String>("SELECT channel_id FROM resource_sources WHERE channel_id IS NOT NULL GROUP BY channel_id HAVING count(DISTINCT transform)>1").fetch_all(pool).await?;
    let ambiguous=sqlx::query_scalar::<_,String>("SELECT DISTINCT d.group_id FROM proxy_group_nodes d JOIN proxy_nodes dn ON dn.id=d.node_id JOIN proxy_group_nodes p ON p.group_id=d.group_id JOIN proxy_nodes pn ON pn.id=p.node_id WHERE dn.base_url='' AND pn.base_url<>'' AND (d.weight,d.node_id)>=(p.weight,p.node_id)").fetch_all(pool).await?;
    let policy_conflicts=sqlx::query_scalar::<_,String>("WITH e AS (SELECT s.channel_id,COALESCE(r.action,'direct') action,COALESCE(g.fallback_action,'direct') fallback,r.group_id FROM resource_sources s LEFT JOIN LATERAL(SELECT r.* FROM proxy_routes r WHERE r.enabled AND r.source_ids_json ? s.id ORDER BY r.priority,r.id LIMIT 1) r ON true LEFT JOIN proxy_groups g ON g.id=r.group_id WHERE s.channel_id IS NOT NULL), x AS (SELECT channel_id,action,fallback,COALESCE((SELECT jsonb_agg(jsonb_build_array(m.node_id,m.weight) ORDER BY m.weight DESC,m.node_id DESC) FROM proxy_group_nodes m WHERE m.group_id=e.group_id),'[]'::jsonb) nodes FROM e) SELECT channel_id FROM x GROUP BY channel_id HAVING count(DISTINCT jsonb_build_array(action,fallback,nodes))>1").fetch_all(pool).await?;
    let counts=sqlx::query("SELECT (SELECT count(*) FROM resource_sources) sources,(SELECT count(*) FROM crawl_channels) channels,(SELECT count(*) FROM source_messages) messages,(SELECT count(*) FROM managed_resources) resources,(SELECT count(*) FROM crawl_jobs WHERE status='running') running").fetch_one(pool).await?;
    Ok(
        json!({"migrated":false,"canMigrate":dsl.is_empty()&&ambiguous.is_empty()&&policy_conflicts.is_empty(),"ambiguousDirectGroups":ambiguous,"policyConflictChannels":policy_conflicts,"counts":{"sources":counts.get::<i64,_>("sources"),"channels":counts.get::<i64,_>("channels"),"messages":counts.get::<i64,_>("messages"),"resources":counts.get::<i64,_>("resources"),"running":counts.get::<i64,_>("running")},"mixedDirectGroups":mixed.iter().map(|r|json!({"id":r.get::<String,_>("id"),"name":r.get::<String,_>("name"),"fallback":r.get::<String,_>("fallback_action")})).collect::<Vec<_>>(),"dslConflictChannels":dsl,"note":"末位直连可精确拆成无可用节点回退；直连优先于其他代理或不同DSL须人工确认。迁移冲突会回滚，升级前停止旧worker并备份。"}),
    )
}
