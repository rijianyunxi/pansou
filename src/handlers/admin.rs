//! Administrator endpoints grouped by business responsibility.
//! Re-exports preserve the route-facing API in `crate::handlers`.

mod account;
mod hot_searches;
mod monitoring;
mod proxies;
mod resources;
mod search_logs;
mod users;

pub use account::*;
pub use hot_searches::*;
pub use monitoring::*;
pub use proxies::*;
pub use resources::*;
pub use search_logs::*;
pub use users::*;

use serde_json::Value;

fn string_list(payload: &Value, key: &str) -> Vec<String> {
    payload
        .get(key)
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|value| value.as_str().map(str::to_owned))
        .collect()
}
