use super::*;
use axum::{Json, Router, extract::State, response::IntoResponse, routing::any};

fn provider(provider: Provider) -> Extended {
    let raw = json!({"access_token":"fixture-access","user_id":"fixture-user","drive_id":"fixture-drive","captcha_token":"fixture-captcha"}).to_string();
    Extended::new(
        Wire::new(reqwest::Client::new(), provider, raw.clone()),
        &raw,
    )
}

#[tokio::test]
async fn aliyun_share_uses_an_expiration_accepted_by_the_upstream() {
    async fn create(Json(input): Json<Value>) -> impl IntoResponse {
        let expiration = input["expiration"].as_str().unwrap_or_default();
        // Live upstream responds with HTTP 500 / Exception and "Unable to
        // parse the date" for a timestamp such as ...729930+00:00.
        if expiration.len() != 24
            || !expiration.ends_with('Z')
            || chrono::DateTime::parse_from_rfc3339(expiration).is_err()
        {
            return (
                axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({"code":"Exception","message":"Unable to parse the date"})),
            );
        }
        assert_eq!(input["drive_id"], "fixture-drive");
        assert_eq!(input["file_id_list"], json!(["fixture-file"]));
        let expires = chrono::DateTime::parse_from_rfc3339(expiration)
            .unwrap()
            .with_timezone(&chrono::Utc);
        assert!(
            (expires - chrono::Utc::now() - chrono::Duration::days(1))
                .num_seconds()
                .abs()
                < 5
        );
        (
            axum::http::StatusCode::OK,
            Json(
                json!({"share_id":"fixture-share","share_url":"https://www.alipan.com/s/fixture-share"}),
            ),
        )
    }
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let mut drive = provider(Provider::Aliyun);
    drive.base = Url::parse(&format!("http://{}/", listener.local_addr().unwrap())).unwrap();
    let server = tokio::spawn(async move {
        axum::serve(listener, Router::new().fallback(any(create)))
            .await
            .unwrap()
    });
    let file = drive
        .file(&json!({"file_id":"fixture-file","name":"movie.mp4","type":"file","size":42}))
        .unwrap();
    let share = drive.share(&[file], 1).await.unwrap();
    assert_eq!(share["url"], "https://www.alipan.com/s/fixture-share");
    server.abort();
}

#[tokio::test]
async fn guangya_share_requests_no_code_and_preserves_returned_codes_in_url() {
    async fn create(State(data): State<Value>, Json(input): Json<Value>) -> Json<Value> {
        assert_eq!(input["shareType"], 0, "random codes use shareType=1");
        assert_eq!(input["autoFillCode"], false);
        assert_eq!(input["code"], "");
        assert_eq!(input["validateDuration"], 7 * 24 * 3600);
        assert_eq!(input["fileIds"], json!(["fixture-file"]));
        Json(json!({"data":data,"msg":"success"}))
    }
    let base = "https://www.guangyapan.com/s/1953404474227400751_aeXCPJwocgzRgD8m";
    for (suffix, code) in [("", ""), ("?code=ewcc", "ewcc")] {
        let data = json!({"shareId":"1953404474227400751","shareUrl":format!("{base}{suffix}")});
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let mut drive = provider(Provider::Guangya);
        drive.base = Url::parse(&format!("http://{}/", listener.local_addr().unwrap())).unwrap();
        let app = Router::new().fallback(any(create)).with_state(data);
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let file = drive
            .file(&json!({"id":"fixture-file","name":"movie.mp4","type":"file","size":42}))
            .unwrap();
        let share = drive.share(&[file], 7).await.unwrap();
        assert_eq!(share["shareId"], "1953404474227400751");
        assert_eq!(share["password"], code);
        assert_eq!(
            share["url"],
            if code.is_empty() {
                format!("{base}#/share")
            } else {
                format!("{base}?code={code}#/share")
            }
        );
        server.abort();
    }
}

#[test]
fn guangya_share_id_prefix_belongs_to_the_link_key() {
    // Captured live: shareId "1953326881503436886" with the share URL
    // .../s/1953326881503436886_aeXCPJwocgzRgD8m?code=bmwv.
    assert!(share_id_matches(
        Provider::Guangya,
        "1953326881503436886",
        "1953326881503436886_aeXCPJwocgzRgD8m"
    ));
    assert!(!share_id_matches(
        Provider::Guangya,
        "1953326881503436887",
        "1953326881503436886_aeXCPJwocgzRgD8m"
    ));
    // A bare prefix without the id/suffix separator is still a mismatch,
    // and other providers stay strict.
    assert!(!share_id_matches(
        Provider::Guangya,
        "1953326881503436886",
        "19533268815034368865_extra"
    ));
    assert!(!share_id_matches(
        Provider::Aliyun,
        "1953326881503436886",
        "1953326881503436886_aeXCPJwocgzRgD8m"
    ));
    assert!(share_id_matches(Provider::Aliyun, "abc", "abc"));
}

