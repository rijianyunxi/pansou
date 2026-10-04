-- Preserve the existing configuration and its update timestamp.
INSERT INTO policy_settings(key,value_json,updated_at)
SELECT 'wechat-mini',jsonb_build_object('appId',app_id,'secret',secret,'qrPage',qr_page,'envVersion',env_version),updated_at
FROM wechat_mini_settings;
DROP TABLE wechat_mini_settings;

-- Canonical values take precedence; preserve installations that only have old keys.
INSERT INTO policy_settings(key,value_json,updated_at)
SELECT CASE key
 WHEN 'anonymous_custom_channels' THEN 'anonymousCustomChannels'
 WHEN 'show_hot_search' THEN 'showHotSearch'
 WHEN 'show_auth_buttons' THEN 'showAuthButtons'
 WHEN 'home_search_placeholder' THEN 'homeSearchPlaceholder'
 END,value_json,updated_at
FROM policy_settings WHERE key IN ('anonymous_custom_channels','show_hot_search','show_auth_buttons','home_search_placeholder')
ON CONFLICT(key) DO NOTHING;
DELETE FROM policy_settings WHERE key IN ('anonymous_custom_channels','show_hot_search','show_auth_buttons','home_search_placeholder');
