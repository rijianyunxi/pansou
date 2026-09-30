mod account;
mod admin;
mod cloud_drive;
mod common;
mod crawling;
mod public;
pub(crate) mod search;
mod settings;

pub use account::*;
pub use admin::*;
pub use cloud_drive::*;
pub use crawling::*;
pub use public::*;
pub use search::*;
pub use settings::*;

pub async fn api_not_found() -> crate::error::ApiError {
    crate::error::ApiError::NotFound("未知接口".into())
}
