use super::*;
use base64::{Engine, engine::general_purpose::STANDARD};
#[test]
fn login_errors_preserve_stage_and_retry_only_transient_failures() {
    let protocol = AuthFailure::Protocol.api();
    assert_eq!(
        login_failure("account_identity", Some(AuthFailure::Protocol), &protocol),
        (false, "account_identity:provider_protocol_error".into())
    );
    let network = AuthFailure::Network.api();
    assert_eq!(
        login_failure("token_exchange", Some(AuthFailure::Network), &network),
        (true, "token_exchange:network_error".into())
    );
    assert_eq!(
        login_failure(
            "token_exchange",
            Some(AuthFailure::ExchangeUncertain),
            &AuthFailure::ExchangeUncertain.api()
        ),
        (
            false,
            "token_exchange:authorization_exchange_uncertain".into()
        )
    );
    assert_eq!(
        login_failure(
            "root_access",
            None,
            &ApiError::Forbidden("secret upstream detail".into())
        ),
        (false, "root_access:permission_denied".into())
    );
}
#[test]
fn a_state_conflict_is_never_reported_as_an_account_switch() {
    // The admin's own row moved, or the scan session was replaced or expired.
    // Blaming that on "you scanned another account" sends them to a button that
    // has nothing to do with the failure.
    for stage in ["token_exchange", "credential_save"] {
        assert_eq!(
            login_failure(stage, None, &ApiError::Conflict("session replaced".into())),
            (false, format!("{stage}:state_changed"))
        );
    }
    // A genuine mismatch still keeps its own code, delivered via the auth reason.
    for failure in [AuthFailure::AccountMismatch, AuthFailure::AccountUnverified] {
        assert_eq!(
            login_failure("credential_save", Some(failure), &failure.api()),
            (false, format!("credential_save:{}", failure.code()))
        );
    }
}
#[test]
fn account_maintenance_schedules_refresh_before_expiry() {
    let expiration = Utc::now() + Duration::hours(2);
    assert!(next_check(Some(expiration), true) < expiration);
    assert!(validate_intent("replace").is_ok());
    assert!(validate_intent("overwrite").is_err());
}

