use crate::error::ApiError;
use aes_gcm::{
    Aes256Gcm, KeyInit, Nonce,
    aead::{Aead, Payload},
};
use base64::{Engine, engine::general_purpose::STANDARD};
use std::{
    fs::{self, OpenOptions},
    io::{Read, Write},
    path::PathBuf,
};

pub struct Cipher(Aes256Gcm);
impl Cipher {
    pub fn from_key(key: &[u8]) -> Result<Self, ApiError> {
        Aes256Gcm::new_from_slice(key)
            .map(Self)
            .map_err(|_| unavailable())
    }
    pub fn load() -> Result<Self, ApiError> {
        if let Ok(value) = std::env::var("PANSOU_CLOUD_CREDENTIAL_KEY") {
            return Self::from_key(&STANDARD.decode(value.trim()).map_err(|_| unavailable())?);
        }
        let path = PathBuf::from(
            std::env::var("PANSOU_CLOUD_KEY_FILE")
                .unwrap_or_else(|_| "data/cloud-credentials.key".into()),
        );
        match fs::File::open(&path) {
            Ok(file) => {
                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;
                    if file
                        .metadata()
                        .map_err(|_| unavailable())?
                        .permissions()
                        .mode()
                        & 0o077
                        != 0
                    {
                        return Err(unavailable());
                    }
                }
                let mut key = Vec::new();
                file.take(33)
                    .read_to_end(&mut key)
                    .map_err(|_| unavailable())?;
                Self::from_key(&key)
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                if let Some(parent) = path.parent().filter(|p| !p.as_os_str().is_empty()) {
                    fs::create_dir_all(parent).map_err(|_| unavailable())?;
                }
                let key: [u8; 32] = rand::random();
                let mut options = OpenOptions::new();
                options.write(true).create_new(true);
                #[cfg(unix)]
                {
                    use std::os::unix::fs::OpenOptionsExt;
                    options.mode(0o600);
                }
                let temporary = path.with_extension(format!("{}.tmp", uuid::Uuid::new_v4()));
                match options.open(&temporary) {
                    Ok(mut file) => {
                        file.write_all(&key)
                            .and_then(|_| file.sync_all())
                            .map_err(|_| unavailable())?;
                        let linked = fs::hard_link(&temporary, &path);
                        let _ = fs::remove_file(&temporary);
                        match linked {
                            Ok(()) => Self::from_key(&key),
                            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => Self::load(),
                            Err(_) => Err(unavailable()),
                        }
                    }
                    Err(_) => Err(unavailable()),
                }
            }
            Err(_) => Err(unavailable()),
        }
    }
    pub fn seal(&self, aad: &str, value: &str) -> Result<String, ApiError> {
        let nonce: [u8; 12] = rand::random();
        let encrypted = self
            .0
            .encrypt(
                Nonce::from_slice(&nonce),
                Payload {
                    msg: value.as_bytes(),
                    aad: aad.as_bytes(),
                },
            )
            .map_err(|_| unavailable())?;
        let mut bytes = nonce.to_vec();
        bytes.extend(encrypted);
        Ok(format!("v1:{}", STANDARD.encode(bytes)))
    }
    pub fn open(&self, aad: &str, value: &str) -> Result<String, ApiError> {
        let bytes = value
            .strip_prefix("v1:")
            .and_then(|s| STANDARD.decode(s).ok())
            .filter(|b| b.len() >= 28)
            .ok_or_else(unavailable)?;
        let raw = self
            .0
            .decrypt(
                Nonce::from_slice(&bytes[..12]),
                Payload {
                    msg: &bytes[12..],
                    aad: aad.as_bytes(),
                },
            )
            .map_err(|_| unavailable())?;
        String::from_utf8(raw).map_err(|_| unavailable())
    }
}
fn unavailable() -> ApiError {
    ApiError::Unavailable("网盘凭证密钥不可用，请检查密钥配置或恢复原密钥文件".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn authenticated_encryption_binds_context_and_detects_tampering() {
        let cipher = Cipher::from_key(&[7; 32]).unwrap();
        let sealed = cipher.seal("account:quark", "__puus=secret").unwrap();
        assert!(!sealed.contains("secret"));
        assert_eq!(
            cipher.open("account:quark", &sealed).unwrap(),
            "__puus=secret"
        );
        assert!(cipher.open("account:baidu", &sealed).is_err());
        assert!(
            Cipher::from_key(&[8; 32])
                .unwrap()
                .open("account:quark", &sealed)
                .is_err()
        );
        assert_ne!(
            sealed,
            cipher.seal("account:quark", "__puus=secret").unwrap()
        );
    }
}
