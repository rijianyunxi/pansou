use crate::{error::ApiError, models::UserView, redis_store::RedisStore};
use axum::http::{HeaderMap, header};
use rand::{Rng, distr::Alphanumeric};
use redis::AsyncCommands;
use sqlx::{PgPool, Row};

pub const SESSION_COOKIE: &str = "pansou_session";

fn session_key(token: &str) -> String {
    format!("pansou:session:{token}")
}

fn anonymous_key(token: &str) -> String {
    format!("pansou:anon:{token}")
}

fn user_sessions_key(user_id: i64) -> String {
    format!("pansou:user_sessions:{user_id}")
}

#[derive(Clone, Debug)]
pub struct Session {
    pub token: String,
    pub user_id: Option<i64>,
}

#[derive(Clone)]
pub struct Auth {
    pub pool: PgPool,
    pub redis: RedisStore,
}

impl Auth {
    pub async fn session_ttl_seconds(&self) -> u64 {
        crate::policy::load(&self.pool)
            .await
            .unwrap_or_default()
            .session_ttl_seconds()
    }

    pub async fn existing_session(&self, headers: &HeaderMap) -> Result<Option<Session>, ApiError> {
        let token = headers
            .get(header::AUTHORIZATION)
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.strip_prefix("Bearer "))
            .map(str::to_owned)
            .or_else(|| cookie(headers, SESSION_COOKIE));
        let Some(token) = token else {
            return Ok(None);
        };
        if let Some(user_id) = self.lookup(&token).await? {
            return Ok(Some(Session {
                token,
                user_id: Some(user_id),
            }));
        }
        if self.is_anonymous(&token).await? {
            return Ok(Some(Session {
                token,
                user_id: None,
            }));
        }
        Ok(None)
    }

    pub async fn session(&self, headers: &HeaderMap) -> Result<Session, ApiError> {
        self.existing_session(headers).await?.ok_or_else(|| {
            ApiError::SessionRequired("搜索会话不存在或已失效，请刷新页面后重试".into())
        })
    }

    async fn lookup(&self, token: &str) -> Result<Option<i64>, ApiError> {
        let mut connection = self.redis.connection()?;
        let user_id: Option<i64> = connection
            .get(session_key(token))
            .await
            .map_err(|error| ApiError::Internal(error.to_string()))?;
        let Some(user_id) = user_id else {
            return Ok(None);
        };
        let status: Option<String> =
            sqlx::query_scalar("SELECT status FROM users WHERE id=$1 AND deleted_at IS NULL")
                .bind(user_id)
                .fetch_optional(&self.pool)
                .await?;
        if status.as_deref() == Some("active") {
            return Ok(Some(user_id));
        }
        self.revoke_token(token, Some(user_id)).await?;
        Ok(None)
    }

    async fn is_anonymous(&self, token: &str) -> Result<bool, ApiError> {
        let mut connection = self.redis.connection()?;
        connection
            .exists(anonymous_key(token))
            .await
            .map_err(|error| ApiError::Internal(error.to_string()))
    }

    pub async fn issue(&self, anonymous: bool) -> Result<Session, ApiError> {
        let token: String = rand::rng()
            .sample_iter(&Alphanumeric)
            .take(48)
            .map(char::from)
            .collect();
        if anonymous {
            let ttl_seconds = self.session_ttl_seconds().await;
            let mut connection = self.redis.connection()?;
            let _: () = connection
                .set_ex(anonymous_key(&token), "1", ttl_seconds)
                .await
                .map_err(|error| ApiError::Internal(error.to_string()))?;
        }
        Ok(Session {
            token,
            user_id: None,
        })
    }

    pub async fn login(
        &self,
        username: &str,
        password: &str,
    ) -> Result<(Session, UserView), ApiError> {
        let row = sqlx::query("SELECT id, username, nickname, role, status, password_hash FROM users WHERE username_normalized=$1 AND deleted_at IS NULL")
            .bind(username.to_lowercase())
            .fetch_optional(&self.pool)
            .await?
            .ok_or_else(|| ApiError::Unauthorized("用户名或密码错误".into()))?;
        let status: String = row.try_get("status")?;
        if status != "active" {
            return Err(ApiError::Forbidden("账号已禁用".into()));
        }
        let hash: String = row.try_get("password_hash")?;
        if !verify_password(password, &hash) {
            return Err(ApiError::Unauthorized("用户名或密码错误".into()));
        }
        let id: i64 = row.try_get("id")?;
        let session = self.issue(false).await?;
        self.register_user_session(id, &session.token).await?;
        Ok((
            Session {
                user_id: Some(id),
                ..session
            },
            UserView {
                id,
                username: row.try_get("username")?,
                nickname: row.try_get("nickname")?,
                role: row.try_get("role")?,
                status,
            },
        ))
    }

    async fn register_user_session(&self, user_id: i64, token: &str) -> Result<(), ApiError> {
        let ttl_seconds = self.session_ttl_seconds().await;
        let mut connection = self.redis.connection()?;
        let session_key = session_key(token);
        let user_sessions_key = user_sessions_key(user_id);
        let _: () = redis::pipe()
            .atomic()
            .cmd("SETEX")
            .arg(&session_key)
            .arg(ttl_seconds)
            .arg(user_id)
            .ignore()
            .cmd("SADD")
            .arg(&user_sessions_key)
            .arg(token)
            .ignore()
            .cmd("EXPIRE")
            .arg(&user_sessions_key)
            .arg(ttl_seconds)
            .ignore()
            .query_async(&mut connection)
            .await
            .map_err(|error| ApiError::Internal(error.to_string()))?;
        Ok(())
    }

    async fn revoke_token(&self, token: &str, user_id: Option<i64>) -> Result<(), ApiError> {
        let mut connection = self.redis.connection()?;
        let mut pipeline = redis::pipe();
        pipeline
            .atomic()
            .cmd("DEL")
            .arg(session_key(token))
            .arg(anonymous_key(token))
            .ignore();
        if let Some(user_id) = user_id {
            pipeline
                .cmd("SREM")
                .arg(user_sessions_key(user_id))
                .arg(token)
                .ignore();
        }
        let _: () = pipeline
            .query_async(&mut connection)
            .await
            .map_err(|error| ApiError::Internal(error.to_string()))?;
        Ok(())
    }

    pub async fn revoke_session(&self, session: &Session) -> Result<(), ApiError> {
        self.revoke_token(&session.token, session.user_id).await
    }

    pub async fn revoke_user_sessions(&self, user_id: i64) -> Result<usize, ApiError> {
        let mut connection = self.redis.connection()?;
        let index_key = user_sessions_key(user_id);
        let tokens: Vec<String> = connection
            .smembers(&index_key)
            .await
            .map_err(|error| ApiError::Internal(error.to_string()))?;
        let mut pipeline = redis::pipe();
        pipeline.atomic();
        if !tokens.is_empty() {
            pipeline.cmd("DEL");
            for token in &tokens {
                pipeline.arg(session_key(token));
            }
            pipeline.ignore();
        }
        pipeline.cmd("DEL").arg(index_key).ignore();
        let _: () = pipeline
            .query_async(&mut connection)
            .await
            .map_err(|error| ApiError::Internal(error.to_string()))?;
        Ok(tokens.len())
    }

    pub async fn public_user(&self, id: i64) -> Result<UserView, ApiError> {
        let row = sqlx::query(
            "SELECT id,username,nickname,role,status FROM users WHERE id=$1 AND deleted_at IS NULL",
        )
        .bind(id)
        .fetch_optional(&self.pool)
        .await?
        .ok_or_else(|| ApiError::Unauthorized("登录会话已失效，请重新登录".into()))?;
        Ok(UserView {
            id: row.try_get("id")?,
            username: row.try_get("username")?,
            nickname: row.try_get("nickname")?,
            role: row.try_get("role")?,
            status: row.try_get("status")?,
        })
    }
}

