mod account;
mod admin;
mod cloud_drive;
mod cloud_accounts;
mod common;
mod crawling;
mod monitoring;
mod public;
pub(crate) mod search;
mod settings;
mod tasks;

pub use account::*;
pub use admin::*;
pub use cloud_drive::*;
pub use cloud_accounts::*;
pub use crawling::*;
pub use monitoring::*;
pub use public::*;
pub use search::*;
pub use settings::*;
pub use tasks::*;

pub async fn api_not_found() -> crate::error::ApiError {
    crate::error::ApiError::NotFound("未知接口".into())
}
