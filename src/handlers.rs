mod account;
mod admin;
mod common;
mod crawling;
mod public;
pub(crate) mod search;
mod settings;

pub use account::*;
pub use admin::*;
pub use crawling::*;
pub use public::*;
pub use search::*;
pub use settings::*;

pub async fn api_not_found() -> crate::error::ApiError {
    crate::error::ApiError::NotFound("未知接口".into())
}
