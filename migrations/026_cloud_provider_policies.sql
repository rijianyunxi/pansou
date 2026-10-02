-- Consolidate the per-provider delivery + detection configuration that used to live
-- as two JSON blobs in policy_settings ('link-delivery' and 'link-check') into one
-- typed row per provider. Every netdisk card reads and writes exactly one row.
CREATE TABLE cloud_provider_policies(
 provider TEXT PRIMARY KEY CHECK(provider IN('baidu','quark','aliyun','xunlei','guangya')),
 -- Delivery (按需转存)
 delivery_enabled BOOLEAN NOT NULL DEFAULT false,
 target_dir TEXT,
 target_dir_name TEXT NOT NULL DEFAULT '',
 retention_seconds INTEGER,
 delivery_min_remaining_seconds INTEGER NOT NULL DEFAULT 300,
 platform_share_days INTEGER NOT NULL DEFAULT 7,
 -- Detection (后台有效性检测参数；启停仍由「链接后台处理」统一控制)
 check_interval_seconds INTEGER NOT NULL DEFAULT 2,
 check_valid_seconds INTEGER NOT NULL DEFAULT 86400,
 check_invalid_seconds INTEGER NOT NULL DEFAULT 604800,
 check_daily_budget INTEGER NOT NULL DEFAULT 1000,
 revision BIGINT NOT NULL DEFAULT 1,
 updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 CHECK(delivery_enabled = false OR (retention_seconds IS NOT NULL AND retention_seconds BETWEEN 60 AND 2592000)),
 CHECK(delivery_min_remaining_seconds >= 0),
 CHECK(platform_share_days IN(1,7,30)),
 CHECK(check_interval_seconds BETWEEN 2 AND 3600),
 CHECK(check_valid_seconds BETWEEN 60 AND 2592000),
 CHECK(check_invalid_seconds BETWEEN 60 AND 2592000),
 CHECK(check_daily_budget BETWEEN 1 AND 100000)
);

INSERT INTO cloud_provider_policies(provider)
 SELECT unnest(ARRAY['baidu','quark','aliyun','xunlei','guangya']);

-- Carry over the previous configuration so upgrades keep the admin's settings.
UPDATE cloud_provider_policies p SET
 delivery_enabled = COALESCE((d.value_json->p.provider->>'enabled')::boolean,false),
 target_dir = NULLIF(d.value_json->p.provider->>'targetDir',''),
 retention_seconds = (d.value_json->p.provider->>'deliveryTtlSeconds')::integer,
 delivery_min_remaining_seconds = COALESCE((d.value_json->p.provider->>'deliveryMinRemainingSeconds')::integer,300),
 platform_share_days = COALESCE((d.value_json->p.provider->>'platformShareDays')::smallint,7),
 check_interval_seconds = COALESCE((c.value_json->>'intervalSeconds')::integer,2),
 check_valid_seconds = COALESCE((c.value_json->>'validSeconds')::integer,86400),
 check_invalid_seconds = COALESCE((c.value_json->>'invalidSeconds')::integer,604800),
 check_daily_budget = COALESCE((c.value_json->>'dailyBudget')::integer,1000)
FROM policy_settings d, policy_settings c
WHERE d.key='link-delivery' AND c.key='link-check';

-- link-check keeps only the global background-detection master switch; the
-- parameters now live per provider. The link-delivery blob is gone entirely.
UPDATE policy_settings
 SET value_json=jsonb_build_object('enabled',COALESCE((value_json->>'enabled')::boolean,false)),
     updated_at=now()
 WHERE key='link-check';
DELETE FROM policy_settings WHERE key='link-delivery';
