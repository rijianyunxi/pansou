-- Business feature settings belong to the provider account, not process env.
ALTER TABLE cloud_account_settings
    ADD COLUMN qr_enabled boolean NOT NULL DEFAULT false,
    ADD COLUMN qr_context text,
    ADD COLUMN qr_revision bigint NOT NULL DEFAULT 0,
    ADD CONSTRAINT cloud_account_qr_revision_check CHECK (qr_revision >= 0),
    ADD CONSTRAINT cloud_account_qr_context_size_check CHECK (qr_context IS NULL OR octet_length(qr_context) <= 65536),
    ADD CONSTRAINT cloud_account_qr_enabled_check CHECK (NOT qr_enabled OR qr_context IS NOT NULL),
    ADD CONSTRAINT cloud_account_qr_provider_check CHECK (provider = 'xunlei' OR (NOT qr_enabled AND qr_context IS NULL AND qr_revision = 0));