#[test]
fn guangya_empty_directory_is_an_empty_listing_not_a_failure() {
    // Captured from userres/v1/file/get_file_list on 2026-10-03: an empty
    // directory answers {"msg":"success","data":{}} with no list field.
    let drive = provider(Provider::Guangya);
    assert!(
        drive
            .array(&json!({"msg":"success","data":{}}))
            .unwrap()
            .is_empty()
    );
    // A non-empty listing keeps its entries, and the shape that broke the
    // delivery before stays parseable.
    let root = json!({"msg":"success","data":{"total":1,"list":[
        {"fileId":"1953187127336075337","fileName":"__PANSOU__","depth":1,"dirType":1,"resType":2}
    ]}});
    assert_eq!(drive.array(&root).unwrap().len(), 1);
    // Anything else without a list field still fails closed, for guangya
    // only when the envelope is not a success.
    assert!(drive.array(&json!({"msg":"出错了","data":{}})).is_err());
    assert!(drive.array(&json!({"data":{}})).is_err());
    for other in [Provider::Aliyun, Provider::Xunlei] {
        assert!(
            provider(other)
                .array(&json!({"msg":"success","data":{}}))
                .is_err()
        );
    }
}

#[tokio::test]
async fn short_tasks_are_confirmed_without_whole_second_polling_gaps() {
    async fn status(
        State(calls): State<std::sync::Arc<std::sync::atomic::AtomicUsize>>,
    ) -> Json<Value> {
        let count = calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        Json(json!({"code":0,"data":{"status":if count < 2 {1} else {2}}}))
    }
    let calls = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let mut drive = provider(Provider::Guangya);
    drive.base = Url::parse(&format!("http://{}/", listener.local_addr().unwrap())).unwrap();
    let app = Router::new()
        .fallback(any(status))
        .with_state(calls.clone());
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let started = std::time::Instant::now();
    drive.wait_task("fixture-task").await.unwrap();
    assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 3);
    assert!(
        started.elapsed() < Duration::from_millis(1800),
        "short task waited {:?}",
        started.elapsed()
    );
    server.abort();
}

#[tokio::test]
async fn guangya_identity_uses_get_and_rejects_wrong_account() {
    async fn identity(request: axum::http::Request<axum::body::Body>) -> axum::response::Response {
        assert_eq!(request.uri().path(), "/v1/user/me");
        assert_eq!(request.headers()["authorization"], "Bearer fixture-access");
        if request.method() != Method::GET {
            return (
                axum::http::StatusCode::NOT_IMPLEMENTED,
                Json(json!({"error":"unimplemented"})),
            )
                .into_response();
        }
        Json(json!({"sub":"fixture-user"})).into_response()
    }
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let mut drive = provider(Provider::Guangya);
    drive.account_base =
        Url::parse(&format!("http://{}/", listener.local_addr().unwrap())).unwrap();
    let app = Router::new().fallback(any(identity));
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    drive.verify_account().await.unwrap();
    drive.user_id = "wrong-account".into();
    assert_eq!(
        drive.verify_account().await.unwrap_err().kind,
        ErrorKind::Ownership
    );
    server.abort();
}

#[test]
fn transferred_files_must_match_each_source_once() {
    let file = |id: &str, name: &str| File {
        id: id.into(),
        name: name.into(),
        size: 42,
        is_dir: false,
        md5: String::new(),
        path: String::new(),
        token: String::new(),
    };
    let source = vec![file("s1", "a.mp4"), file("s2", "b.mp4")];
    assert!(!matches_transferred_files(
        &source,
        &[file("t1", "a.mp4"), file("t2", "a.mp4")]
    ));
    assert!(matches_transferred_files(
        &source,
        &[file("t2", "b.mp4"), file("t1", "a.mp4")]
    ));
    let mut wrong = file("t1", "a.mp4");
    wrong.size = 0;
    assert!(!matches_transferred_files(&[source[0].clone()], &[wrong]));
}

