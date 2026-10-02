ALTER TABLE cloud_account_settings
 ADD COLUMN credential_cipher TEXT,
 ADD COLUMN account_key TEXT,
 ADD COLUMN subject_id TEXT,
 ADD COLUMN display_name TEXT,
 ADD COLUMN storage_scope TEXT NOT NULL DEFAULT '',
 ADD COLUMN auth_status TEXT NOT NULL DEFAULT 'unverified',
 ADD COLUMN auth_source TEXT NOT NULL DEFAULT 'import',
 ADD COLUMN refreshable BOOLEAN NOT NULL DEFAULT false,
 ADD COLUMN token_revision BIGINT NOT NULL DEFAULT 0,
 ADD COLUMN binding_epoch BIGINT NOT NULL DEFAULT 0,
 ADD COLUMN expires_at TIMESTAMPTZ,
 ADD COLUMN next_check_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 ADD COLUMN last_verified_at TIMESTAMPTZ,
 ADD COLUMN last_refresh_at TIMESTAMPTZ,
 ADD COLUMN last_error_code TEXT,
 ADD COLUMN refresh_lease UUID,
 ADD COLUMN refresh_lease_until TIMESTAMPTZ,
 ADD COLUMN refresh_started_at TIMESTAMPTZ,
 ADD COLUMN pending_refresh_cipher TEXT;

CREATE TABLE cloud_account_aliases (
 provider TEXT NOT NULL,
 legacy_key TEXT NOT NULL,
 account_key TEXT NOT NULL,
 verified_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 PRIMARY KEY(provider,legacy_key)
);

CREATE TABLE cloud_login_sessions (
 id UUID PRIMARY KEY,
 actor_id BIGINT NOT NULL REFERENCES users(id),
 provider TEXT NOT NULL CHECK(provider IN('baidu','quark','aliyun','xunlei','guangya')),
 intent TEXT NOT NULL CHECK(intent IN('connect','reauthorize','replace')),
 expected_epoch BIGINT NOT NULL,
 status TEXT NOT NULL DEFAULT 'starting',
 context_cipher TEXT,
 qr_image TEXT,
 error_code TEXT,
 interval_seconds INTEGER NOT NULL DEFAULT 3,
 next_poll_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 expires_at TIMESTAMPTZ NOT NULL,
 poll_lease UUID,
 poll_lease_until TIMESTAMPTZ,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX cloud_login_one_active ON cloud_login_sessions(provider)
 WHERE status IN('starting','waiting','scanned','verifying');
CREATE INDEX cloud_login_due ON cloud_login_sessions(next_poll_at)
 WHERE status IN('waiting','scanned','verifying');
CREATE INDEX cloud_credentials_due ON cloud_account_settings(next_check_at)
 WHERE credential_cipher IS NOT NULL;
