use sqlx::{Postgres, Transaction};

pub const LIMIT: i64 = 30;

/// Lock before taking the search-log snapshot so concurrent evicted terms keep
/// their full history-based score. The database trigger also fences admin writes.
pub async fn lock(tx: &mut Transaction<'_, Postgres>) -> Result<(), sqlx::Error> {
    sqlx::query("SELECT pg_advisory_xact_lock(773013)")
        .execute(&mut **tx)
        .await?;
    Ok(())
}
