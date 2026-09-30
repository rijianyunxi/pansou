CREATE TABLE cloud_drive_operations (
 request_key UUID PRIMARY KEY,
 actor_id BIGINT NOT NULL REFERENCES users(id),
 provider TEXT NOT NULL CHECK(provider IN ('baidu','quark')),
 action TEXT NOT NULL CHECK(action IN ('save','existing','delete')),
 fingerprint TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'running' CHECK(status IN ('running','completed','failed','uncertain')),
 http_status INTEGER NOT NULL DEFAULT 202,
 response_json JSONB NOT NULL DEFAULT '{}'::jsonb,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 expires_at TIMESTAMPTZ NOT NULL DEFAULT now()+interval '4 minutes'
);
CREATE INDEX idx_cloud_operations_created ON cloud_drive_operations(created_at DESC);
CREATE TABLE cloud_delete_previews (
 token UUID PRIMARY KEY,
 actor_id BIGINT NOT NULL REFERENCES users(id),
 fingerprint TEXT NOT NULL,
 files_json JSONB NOT NULL,
 used_by UUID REFERENCES cloud_drive_operations(request_key),
 expires_at TIMESTAMPTZ NOT NULL DEFAULT now()+interval '5 minutes',
 created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_cloud_previews_expires ON cloud_delete_previews(expires_at);