#[test]
fn missing_file_metadata_is_not_assumed_to_be_an_empty_file() {
    for p in [Provider::Aliyun, Provider::Xunlei, Provider::Guangya] {
        let drive = provider(p);
        assert!(
            drive
                .file(&json!({"id":"file","name":"movie","type":"file","size":"42"}))
                .is_ok()
        );
        assert!(
            drive
                .file(&json!({"id":"dir","name":"folder","type":"folder"}))
                .unwrap()
                .is_dir
        );
        for item in [
            json!({"id":"file","name":"movie","type":"file"}),
            json!({"id":"file","name":"movie","size":0}),
            json!({"id":"file","name":"movie","type":"file","size":-1}),
        ] {
            assert!(drive.file(&item).is_err());
        }
    }
}

async fn mock(
    State(value): State<Value>,
    headers: axum::http::HeaderMap,
) -> axum::response::Response {
    assert_eq!(
        headers.get("authorization").unwrap(),
        "Bearer fixture-access"
    );
    assert!(headers.get("cookie").is_none());
    let mut response = Json(value).into_response();
    response.headers_mut().insert(
        "set-cookie",
        HeaderValue::from_static("upstream_session=fixture; Path=/"),
    );
    response
}

#[tokio::test]
async fn malformed_business_status_fails_closed_and_set_cookie_keeps_token_credentials() {
    for p in [Provider::Aliyun, Provider::Xunlei, Provider::Guangya] {
        for value in [
            json!({"code":0}),
            json!({"code":null}),
            json!({"code":true}),
            json!({"code":""}),
            json!({"code":{}}),
            json!({"code":0,"success":false}),
        ] {
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let mut drive = provider(p);
            drive.base =
                Url::parse(&format!("http://{}/", listener.local_addr().unwrap())).unwrap();
            let success = value == json!({"code":0});
            let app = Router::new().fallback(any(mock)).with_state(value);
            let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
            assert_eq!(
                drive.post("fixture", json!({}), None, false).await.is_ok(),
                success
            );
            // Set-Cookie must not rewrite the stored JSON on any response.
            assert!(drive.wire.require_login().await.is_ok());
            assert_eq!(
                drive.post("fixture", json!({}), None, false).await.is_ok(),
                success
            );
            server.abort();
        }
    }
}
#[tokio::test]
async fn guangya_replies_without_a_business_code_still_need_a_payload() {
    async fn envelope(State(value): State<Value>) -> axum::response::Response {
        Json(value).into_response()
    }
    for (value, accepted) in [
        // The live service answers successful business calls with
        // `{"data":…,"msg":…}` and no `code` at all.
        (
            json!({"data":{"resList":[],"total":0},"msg":"success"}),
            true,
        ),
        (json!({"data":{"taskId":"t"},"msg":"ok"}), true),
        // A `code` envelope stays authoritative when it is present.
        (json!({"code":200,"data":{"resList":[]}}), true),
        (json!({"code":"0","data":{"resList":[]}}), true),
        (json!({"code":117,"msg":"无效token"}), false),
        // A bare status message carries no confirmed result.
        (json!({"msg":"无效token"}), false),
        (json!({"data":null,"msg":"失败"}), false),
    ] {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let mut drive = provider(Provider::Guangya);
        drive.base = Url::parse(&format!("http://{}/", listener.local_addr().unwrap())).unwrap();
        let app = Router::new().fallback(any(envelope)).with_state(value);
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        assert_eq!(
            drive.post("fixture", json!({}), None, false).await.is_ok(),
            accepted
        );
        server.abort();
    }
}

#[tokio::test]
async fn xunlei_captcha_rejections_are_not_misreported_as_retryable_network_failures() {
    async fn captcha(State(status): State<u16>) -> impl IntoResponse {
        (
            axum::http::StatusCode::from_u16(status).unwrap(),
            Json(json!({"error":"captcha_invalid"})),
        )
    }
    for status in [200, 401, 403] {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = Url::parse(&format!("http://{}/", listener.local_addr().unwrap())).unwrap();
        let router = Router::new().fallback(any(captcha)).with_state(status);
        let server = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
        let mut drive = provider(Provider::Xunlei);
        drive.base = base;
        let error = drive
            .call(Method::GET, "drive/v1/files", &[], None, None, false)
            .await
            .unwrap_err();
        assert_eq!(error.kind, ErrorKind::Verification);
        assert!(matches!(
            error.api(),
            crate::error::ApiError::CloudAuthRequired(_)
        ));
        server.abort();
    }
}