#[derive(Default)]
struct MockAuth {
    refreshes: usize,
    deny_identity: bool,
    identity_protocol_failure: bool,
    quark_scan_confirmed: bool,
    quark_poll_calls: usize,
    quark_cookie_rotations: usize,
    quark_broken_session: bool,
    directory_failure: bool,
    baidu_long_poll: bool,
    baidu_unparseable_exchange: bool,
    baidu_calls: usize,
    ali_device_failure: bool,
    ali_resource_missing: bool,
    ali_drive_list_calls: usize,
    qr_exchanges: usize,
}
async fn upstream(
    axum::extract::State(mock): axum::extract::State<Arc<tokio::sync::Mutex<MockAuth>>>,
    request: axum::http::Request<axum::body::Body>,
) -> axum::response::Response {
    use axum::response::IntoResponse;
    let path = request.uri().path().to_owned();
    if path == "/passport.baidu.com/channel/unicast" {
        let delay = {
            let mut m = mock.lock().await;
            m.baidu_calls += 1;
            m.baidu_long_poll
        };
        if delay {
            tokio::time::sleep(std::time::Duration::from_secs(4)).await;
        }
    }
    if path == "/account.guangyapan.com/v1/user/me" && request.method() != axum::http::Method::GET {
        return (
            axum::http::StatusCode::NOT_IMPLEMENTED,
            axum::Json(json!({"error":"unimplemented"})),
        )
            .into_response();
    }
    let cookie = request
        .headers()
        .get("cookie")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_owned();
    let mut mock = mock.lock().await;
    if path.starts_with("/account.guangyapan.com/") {
        assert_eq!(request.headers()["x-os-version"], "Win32");
        assert_eq!(request.headers()["x-device-model"], "chrome%2F131.0.0.0");
        assert!(request.headers().contains_key("x-device-id"));
    }
    if mock.identity_protocol_failure && path == "/account.guangyapan.com/v1/user/me" {
        return (
            axum::http::StatusCode::NOT_IMPLEMENTED,
            axum::Json(
                json!({"error":"unimplemented","error_description":"fixture-sensitive-body"}),
            ),
        )
            .into_response();
    }
    if mock.deny_identity && path.contains("/v1/user/me") {
        return (
            axum::http::StatusCode::UNAUTHORIZED,
            axum::Json(json!({"error":"invalid_token"})),
        )
            .into_response();
    }
    let subject = if cookie.contains("account_two") {
        "subject2"
    } else {
        "subject1"
    };
    let value = match path.as_str() {
        "/pan.quark.cn/account/info" => {
            if request.uri().query().is_some_and(|q| q.contains("st=")) {
                // Like the official web flow: the CAS ticket lands the pan session
                // across redirect hops, so the exchange response itself carries no
                // identity payload, only the first Set-Cookie of the chain.
                return if mock.quark_broken_session {
                    (
                        axum::http::StatusCode::FOUND,
                        [("location", "/account/scan-landing")],
                        "",
                    )
                        .into_response()
                } else {
                    (
                        axum::http::StatusCode::FOUND,
                        [
                            ("location", "/account/scan-landing"),
                            (
                                "set-cookie",
                                "__puus=qr-cookie; Domain=quark.cn; Path=/; Secure; HttpOnly",
                            ),
                        ],
                        "",
                    )
                        .into_response()
                };
            }
            if cookie.is_empty() || cookie == "ctoken=anonymous" {
                json!({"success":true,"code":"OK","data":[]})
            } else {
                json!({"success":true,"code":"OK","data":{"uid":subject,"nickname":"Test account"}})
            }
        }
        "/pan.quark.cn/account/scan-landing" => {
            let mut response = axum::Json(json!({"success":true,"code":"OK","data":{"uid":"subject1","nickname":"Test account"}})).into_response();
            if !mock.quark_broken_session {
                response.headers_mut().append(
                    "set-cookie",
                    axum::http::HeaderValue::from_static("ctoken=scan-landing; Path=/"),
                );
            }
            return response;
        }
        "/pan.baidu.com/api/gettemplatevariable" | "/api/gettemplatevariable" => {
            json!({"errno":0,"result":{"uk":"123456","bdstoken":"test-bdstoken"}})
        }
        "/api/list" => json!({"errno":0,"list":[]}),
        "/api.aliyundrive.com/v2/user/get" => {
            json!({"user_id":"subject1","default_drive_id":"drive1","nick_name":"Test account"})
        }
        "/api.aliyundrive.com/v2/drive/list_my_drives" => {
            mock.ali_drive_list_calls += 1;
            let input: Value = serde_json::from_slice(
                &axum::body::to_bytes(request.into_body(), 32768)
                    .await
                    .unwrap(),
            )
            .unwrap();
            assert_eq!(input["limit"], 100);
            if input["marker"] == "" {
                json!({"items":[{"drive_id":"drive1","category":"backup","status":"enabled"},{"drive_id":"album1","category":"shared_album","status":"enabled"}],"next_marker":"resource-page"})
            } else {
                assert_eq!(input["marker"], "resource-page");
                json!({"items":if mock.ali_resource_missing {json!([])} else {json!([{"drive_id":"resource1","category":"resource","status":"enabled"}])},"next_marker":""})
            }
        }
        "/api.aliyundrive.com/v2/drive/get" => json!({"owner":"subject1"}),
        "/api.aliyundrive.com/users/v1/users/device/create_session" => {
            assert!(request.headers().contains_key("x-device-id"));
            assert!(request.headers().contains_key("x-signature"));
            json!({"result":!mock.ali_device_failure})
        }
        "/account.guangyapan.com/v1/user/me" | "/xluser-ssl.xunlei.com/v1/user/me" => {
            json!({"sub":"subject1","name":"Test account"})
        }
        "/account.guangyapan.com/v1/auth/token"
        | "/xluser-ssl.xunlei.com/v1/auth/token"
        | "/api.aliyundrive.com/v2/account/token" => {
            let input: Value = serde_json::from_slice(
                &axum::body::to_bytes(request.into_body(), 32768)
                    .await
                    .unwrap(),
            )
            .unwrap();
            if input["grant_type"] == "urn:ietf:params:oauth:grant-type:device_code" {
                mock.qr_exchanges += 1;
                json!({"access_token":"qr-access","refresh_token":"qr-refresh","expires_in":7200})
            } else {
                mock.refreshes += 1;
                json!({"access_token":format!("access-{}",mock.refreshes),"refresh_token":format!("refresh-{}",mock.refreshes),"expires_in":7200})
            }
        }
        "/account.guangyapan.com/v1/auth/device/code" => {
            json!({"device_code":"fixture-device","verification_uri_complete":"https://account.guangyapan.com/authorize?code=fixture","expires_in":300,"interval":2})
        }
        "/uop.quark.cn/cas/ajax/getTokenForQrcodeLogin" => {
            json!({"status":2000000,"data":{"members":{"token":"fixture-qr"}}})
        }
        "/uop.quark.cn/cas/ajax/getServiceTicketByQrcodeToken" => {
            mock.quark_poll_calls += 1;
            if mock.quark_scan_confirmed {
                json!({"status":2000000,"data":{"members":{"service_ticket":"fixture-service-ticket"}}})
            } else {
                json!({"status":50004001})
            }
        }
        "/passport.baidu.com/channel/unicast" => {
            if mock.baidu_long_poll {
                json!({"errno":"1"})
            } else {
                json!({"errno":"0","channel_v":{"status":"0","v":"fixture-ticket"}})
            }
        }
        "/passport.baidu.com/v3/login/main/qrbdusslogin" => {
            if mock.baidu_unparseable_exchange {
                // JS-only JSONP: the trailing comma is valid JavaScript that a
                // browser evaluates, but no JSON repair may ever accept it. The
                // login session is handed out directly in the Set-Cookie.
                return (
                    [("content-type", "text/html"), ("set-cookie", "BDUSS=fixture-login; Domain=baidu.com; Path=/")],
                    r#"fixture({"errInfo":{"no":"0"},'data':{"u":"https:\/\/pan.baidu.com\/fixture-finish\?from\=scan\&ok\=1",}})"#,
                ).into_response();
            }
            return (
                [("content-type", "text/html")],
                r#"fixture({"errInfo":{"no":"0"},'data':{"u":"https:\/\/pan.baidu.com\/fixture-finish\?from\=scan\&ok\=1","user":{"displayName":"O\'Brien"}}})"#,
            ).into_response();
        }
        "/pan.baidu.com/" => {
            return (
                [(
                    "set-cookie",
                    "BAIDUID=fixture-browser; Domain=baidu.com; Path=/",
                )],
                axum::Json(json!({})),
            )
                .into_response();
        }
        "/pan.baidu.com/fixture-finish" => {
            assert_eq!(request.uri().query(), Some("from=scan&ok=1"));
            return (
                axum::http::StatusCode::FOUND,
                [
                    ("location", "/fixture-confirm"),
                    (
                        "set-cookie",
                        "BAIDUID=fixture-browser; Domain=baidu.com; Path=/",
                    ),
                ],
                "",
            )
                .into_response();
        }
        "/pan.baidu.com/fixture-confirm" => {
            return (
                [(
                    "set-cookie",
                    "BDUSS_BFESS=fixture-login; Domain=baidu.com; Path=/",
                )],
                axum::Json(json!({})),
            )
                .into_response();
        }
        "/auth.aliyundrive.com/v2/oauth/authorize" => json!({}),
        "/passport.aliyundrive.com/newlogin/qrcode/generate.do" => {
            json!({"content":{"data":{"codeContent":"https://www.alipan.com/scan?fixture=1","ck":"fixture-ck","t":123}}})
        }
        "/passport.aliyundrive.com/newlogin/qrcode/query.do" => {
            assert_eq!(request.method(), axum::http::Method::POST);
            assert_eq!(
                request.headers()["content-type"],
                "application/x-www-form-urlencoded"
            );
            let body = axum::body::to_bytes(request.into_body(), 32768)
                .await
                .unwrap();
            let params: std::collections::HashMap<_, _> =
                url::form_urlencoded::parse(&body).into_owned().collect();
            assert_eq!(params["ck"], "fixture-ck");
            json!({"content":{"data":{"qrCodeStatus":"CONFIRMED","bizExt":STANDARD.encode(br#"{"pds_login_result":{"refreshToken":"fixture-refresh"}}"#)}}})
        }
        p if p.starts_with("/drive/") => {
            if mock.directory_failure {
                return (axum::http::StatusCode::BAD_GATEWAY, axum::Json(json!({})))
                    .into_response();
            }
            if p.ends_with("file/sort") {
                mock.quark_cookie_rotations += 1;
                return (
                    [(
                        "set-cookie",
                        format!(
                            "__puus={}rotated-cookie-{}; Domain=quark.cn; Path=/",
                            if cookie.contains("account_two") {
                                "account_two-"
                            } else {
                                ""
                            },
                            mock.quark_cookie_rotations
                        ),
                    )],
                    axum::Json(json!({"code":0,"data":{"list":[]}})),
                )
                    .into_response();
            }
            json!({"code":0,"data":{"files":[],"items":[],"list":[],"total":0},"items":[]})
        }
        _ => {
            return (
                axum::http::StatusCode::NOT_FOUND,
                axum::Json(json!({"unexpected":path})),
            )
                .into_response();
        }
    };
    axum::Json(value).into_response()
}

#[tokio::test]
#[ignore = "requires isolated _test PostgreSQL and Redis"]
async fn provider_qr_protocols_and_independent_polling_are_strict() {
    let database = std::env::var("PANSOU_TEST_DATABASE_URL").unwrap();
    assert!(
        url::Url::parse(&database)
            .unwrap()
            .path()
            .ends_with("_test")
    );
    let redis = std::env::var("PANSOU_TEST_REDIS_URL").unwrap();
    assert_ne!(url::Url::parse(&redis).unwrap().path(), "/0");
    let pool = sqlx::postgres::PgPoolOptions::new()
        .max_connections(12)
        .connect(&database)
        .await
        .unwrap();
    crate::db::init_db(&pool).await.unwrap();
    let mock = Arc::new(tokio::sync::Mutex::new(MockAuth::default()));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}/", listener.local_addr().unwrap());
    let server = axum::Router::new()
        .fallback(axum::routing::any(upstream))
        .with_state(mock.clone());
    let server = tokio::spawn(async move { axum::serve(listener, server).await.unwrap() });
    let mut state = AppState::new(
        pool.clone(),
        crate::redis_store::RedisStore::connect(&redis)
            .await
            .unwrap(),
    );
    state.cloud_auth_test_base = Some(base.clone());
    let drive = url::Url::parse(&format!("{base}drive/")).unwrap();
    state.cloud_test_bases = Some(cloud_drive::TestBases {
        baidu: drive.clone(),
        quark_pc: drive.clone(),
        quark_share: drive,
    });
    let state = Arc::new(state);
    let mut baidu = providers::Context {
        data: json!({"sign":"fixture-sign","gid":"fixture-gid","callback":"fixture"}),
        ..Default::default()
    };
    let providers::Poll::Ready(cookie) = providers::poll(&state, Provider::Baidu, &mut baidu)
        .await
        .unwrap()
    else {
        panic!("Baidu fixture did not complete")
    };
    assert!(cookie.contains("BDUSS_BFESS=fixture-login"));
    assert!(cookie.contains("BAIDUID=fixture-browser"));
    verify(&state, Provider::Baidu, &cookie).await.unwrap();
    // A JS-only exchange body must not fail the login: the session cookie the
    // response carries decides the outcome, and identity still gates storage.
    mock.lock().await.baidu_unparseable_exchange = true;
    let mut baidu_garbage = providers::Context {
        data: json!({"sign":"fixture-sign","gid":"fixture-gid","callback":"fixture"}),
        ..Default::default()
    };
    let providers::Poll::Ready(cookie) =
        providers::poll(&state, Provider::Baidu, &mut baidu_garbage)
            .await
            .unwrap()
    else {
        panic!("Baidu unparseable exchange did not complete")
    };
    assert!(cookie.contains("BDUSS=fixture-login"));
    assert!(cookie.contains("BAIDUID=fixture-browser"));
    verify(&state, Provider::Baidu, &cookie).await.unwrap();
    mock.lock().await.baidu_unparseable_exchange = false;
    let mut ali = providers::start(&state, Provider::Aliyun)
        .await
        .unwrap()
        .context;
    let providers::Poll::Ready(token) = providers::poll(&state, Provider::Aliyun, &mut ali)
        .await
        .unwrap()
    else {
        panic!("Ali fixture did not complete")
    };
    let identity = verify(&state, Provider::Aliyun, &token).await.unwrap();
    assert_eq!(identity.scope, "resource1");
    assert_eq!(
        serde_json::from_str::<Value>(&identity.raw).unwrap()["drive_id"],
        "resource1"
    );
    assert_eq!(mock.lock().await.ali_drive_list_calls, 2);
    // A saved backup-space binding must survive account checks and token renewal.
    let backup = json!({"access_token":"fixture-access","refresh_token":"fixture-refresh","user_id":"subject1","driveId":"drive1","signature":"fixture-signature"}).to_string();
    let refreshed = providers::refresh(&state, Provider::Aliyun, &backup)
        .await
        .unwrap();
    let identity = providers::identity(&state, Provider::Aliyun, &refreshed)
        .await
        .unwrap();
    assert_eq!(identity.scope, "drive1");
    assert_eq!(mock.lock().await.ali_drive_list_calls, 2);
    // Accounts without an enabled resource library still use their default drive.
    mock.lock().await.ali_resource_missing = true;
    assert_eq!(
        providers::identity(&state, Provider::Aliyun, &token)
            .await
            .unwrap()
            .scope,
        "drive1"
    );
    mock.lock().await.ali_resource_missing = false;
    let raw=json!({"access_token":"fixture-access","device_id":"fixture-device","x-device-id":"fixture-device","x-signature":"stale-signature","device_private_key":STANDARD.encode([9u8;32])}).to_string();
    let renewed = providers::identity(&state, Provider::Aliyun, &raw)
        .await
        .unwrap();
    let value: Value = serde_json::from_str(&renewed.raw).unwrap();
    assert!(value.get("x-signature").is_none());
    assert!(value.get("x-device-id").is_none());
    mock.lock().await.ali_device_failure = true;
    assert!(matches!(
        providers::identity(&state, Provider::Aliyun, &raw).await,
        Err(AuthFailure::Protocol)
    ));
    mock.lock().await.ali_device_failure = false;
    assert!(matches!(
        providers::refresh(
            &state,
            Provider::Xunlei,
            &json!({"refresh_token":"fixture"}).to_string()
        )
        .await,
        Err(AuthFailure::ClientConfiguration)
    ));
    let mut guangya = providers::start(&state, Provider::Guangya)
        .await
        .unwrap()
        .context;
    let original_device = guangya.data["device_id"].clone();
    let original_sign = guangya.data["device_sign"].clone();
    let providers::Poll::Ready(token) = providers::poll(&state, Provider::Guangya, &mut guangya)
        .await
        .unwrap()
    else {
        panic!("Guangya fixture did not complete")
    };
    let token: Value = serde_json::from_str(&token).unwrap();
    assert_eq!(token["device_id"], original_device);
    assert_eq!(token["device_sign"], original_sign);
    assert!(token.get("device_code").is_none());
    verify(&state, Provider::Guangya, &token.to_string())
        .await
        .unwrap();

    let unique = Uuid::new_v4().to_string();
    let actor:i64=sqlx::query_scalar("INSERT INTO users(username,username_normalized,password_hash,role) VALUES($1,$1,'fixture','admin') RETURNING id").bind(&unique).fetch_one(&pool).await.unwrap();
    let login = start_login(&state, Provider::Guangya, actor, "connect", 0)
        .await
        .unwrap();
    let gid = Uuid::parse_str(login["id"].as_str().unwrap()).unwrap();
    sqlx::query(
        "UPDATE cloud_login_sessions SET expires_at=now()+interval '10 seconds' WHERE id=$1",
    )
    .bind(gid)
    .execute(&pool)
    .await
    .unwrap();
    mock.lock().await.directory_failure = true;
    poll_provider_once(&state, Some(Provider::Guangya))
        .await
        .unwrap();
    assert_eq!(
        session(&state, Provider::Guangya, gid, actor)
            .await
            .unwrap()["status"],
        "verifying"
    );
    let exchanges = mock.lock().await.qr_exchanges;
    let deadline: DateTime<Utc> =
        sqlx::query_scalar("SELECT expires_at FROM cloud_login_sessions WHERE id=$1")
            .bind(gid)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert!(
        deadline > Utc::now() + Duration::seconds(100),
        "confirmed authorization needs a bounded verification window beyond QR expiry"
    );
    sqlx::query("UPDATE cloud_login_sessions SET next_poll_at=now() WHERE id=$1")
        .bind(gid)
        .execute(&pool)
        .await
        .unwrap();
    mock.lock().await.directory_failure = false;
    poll_provider_once(&state, Some(Provider::Guangya))
        .await
        .unwrap();
    assert_eq!(
        mock.lock().await.qr_exchanges,
        exchanges,
        "verification retry must not redeem the code twice"
    );
    assert_eq!(
        sqlx::query_scalar::<_, DateTime<Utc>>(
            "SELECT expires_at FROM cloud_login_sessions WHERE id=$1"
        )
        .bind(gid)
        .fetch_one(&pool)
        .await
        .unwrap(),
        deadline,
        "verification window must not slide on retries"
    );
    assert_eq!(
        session(&state, Provider::Guangya, gid, actor)
            .await
            .unwrap()["status"],
        "connected"
    );

    let login = start_login(&state, Provider::Quark, actor, "connect", 0)
        .await
        .unwrap();
    let qid = Uuid::parse_str(login["id"].as_str().unwrap()).unwrap();
    let bid = Uuid::new_v4();
    let context = serde_json::to_string(&baidu).unwrap();
    sqlx::query("INSERT INTO cloud_login_sessions(id,actor_id,provider,intent,expected_epoch,status,context_json,expires_at) VALUES($1,$2,'baidu','connect',0,'waiting',$3,now()+interval '5 minutes')").bind(bid).bind(actor).bind(context).execute(&pool).await.unwrap();
    {
        let mut m = mock.lock().await;
        m.baidu_long_poll = true;
        m.baidu_calls = 0;
    }
    let worker_state = state.clone();
    let worker = tokio::spawn(async move { super::worker(worker_state).await.unwrap() });
    tokio::time::timeout(std::time::Duration::from_secs(1), async {
        loop {
            let m = mock.lock().await;
            if m.baidu_calls > 0 && m.quark_poll_calls > 0 {
                break;
            }
            drop(m);
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    mock.lock().await.quark_scan_confirmed = true;
    // Quark's own loop must confirm on its own cadence: session interval plus the
    // worker's inter-poll sleep stays well under this window, while a shared
    // batch loop would additionally inherit Baidu's 4s long poll.
    tokio::time::timeout(std::time::Duration::from_secs(7), async {
        loop {
            if session(&state, Provider::Quark, qid, actor).await.unwrap()["status"] == "connected"
            {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("a pending Baidu poll blocked Quark's next poll");
    state.shutdown.cancel();
    worker.await.unwrap();
    server.abort();
}

#[tokio::test]
#[ignore = "requires isolated _test PostgreSQL and Redis"]
async fn plaintext_bindings_refresh_sessions_and_ownership_are_fenced() {
    use axum::{
        body::{Body, to_bytes},
        http::{Request, StatusCode},
        routing::any,
    };
    use tower::ServiceExt;
    let url = std::env::var("PANSOU_TEST_DATABASE_URL").unwrap();
    assert!(url::Url::parse(&url).unwrap().path().ends_with("_test"));
    let redis_url = std::env::var("PANSOU_TEST_REDIS_URL").unwrap();
    assert_ne!(url::Url::parse(&redis_url).unwrap().path(), "/0");
    let pool = sqlx::postgres::PgPoolOptions::new()
        .max_connections(12)
        .connect(&url)
        .await
        .unwrap();
    crate::db::init_db(&pool).await.unwrap();
    let mock = Arc::new(tokio::sync::Mutex::new(MockAuth::default()));
    let server = axum::Router::new()
        .fallback(any(upstream))
        .with_state(mock.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}/", listener.local_addr().unwrap());
    let server = tokio::spawn(async move { axum::serve(listener, server).await.unwrap() });
    let redis = crate::redis_store::RedisStore::connect(&redis_url)
        .await
        .unwrap();
    let mut state = AppState::new(pool.clone(), redis);
    state.cloud_auth_test_base = Some(base.clone());
    let drive = url::Url::parse(&format!("{base}drive/")).unwrap();
    state.cloud_test_bases = Some(cloud_drive::TestBases {
        baidu: drive.clone(),
        quark_pc: drive.clone(),
        quark_share: drive,
    });
    let state = Arc::new(state);
    let router = crate::app::build_router(state.clone());
    let unique = Uuid::new_v4().simple().to_string();
    let username = format!("auth_{unique}");
    let actor:i64=sqlx::query_scalar("INSERT INTO users(username,username_normalized,password_hash,role) VALUES($1,$1,$2,'admin') RETURNING id").bind(&username).bind(crate::auth::hash_password(&unique).unwrap()).fetch_one(&pool).await.unwrap();
    let login = state.auth().login(&username, &unique).await.unwrap().0;
    let response = router
        .clone()
        .oneshot(
            Request::builder()
                .uri("/api/admin/cloud-accounts")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    assert_eq!(response.headers()["cache-control"], "private, no-store");
    let headers = {
        let mut h = axum::http::HeaderMap::new();
        h.insert(
            "authorization",
            format!("Bearer {}", login.token).parse().unwrap(),
        );
        h
    };
    let response = router
        .clone()
        .oneshot({
            let mut r = Request::builder()
                .uri("/api/admin/cloud-accounts")
                .body(Body::empty())
                .unwrap();
            *r.headers_mut() = headers.clone();
            r
        })
        .await
        .unwrap();
    let response: Value =
        serde_json::from_slice(&to_bytes(response.into_body(), 65536).await.unwrap()).unwrap();
    assert_eq!(response["data"]["items"].as_array().unwrap().len(), 5);

    // A verified legacy identity adopts only its own artifacts.
    sqlx::query("INSERT INTO cloud_account_settings(provider,credential) VALUES('quark','__puus=legacy-cookie') ON CONFLICT(provider) DO UPDATE SET credential=excluded.credential,account_key=NULL").execute(&pool).await.unwrap();
    let legacy = cloud_drive::credential_fingerprint(Provider::Quark, "__puus=legacy-cookie");
    let link = Uuid::new_v4();
    let cache = Uuid::new_v4();
    sqlx::query("INSERT INTO resource_links(id,provider,identity,original_url,input_fingerprint) VALUES($1,'quark',$2,'https://pan.quark.cn/s/auth-fixture',$2)").bind(link).bind(&unique).execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO link_share_cache(id,link_id,input_version,target_account_key,account_revision,policy_revision,target_dir,state,retention_seconds,cleanup_after,ownership_manifest_json) VALUES($1,$2,1,$3,1,1,'project','saved',60,now()-interval '1 minute',$4)").bind(cache).bind(link).bind(&legacy).bind(json!({"account":legacy})).execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO link_cleanup_jobs(share_cache_id,status,last_error_code,run_after,attempts) VALUES($1,'blocked','waiting_auth',now(),2)").bind(cache).execute(&pool).await.unwrap();
    check(&state, Provider::Quark).await.unwrap();
    let q = stored(&state, Provider::Quark).await.unwrap().unwrap();
    assert!(q.credential.contains("__puus=rotated-cookie-"));
    assert_eq!(q.auth_status, "ready");
    let key = q.account_key.clone().unwrap();
    assert_eq!(
        Drive::load(&state, Provider::Quark).await.unwrap().account,
        key
    );
    let cache_row = sqlx::query(
        "SELECT target_account_key,ownership_manifest_json FROM link_share_cache WHERE id=$1",
    )
    .bind(cache)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(cache_row.get::<String, _>("target_account_key"), key);
    assert_eq!(
        cache_row.get::<Value, _>("ownership_manifest_json")["account"],
        key
    );
    let job = sqlx::query("SELECT status,attempts FROM link_cleanup_jobs WHERE share_cache_id=$1")
        .bind(cache)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(job.get::<String, _>("status"), "queued");
    assert_eq!(job.get::<i32, _>("attempts"), 2);
    let epoch = q.binding_epoch;
    assert!(matches!(
        import(
            &state,
            Provider::Quark,
            "__puus=account_two",
            "reauthorize",
            epoch
        )
        .await,
        Err(ApiError::Conflict(_))
    ));
    assert_eq!(
        stored(&state, Provider::Quark)
            .await
            .unwrap()
            .unwrap()
            .account_key
            .as_deref(),
        Some(key.as_str())
    );
    // Cookie response persistence changes the secret version but not identity.
    let drive = Drive::load(&state, Provider::Quark).await.unwrap();
    drive.list("0").await.unwrap();
    let rotated = stored(&state, Provider::Quark).await.unwrap().unwrap();
    assert_eq!(rotated.binding_epoch, epoch);
    assert!(rotated.token_revision > q.token_revision);
    assert!(rotated.credential.contains("rotated-cookie"));
    let stale = rotated.token_revision;
    import(
        &state,
        Provider::Quark,
        "__puus=account_two",
        "replace",
        epoch,
    )
    .await
    .unwrap();
    assert_ne!(
        stored(&state, Provider::Quark)
            .await
            .unwrap()
            .unwrap()
            .account_key
            .as_deref(),
        Some(key.as_str())
    );
    assert!(
        persist_cookies(
            &pool,
            Provider::Quark,
            epoch,
            stale,
            &["__puus=stale".into()]
        )
        .await
        .unwrap()
        .is_none()
    );

    // All token providers verify the official identity and directory, not supplied IDs.
    for p in [Provider::Aliyun, Provider::Xunlei, Provider::Guangya] {
        let raw=json!({"access_token":"fixture-access","refresh_token":"fixture-refresh","device_id":"fixture-device","captcha_token":"fixture-captcha","client_id":if p==Provider::Xunlei{"fixture-client"}else{"aMe-8VSlkrbQXpUR"},"expire_time":(Utc::now()+Duration::hours(2)).to_rfc3339()}).to_string();
        import(&state, p, &raw, "connect", 0).await.unwrap();
        let old = stored(&state, p).await.unwrap().unwrap();
        assert_eq!(old.auth_status, "ready");
        assert!(old.refreshable);
        assert!(old.credential.contains("subject1"));
        let subject_key = old.account_key.clone();
        let oldepoch = old.binding_epoch;
        sqlx::query("UPDATE cloud_account_settings SET next_check_at=now() WHERE provider=$1")
            .bind(p.name())
            .execute(&pool)
            .await
            .unwrap();
        let (a, b) = tokio::join!(maintain(&state, p), maintain(&state, p));
        a.unwrap();
        b.unwrap();
        let new = stored(&state, p).await.unwrap().unwrap();
        assert_eq!(new.account_key, subject_key);
        assert_eq!(new.binding_epoch, oldepoch);
        assert_eq!(new.token_revision, old.token_revision + 1);
        assert!(new.credential.contains("refresh-"));
        assert!(
            list(&state)
                .await
                .unwrap()
                .to_string()
                .find("fixture-access")
                .is_none()
        );
    }
    assert_eq!(
        mock.lock().await.refreshes,
        3,
        "one refresh per provider despite concurrent calls"
    );

    // A rotated token is durably staged when directory validation temporarily fails.
    let before = stored(&state, Provider::Guangya).await.unwrap().unwrap();
    sqlx::query("UPDATE cloud_account_settings SET next_check_at=now() WHERE provider='guangya'")
        .execute(&pool)
        .await
        .unwrap();
    mock.lock().await.directory_failure = true;
    assert!(maintain(&state, Provider::Guangya).await.is_err());
    let pending = stored(&state, Provider::Guangya).await.unwrap().unwrap();
    assert!(pending.pending_refresh_credential.is_some());
    assert_eq!(pending.token_revision, before.token_revision);
    let count = mock.lock().await.refreshes;
    mock.lock().await.directory_failure = false;
    maintain(&state, Provider::Guangya).await.unwrap();
    assert_eq!(
        mock.lock().await.refreshes,
        count,
        "retry validation without reusing old refresh token"
    );
    assert!(
        stored(&state, Provider::Guangya)
            .await
            .unwrap()
            .unwrap()
            .pending_refresh_credential
            .is_none()
    );
    sqlx::query("UPDATE cloud_account_settings SET refresh_started_at=now()-interval '10 minutes',refresh_lease=$1,refresh_lease_until=now()-interval '1 minute' WHERE provider='guangya'").bind(Uuid::new_v4()).execute(&pool).await.unwrap();
    maintain(&state, Provider::Guangya).await.unwrap();
    assert_eq!(mock.lock().await.refreshes, count);
    assert_eq!(
        stored(&state, Provider::Guangya)
            .await
            .unwrap()
            .unwrap()
            .auth_status,
        "reauthorization_required"
    );

    // Cancel and binding epoch checks fence a late QR result. Actor ownership is private.
    let q = stored(&state, Provider::Quark).await.unwrap().unwrap();
    let first = start_login(
        &state,
        Provider::Quark,
        actor,
        "reauthorize",
        q.binding_epoch,
    )
    .await
    .unwrap();
    let id = Uuid::parse_str(first["id"].as_str().unwrap()).unwrap();
    assert!(!first.to_string().contains("fixture-qr"));
    assert!(
        session(&state, Provider::Quark, id, actor + 1)
            .await
            .is_err()
    );
    cancel(&state, Provider::Quark, id, actor).await.unwrap();
    poll_once(&state).await.unwrap();
    assert_eq!(
        session(&state, Provider::Quark, id, actor).await.unwrap()["status"],
        "cancelled"
    );
    // Complete the actual CAS -> ticket -> Set-Cookie -> /account/info chain.
    // The account endpoint has success/code, not CAS's status=2000000.
    let before = stored(&state, Provider::Quark).await.unwrap().unwrap();
    let qr = start_login(
        &state,
        Provider::Quark,
        actor,
        "replace",
        before.binding_epoch,
    )
    .await
    .unwrap();
    let qr_id = Uuid::parse_str(qr["id"].as_str().unwrap()).unwrap();
    mock.lock().await.quark_scan_confirmed = true;
    poll_once(&state).await.unwrap();
    mock.lock().await.quark_scan_confirmed = false;
    assert_eq!(
        session(&state, Provider::Quark, qr_id, actor)
            .await
            .unwrap()["status"],
        "connected"
    );
    let connected = stored(&state, Provider::Quark).await.unwrap().unwrap();
    assert!(connected.credential.contains("__puus=rotated-cookie"));
    assert_eq!(
        connected.account_key,
        Some(providers::stable_key(Provider::Quark, "subject1", ""))
    );
    assert_eq!(connected.binding_epoch, before.binding_epoch + 1);
    assert!(matches!(
        providers::identity(&state, Provider::Quark, "ctoken=anonymous").await,
        Err(AuthFailure::Reauthorize)
    ));
    // A confirmed scan whose redirect chain never establishes a pan session must
    // fail at the exchange stage instead of storing a credential that later
    // verifies as anonymous.
    let before = stored(&state, Provider::Quark).await.unwrap().unwrap();
    let broken = start_login(
        &state,
        Provider::Quark,
        actor,
        "replace",
        before.binding_epoch,
    )
    .await
    .unwrap();
    let broken_id = Uuid::parse_str(broken["id"].as_str().unwrap()).unwrap();
    mock.lock().await.quark_scan_confirmed = true;
    mock.lock().await.quark_broken_session = true;
    poll_once(&state).await.unwrap();
    mock.lock().await.quark_scan_confirmed = false;
    mock.lock().await.quark_broken_session = false;
    let failed = session(&state, Provider::Quark, broken_id, actor)
        .await
        .unwrap();
    assert_eq!(failed["status"], "failed");
    assert_eq!(
        failed["errorCode"],
        "token_exchange:reauthorization_required"
    );
    let untouched = stored(&state, Provider::Quark).await.unwrap().unwrap();
    assert_eq!(untouched.token_revision, before.token_revision);
    assert_eq!(untouched.auth_status, before.auth_status);
    let g = stored(&state, Provider::Guangya).await.unwrap().unwrap();
    // A real 501 must identify the identity protocol stage, stop retrying,
    // scrub the failed login ticket and leave the prior binding untouched.
    let rejected = start_login(
        &state,
        Provider::Guangya,
        actor,
        "reauthorize",
        g.binding_epoch,
    )
    .await
    .unwrap();
    let rejected_id = Uuid::parse_str(rejected["id"].as_str().unwrap()).unwrap();
    mock.lock().await.identity_protocol_failure = true;
    poll_once(&state).await.unwrap();
    mock.lock().await.identity_protocol_failure = false;
    let rejected = session(&state, Provider::Guangya, rejected_id, actor)
        .await
        .unwrap();
    assert_eq!(rejected["status"], "failed");
    assert_eq!(
        rejected["errorCode"],
        "account_identity:provider_protocol_error"
    );
    assert!(!rejected.to_string().contains("fixture-sensitive-body"));
    assert!(
        sqlx::query_scalar::<_, bool>(
            "SELECT context_json IS NULL AND qr_image IS NULL FROM cloud_login_sessions WHERE id=$1"
        )
        .bind(rejected_id)
        .fetch_one(&pool)
        .await
        .unwrap()
    );
    assert_eq!(
        stored(&state, Provider::Guangya)
            .await
            .unwrap()
            .unwrap()
            .token_revision,
        g.token_revision
    );
    let qr = start_login(
        &state,
        Provider::Guangya,
        actor,
        "reauthorize",
        g.binding_epoch,
    )
    .await
    .unwrap();
    let id = Uuid::parse_str(qr["id"].as_str().unwrap()).unwrap();
    poll_once(&state).await.unwrap();
    assert_eq!(
        session(&state, Provider::Guangya, id, actor).await.unwrap()["status"],
        "connected"
    );
    assert_eq!(
        stored(&state, Provider::Guangya)
            .await
            .unwrap()
            .unwrap()
            .binding_epoch,
        g.binding_epoch
    );
    let g = stored(&state, Provider::Guangya).await.unwrap().unwrap();
    let qr = start_login(
        &state,
        Provider::Guangya,
        actor,
        "reauthorize",
        g.binding_epoch,
    )
    .await
    .unwrap();
    let id = Uuid::parse_str(qr["id"].as_str().unwrap()).unwrap();
    disconnect(&state, Provider::Guangya, g.binding_epoch)
        .await
        .unwrap();
    poll_once(&state).await.unwrap();
    assert_eq!(
        session(&state, Provider::Guangya, id, actor).await.unwrap()["status"],
        "cancelled"
    );
    assert!(
        stored(&state, Provider::Guangya)
            .await
            .unwrap()
            .unwrap()
            .credential
            .is_empty()
    );
    assert!(
        credentials(&state, Provider::Guangya)
            .await
            .unwrap()
            .is_none()
    );
    assert!(matches!(
        import(&state, Provider::Guangya, "{}", "connect", g.binding_epoch).await,
        Err(ApiError::Conflict(_))
    ));
    // Cleanup our exact fixture records; other test suites may reuse this database.
    sqlx::query("DELETE FROM link_cleanup_jobs WHERE share_cache_id=$1")
        .bind(cache)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("DELETE FROM link_share_cache WHERE id=$1")
        .bind(cache)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("DELETE FROM resource_links WHERE id=$1")
        .bind(link)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("DELETE FROM cloud_login_sessions WHERE actor_id=$1")
        .bind(actor)
        .execute(&pool)
        .await
        .unwrap();
    for p in Provider::ALL {
        let a = stored(&state, p).await.unwrap();
        if let Some(a) = a {
            disconnect(&state, p, a.binding_epoch).await.unwrap();
            sqlx::query("DELETE FROM cloud_account_settings WHERE provider=$1")
                .bind(p.name())
                .execute(&pool)
                .await
                .unwrap();
        }
    }
    sqlx::query("DELETE FROM users WHERE id=$1")
        .bind(actor)
        .execute(&pool)
        .await
        .unwrap();
    server.abort();
}