fn cookie(headers: &HeaderMap, name: &str) -> Option<String> {
    headers
        .get(header::COOKIE)?
        .to_str()
        .ok()?
        .split(';')
        .map(str::trim)
        .find_map(|part| part.strip_prefix(&format!("{name}=")).map(str::to_owned))
}

fn verify_password(password: &str, encoded: &str) -> bool {
    argon2::PasswordHash::new(encoded)
        .ok()
        .and_then(|parsed| {
            argon2::PasswordVerifier::verify_password(
                &argon2::Argon2::default(),
                password.as_bytes(),
                &parsed,
            )
            .ok()
        })
        .is_some()
}

pub fn hash_password(password: &str) -> Result<String, ApiError> {
    use argon2::{
        Argon2,
        password_hash::{PasswordHasher, SaltString, rand_core::OsRng},
    };
    let salt = SaltString::generate(&mut OsRng);
    Ok(Argon2::default()
        .hash_password(password.as_bytes(), &salt)
        .map_err(|error| ApiError::Internal(error.to_string()))?
        .to_string())
}

pub fn session_cookie(token: &str, max_age_seconds: u64) -> String {
    format!("{SESSION_COOKIE}={token}; Path=/; HttpOnly; SameSite=Lax; Max-Age={max_age_seconds}")
}

pub fn clear_session_cookie() -> String {
    format!("{SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0")
}
