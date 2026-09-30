use super::*;
#[test]
fn strict_share_hosts_and_passwords() {
    let r = ShareInput {
        url: "https://pan.baidu.com/s/1ABC-def?pwd=a1b2".into(),
        provider: None,
        password: None,
    }
    .parse()
    .unwrap();
    assert_eq!(r.key, "ABC-def");
    assert_eq!(r.password, "a1b2");
    for url in [
        "http://127.0.0.1/s/abc",
        "https://pan.quark.cn.evil.test/s/abc",
        "https://evil.test/pan.quark.cn/s/abc",
        "https://user@pan.baidu.com/s/1abc",
        "https://pan.quark.cn:8080/s/abc",
        "https://pan.quark.cn/s/../abc",
        "file:///s/abc",
    ] {
        assert!(
            ShareInput {
                url: url.into(),
                provider: None,
                password: None
            }
            .parse()
            .is_err(),
            "{url}"
        );
    }
}
#[test]
fn save_payload_accepts_flat_wangpan_fields() {
    let v = serde_json::json!({"url":"https://pan.quark.cn/s/abc","toDir":"0","autoShare":true,"dedup":true,"requestKey":uuid::Uuid::new_v4().to_string()});
    let input: SaveInput = serde_json::from_value(v).unwrap();
    assert_eq!(input.to_dir.as_deref(), Some("0"));
}
#[test]
fn hex_quark_ids_and_large_baidu_ids_are_preserved() {
    assert!(valid_id("4208105bd6034246836d3671829d9349", false));
    assert!(!valid_id("0", false));
    assert!(!valid_id("../file", false));
    assert_eq!(scalar(&json!(9007199254740993u64)), "9007199254740993");
}
fn file(id: &str, name: &str, size: u64, dir: bool) -> File {
    File {
        id: id.into(),
        name: name.into(),
        size,
        is_dir: dir,
        md5: String::new(),
        path: String::new(),
        token: String::new(),
    }
}
#[test]
fn partial_dedup_keeps_missing_and_never_reuses_directory_by_zero_size() {
    let files = vec![
        file("a", "a.mp4", 42, false),
        file("b", "b.mp4", 43, false),
        file("dir", "folder", 0, true),
    ];
    let mine = vec![
        file("mine", "a.mp4", 42, false),
        file("own-dir", "folder", 0, true),
    ];
    let (matched, missing) = match_existing(Provider::Quark, &files, &mine);
    assert_eq!(matched.len(), 1);
    assert_eq!(missing.len(), 2);
}
#[test]
fn errors_do_not_mark_login_or_network_as_invalid() {
    for code in [-6, -9, -62, -1] {
        assert_ne!(
            DriveError::from_code(Provider::Baidu, code).kind,
            ErrorKind::InvalidLink
        );
    }
    assert_eq!(
        DriveError::from_code(Provider::Quark, 41008).kind,
        ErrorKind::InvalidLink
    );
}

use axum::{
    Router,
    body::{Body, to_bytes},
    extract::State,
    http::{Request, StatusCode},
    response::{IntoResponse, Response},
    routing::any,
};
use std::sync::Arc;
use tokio::sync::Mutex;
#[derive(Default)]
struct MockData {
    calls: Vec<(String, String, String, String)>,
    mine_q: Vec<File>,
    mine_b: Vec<File>,
    own_share: bool,
    non_owner_entry: bool,
    async_task: bool,
    failed_task: bool,
    business_error: bool,
    changed: bool,
    paginated: bool,
    polls: usize,
}
struct Mock {
    data: Arc<Mutex<MockData>>,
    bases: TestBases,
    server: tokio::task::JoinHandle<()>,
}
impl Drop for Mock {
    fn drop(&mut self) {
        self.server.abort();
    }
}
impl Mock {
    async fn start() -> Self {
        let data = Arc::new(Mutex::new(MockData::default()));
        let app = Router::new()
            .fallback(any(upstream))
            .with_state(data.clone());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = format!("http://{}/", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        Self {
            data,
            bases: TestBases {
                baidu: Url::parse(&origin).unwrap(),
                quark_pc: Url::parse(&(origin.clone() + "qpc/")).unwrap(),
                quark_share: Url::parse(&(origin + "qshare/")).unwrap(),
            },
            server,
        }
    }
    fn drive(&self, p: Provider) -> Drive {
        let mut drive = Drive::new(
            transport::http_client(),
            p,
            "BDUSS=fixture; BAIDUID=fixture; STOKEN=fixture; __puus=fixture".into(),
        );
        drive.baidu.base = self.bases.baidu.clone();
        drive.quark.pc_base = self.bases.quark_pc.clone();
        drive.quark.share_base = self.bases.quark_share.clone();
        drive
    }
}
fn share_input(p: Provider) -> ShareInput {
    ShareInput {
        url: if p == Provider::Quark {
            "https://pan.quark.cn/s/abc?pwd=a1b2"
        } else {
            "https://pan.baidu.com/s/1abc?pwd=a1b2"
        }
        .into(),
        provider: Some(p),
        password: None,
    }
}
fn qfile(id: &str, name: &str, size: u64) -> Value {
    json!({"fid":id,"file_name":name,"size":size,"dir":false,"share_fid_token":"share-fixture"})
}
fn bfile(id: u64, name: &str, size: u64) -> Value {
    json!({"fs_id":id,"server_filename":name,"size":size,"isdir":0,"md5":name,"path":format!("/{name}")})
}
async fn upstream(State(state): State<Arc<Mutex<MockData>>>, request: Request<Body>) -> Response {
    let path = request.uri().path().to_owned();
    let method = request.method().to_string();
    let cookie = request
        .headers()
        .get("cookie")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_owned();
    let url = Url::parse(&format!("http://fixture{}", request.uri())).unwrap();
    let query = url
        .query_pairs()
        .collect::<std::collections::HashMap<_, _>>();
    let bytes = to_bytes(request.into_body(), 2 * 1024 * 1024)
        .await
        .unwrap();
    let body = String::from_utf8(bytes.to_vec()).unwrap();
    let form = url::form_urlencoded::parse(body.as_bytes())
        .map(|(k, v)| (k.into_owned(), v.into_owned()))
        .collect::<std::collections::HashMap<_, _>>();
    let input: Value = serde_json::from_str(&body).unwrap_or(Value::Null);
    let mut mock = state.lock().await;
    mock.calls
        .push((method.clone(), path.clone(), body.clone(), cookie));
    if path == "/redirect" {
        return (StatusCode::FOUND, [("location", "/steal")], "").into_response();
    }
    if path == "/hang" {
        return (
            [("content-type", "application/json")],
            Body::from_stream(
                futures::stream::once(async { Ok::<_, std::io::Error>("{") })
                    .chain(futures::stream::pending()),
            ),
        )
            .into_response();
    }
    if path == "/malformed" {
        return axum::Json(json!({"code":"not-a-number"})).into_response();
    }
    if path == "/nonjson" {
        return "<html>login page</html>".into_response();
    }
    if mock.business_error {
        return axum::Json(if path.starts_with("/q") {
            json!({"code":41008,"message":"should not echo cookie fixture"})
        } else {
            json!({"errno":-9})
        })
        .into_response();
    }
    let payload = match (path.as_str(), method.as_str()) {
        ("/qshare/share/sharepage/token", _) => json!({"code":0,"data":{"stoken":"fixture-token"}}),
        ("/qshare/share/sharepage/detail", _) => {
            let page = query.get("_page").map(|s| s.as_ref()).unwrap_or("1");
            let list = if mock.paginated {
                if page == "1" {
                    (1..=200)
                        .map(|i| qfile(&format!("fid{i}"), &format!("f{i}"), i))
                        .collect()
                } else {
                    vec![qfile("last", "last", 1)]
                }
            } else {
                vec![
                    qfile("a", "a.mp4", 42),
                    qfile("b", if mock.changed { "changed.mp4" } else { "b.mp4" }, 43),
                ]
            };
            json!({"code":0,"data":{"list":list,"share":{"title":"fixture"}}})
        }
        ("/qpc/file/sort", _) => {
            json!({"code":0,"data":{"list":mock.mine_q.iter().map(|f|qfile(&f.id,&f.name,f.size)).collect::<Vec<_>>()}})
        }
        ("/qpc/share/sharepage/save", _) => {
            let ids = input["fid_list"].as_array().unwrap();
            let mut saved = vec![];
            for id in ids {
                let id = id.as_str().unwrap();
                let (name, size) = if id == "a" {
                    ("a.mp4", 42)
                } else {
                    ("b.mp4", 43)
                };
                let new_id = format!("new-{id}");
                mock.mine_q.push(file(&new_id, name, size, false));
                saved.push(new_id);
            }
            if mock.async_task {
                json!({"code":0,"data":{"task_id":"save-task"}})
            } else {
                json!({"code":0,"data":{"task_resp":{"data":{"status":2,"save_as":{"save_as_top_fids":saved}}}}})
            }
        }
        ("/qpc/task", _) => {
            mock.polls += 1;
            json!({"code":0,"data":{"status":if mock.failed_task{3}else if mock.polls==1{1}else{2},"save_as":{"save_as_top_fids":["new-a","new-b"]}},"metadata":{"tq_gap":500}})
        }
        ("/qpc/share", "POST") => json!({"code":0,"data":{"share_id":"own-share"}}),
        ("/qpc/share/mypage/detail", "GET") => {
            assert_eq!(query.get("_page").map(|v| v.as_ref()), Some("1"));
            assert_eq!(query.get("_size").map(|v| v.as_ref()), Some("100"));
            assert_eq!(
                query.get("_order_field").map(|v| v.as_ref()),
                Some("created_at")
            );
            assert_eq!(query.get("_order_type").map(|v| v.as_ref()), Some("desc"));
            json!({"code":0,"data":{"list":if mock.own_share{vec![json!({"pwd_id":"abc","share_id":"own","is_owner":if mock.non_owner_entry {0} else {1}})]}else{vec![json!({"pwd_id":"other"})]}}})
        }
        ("/qpc/share/password", _) => {
            json!({"code":0,"data":{"share_url":"https://pan.quark.cn/s/own-share","share_pwd":"z9x8"}})
        }
        ("/qpc/file/delete", _) => json!({"code":0,"data":{"task_resp":{"data":{"status":2}}}}),
        ("/share/verify", _) => {
            return (
                [("set-cookie", "BDCLND=fixture-sekey; Path=/")],
                axum::Json(json!({"errno":0,"randsk":"fixture%2Bkey"})),
            )
                .into_response();
        }
        ("/s/1abc", _) => {
            return r#"window.yunData={"shareid":"99","share_uk":"2"};"#.into_response();
        }
        ("/share/list", _) => {
            json!({"errno":0,"list":[bfile(9007199254740993,"a.mp4",42),bfile(9007199254740994,"b.mp4",43)]})
        }
        ("/api/gettemplatevariable", _) => {
            json!({"errno":0,"result":{"bdstoken":"fixture-bdstoken","uk":if mock.own_share{2}else{3}}})
        }
        ("/api/list", _) => {
            json!({"errno":0,"list":mock.mine_b.iter().map(|f|bfile(f.id.parse().unwrap(),&f.name,f.size)).collect::<Vec<_>>() })
        }
        ("/share/transfer", _) => {
            let ids: Vec<u64> = serde_json::from_str(form.get("fsidlist").unwrap()).unwrap();
            for id in ids {
                let (name, size) = if id == 9007199254740993 {
                    ("a.mp4", 42)
                } else {
                    ("b.mp4", 43)
                };
                mock.mine_b
                    .push(file(&(id + 10).to_string(), name, size, false));
            }
            json!({"errno":0,"info":[]})
        }
        ("/share/set", _) => {
            json!({"errno":0,"link":"https://pan.baidu.com/s/1mine","shareid":101})
        }
        ("/api/filemanager", _) => json!({"errno":0,"info":[]}),
        _ => {
            return (
                StatusCode::NOT_FOUND,
                axum::Json(json!({"error":"unexpected mocked path"})),
            )
                .into_response();
        }
    };
    axum::Json(payload).into_response()
}
use futures::StreamExt;
#[tokio::test]
async fn quark_sync_transfer_reuses_context_and_shares_only_new_owned_ids() {
    let mock = Mock::start().await;
    let drive = mock.drive(Provider::Quark);
    let link = share_input(Provider::Quark);
    let reference = link.parse().unwrap();
    let input = SaveInput {
        link,
        to_dir: None,
        auto_share: true,
        dedup: false,
        request_key: uuid::Uuid::new_v4().to_string(),
    };
    let result = drive.save(&input, &reference).await.unwrap();
    assert_eq!(result["count"], 2);
    assert_eq!(result["share"]["url"], "https://pan.quark.cn/s/own-share");
    let data = mock.data.lock().await;
    assert_eq!(data.polls, 0);
    assert_eq!(
        data.calls
            .iter()
            .filter(|(_, p, _, _)| p.ends_with("sharepage/token"))
            .count(),
        1
    );
    let share = data
        .calls
        .iter()
        .find(|(m, p, _, _)| m == "POST" && p == "/qpc/share")
        .unwrap();
    let payload: Value = serde_json::from_str(&share.2).unwrap();
    assert_eq!(payload["fid_list"], json!(["new-a", "new-b"]));
    assert!(!result.to_string().contains("fixture-token"));
}
#[tokio::test]
async fn partial_dedup_transfers_missing_files_instead_of_losing_them() {
    for provider in [Provider::Quark, Provider::Baidu] {
        let mock = Mock::start().await;
        {
            let mut data = mock.data.lock().await;
            let own = file(
                if provider == Provider::Quark {
                    "mine-a"
                } else {
                    "100"
                },
                "a.mp4",
                42,
                false,
            );
            if provider == Provider::Quark {
                data.mine_q.push(own);
            } else {
                data.mine_b.push(own);
            }
        }
        let drive = mock.drive(provider);
        let link = share_input(provider);
        let r = link.parse().unwrap();
        let input = SaveInput {
            link,
            to_dir: None,
            auto_share: true,
            dedup: true,
            request_key: uuid::Uuid::new_v4().to_string(),
        };
        let result = drive.save(&input, &r).await.unwrap();
        assert_eq!(result["matchedCount"], 1);
        assert_eq!(result["count"], 1);
        assert!(result["share"].is_object(), "{result}");
        let data = mock.data.lock().await;
        let call = data
            .calls
            .iter()
            .find(|(_, p, _, _)| p.ends_with("sharepage/save") || p == "/share/transfer")
            .unwrap();
        if provider == Provider::Quark {
            assert_eq!(
                serde_json::from_str::<Value>(&call.2).unwrap()["fid_list"],
                json!(["b"])
            );
        } else {
            let form = url::form_urlencoded::parse(call.2.as_bytes())
                .collect::<std::collections::HashMap<_, _>>();
            assert_eq!(&form["fsidlist"], "[9007199254740994]");
        }
    }
}
#[tokio::test]
async fn baidu_updates_share_cookie_and_preserves_numeric_ids() {
    let mock = Mock::start().await;
    let drive = mock.drive(Provider::Baidu);
    let ctx = drive
        .resolve(&share_input(Provider::Baidu).parse().unwrap())
        .await
        .unwrap();
    assert_eq!(ctx.token, "fixture+key");
    assert_eq!(ctx.files[0].id, "9007199254740993");
    assert!(
        mock.data
            .lock()
            .await
            .calls
            .iter()
            .filter(|(_, p, _, _)| p == "/s/1abc")
            .all(|(_, _, _, c)| c.contains("BDCLND=fixture-sekey"))
    );
}
#[tokio::test]
async fn deletion_requires_account_ownership_for_both_providers() {
    for provider in [Provider::Quark, Provider::Baidu] {
        let mock = Mock::start().await;
        let drive = mock.drive(provider);
        let ctx = drive
            .resolve(&share_input(provider).parse().unwrap())
            .await
            .unwrap();
        assert_eq!(
            drive.owned(&ctx).await.unwrap_err().kind,
            ErrorKind::Ownership
        );
        assert!(
            !mock
                .data
                .lock()
                .await
                .calls
                .iter()
                .any(|(_, p, _, _)| p.ends_with("delete") || p == "/api/filemanager")
        );
        mock.data.lock().await.own_share = true;
        let drive = mock.drive(provider);
        let ctx = drive
            .resolve(&share_input(provider).parse().unwrap())
            .await
            .unwrap();
        drive.owned(&ctx).await.unwrap();
        drive.delete_files(&ctx.files).await.unwrap();
        assert_eq!(
            mock.data
                .lock()
                .await
                .calls
                .iter()
                .filter(|(_, p, _, _)| p.ends_with("delete") || p == "/api/filemanager")
                .count(),
            1
        );
    }
}
#[tokio::test]
async fn quark_pagination_and_async_failure_are_not_silently_truncated() {
    let mock = Mock::start().await;
    mock.data.lock().await.paginated = true;
    let drive = mock.drive(Provider::Quark);
    let r = share_input(Provider::Quark).parse().unwrap();
    assert_eq!(drive.resolve(&r).await.unwrap().files.len(), 201);
    {
        let mut data = mock.data.lock().await;
        data.paginated = false;
        data.async_task = true;
    }
    let link = share_input(Provider::Quark);
    let input = SaveInput {
        link,
        to_dir: None,
        auto_share: false,
        dedup: false,
        request_key: uuid::Uuid::new_v4().to_string(),
    };
    assert!(drive.save(&input, &r).await.is_ok());
    assert_eq!(mock.data.lock().await.polls, 2);
    mock.data.lock().await.failed_task = true;
    assert!(drive.save(&input, &r).await.is_err());
}
#[tokio::test]
async fn transport_does_not_follow_redirects_or_hang_on_response_bodies() {
    let mock = Mock::start().await;
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_millis(100))
        .redirect(reqwest::redirect::Policy::none())
        .no_proxy()
        .build()
        .unwrap();
    let wire = transport::Wire::new(client, Provider::Quark, "fixture=secret".into());
    for path in ["redirect", "hang", "malformed", "nonjson"] {
        let start = std::time::Instant::now();
        assert!(
            wire.json(
                reqwest::Method::GET,
                mock.bases.baidu.join(path).unwrap(),
                None,
                None,
                "test",
                false
            )
            .await
            .is_err()
        );
        assert!(start.elapsed() < std::time::Duration::from_secs(2));
    }
    assert!(
        !mock
            .data
            .lock()
            .await
            .calls
            .iter()
            .any(|(_, p, _, _)| p == "/steal")
    );
}

async fn api(
    router: &Router,
    method: &str,
    path: &str,
    token: Option<&str>,
    payload: Value,
) -> (StatusCode, Value) {
    use tower::ServiceExt;
    let mut request = Request::builder()
        .method(method)
        .uri(path)
        .header("content-type", "application/json");
    if let Some(token) = token {
        request = request.header("authorization", format!("Bearer {token}"));
    }
    let mut request = request.body(Body::from(payload.to_string())).unwrap();
    request.extensions_mut().insert(axum::extract::ConnectInfo(
        "127.0.0.1:43210".parse::<std::net::SocketAddr>().unwrap(),
    ));
    let reply = router.clone().oneshot(request).await.unwrap();
    let status = reply.status();
    let data = to_bytes(reply.into_body(), 4 * 1024 * 1024).await.unwrap();
    (status, serde_json::from_slice(&data).unwrap())
}
#[tokio::test]
#[ignore = "requires isolated PANSOU_TEST_DATABASE_URL ending _test and PANSOU_TEST_REDIS_URL"]
async fn native_cloud_routes_contracts_and_durable_idempotency() {
    use crate::{
        app::{AppState, build_router},
        auth, db,
        redis_store::RedisStore,
    };
    use sqlx::Row;
    let url = std::env::var("PANSOU_TEST_DATABASE_URL").expect("isolated test database");
    assert!(
        Url::parse(&url).unwrap().path().ends_with("_test"),
        "refuse non-test database"
    );
    let pool = sqlx::postgres::PgPoolOptions::new()
        .max_connections(8)
        .connect(&url)
        .await
        .unwrap();
    db::init_db(&pool).await.unwrap();
    let redis = RedisStore::connect(&std::env::var("PANSOU_TEST_REDIS_URL").expect("test Redis"))
        .await
        .unwrap();
    let mock = Mock::start().await;
    let mut state = AppState::new(pool.clone(), redis);
    state.cloud_test_bases = Some(mock.bases.clone());
    let state = Arc::new(state);
    let router = build_router(state.clone());
    let unique = uuid::Uuid::new_v4().simple().to_string();
    let username = format!("cloud_{unique}");
    sqlx::query("INSERT INTO users(username,username_normalized,password_hash,role) VALUES($1,$1,$2,'admin')").bind(&username).bind(auth::hash_password(&unique).unwrap()).execute(&pool).await.unwrap();
    let session = state.auth().login(&username, &unique).await.unwrap().0;
    let token = Some(session.token.as_str());
    let previous=sqlx::query("SELECT provider,credential FROM cloud_account_settings WHERE provider IN ('baidu','quark')").fetch_all(&pool).await.unwrap().into_iter().map(|r|(r.get::<String,_>("provider"),r.get::<String,_>("credential"))).collect::<Vec<_>>();
    for path in [
        "check",
        "save",
        "existing",
        "list",
        "ping",
        "delete-preview",
        "delete",
    ] {
        assert_eq!(
            api(
                &router,
                "POST",
                &format!("/api/admin/cloud-drive/{path}"),
                None,
                json!({})
            )
            .await
            .0,
            StatusCode::UNAUTHORIZED
        );
    }
    for provider in ["quark", "baidu"] {
        let cookie = if provider == "baidu" {
            "BDUSS=fixture; BAIDUID=fixture; STOKEN=fixture"
        } else {
            "__puus=fixture"
        };
        let path = format!("/api/settings/{provider}");
        assert_eq!(
            api(&router, "PUT", &path, token, json!({"cookie":cookie}))
                .await
                .0,
            StatusCode::OK
        );
        let before = api(&router, "GET", &path, token, Value::Null).await.1;
        assert!(before["data"]["configured"].as_bool().unwrap());
        assert!(before["data"].get("cookie").is_none());
        assert!(!before.to_string().contains("fixture"));
        assert_eq!(
            api(&router, "PUT", &path, token, json!({"cookie":""}))
                .await
                .1,
            before
        );
    }
    assert_eq!(
        api(
            &router,
            "PUT",
            "/api/settings/baidu",
            token,
            json!({"cookie":"BDUSS=x\r\nHost: evil"})
        )
        .await
        .0,
        StatusCode::BAD_REQUEST
    );
    let bad = api(
        &router,
        "POST",
        "/api/admin/cloud-drive/check",
        token,
        json!({"url":"http://127.0.0.1/private"}),
    )
    .await;
    assert_eq!(bad.0, StatusCode::BAD_REQUEST);
    for provider in [Provider::Quark, Provider::Baidu] {
        let link = share_input(provider);
        let response = api(
            &router,
            "POST",
            "/api/admin/cloud-drive/check",
            token,
            json!(link),
        )
        .await;
        assert_eq!(response.0, StatusCode::OK, "{}", response.1);
        assert_eq!(response.1["data"]["status"], "valid");
        assert!(!response.1.to_string().contains("fixture-token"));
        assert!(!response.1.to_string().contains("fixture-bdstoken"));
    }
    // Model the account switch between credential load and acquisition of the write lock.
    let stale_drive = Drive::load(&state, Provider::Quark).await.unwrap();
    assert_eq!(
        api(
            &router,
            "PUT",
            "/api/settings/quark",
            token,
            json!({"cookie":"__puus=fixture-switched"})
        )
        .await
        .0,
        StatusCode::OK
    );
    let mut tx = pool.begin().await.unwrap();
    let locked: bool =
        sqlx::query_scalar("SELECT pg_try_advisory_xact_lock(hashtextextended($1,0))")
            .bind("pansou:cloud-write:quark")
            .fetch_one(&mut *tx)
            .await
            .unwrap();
    assert!(locked);
    assert_eq!(
        stale_drive
            .ensure_current_account(&mut tx)
            .await
            .unwrap_err()
            .status(),
        StatusCode::CONFLICT
    );
    assert!(!stale_drive.wrote());
    tx.rollback().await.unwrap();
    assert_eq!(
        api(
            &router,
            "PUT",
            "/api/settings/quark",
            token,
            json!({"cookie":"__puus=fixture"})
        )
        .await
        .0,
        StatusCode::OK
    );
    // Same durable key, even concurrent: exactly one upstream save.
    let key = uuid::Uuid::new_v4();
    let save = json!({"url":"https://pan.quark.cn/s/abc","autoShare":false,"dedup":false,"requestKey":key});
    let before_save = mock
        .data
        .lock()
        .await
        .calls
        .iter()
        .filter(|(_, p, _, _)| p.ends_with("sharepage/save"))
        .count();
    let (first, second) = tokio::join!(
        api(
            &router,
            "POST",
            "/api/admin/cloud-drive/save",
            token,
            save.clone()
        ),
        api(
            &router,
            "POST",
            "/api/admin/cloud-drive/save",
            token,
            save.clone()
        )
    );
    assert!(
        first.0 == StatusCode::OK || first.0 == StatusCode::ACCEPTED,
        "{}",
        first.1
    );
    let first = if first.0 == StatusCode::OK {
        first
    } else {
        api(
            &router,
            "GET",
            &format!("/api/admin/cloud-drive/operations/{key}"),
            token,
            Value::Null,
        )
        .await
    };
    assert_eq!(first.0, StatusCode::OK);
    assert!(second.0 == StatusCode::OK || second.0 == StatusCode::ACCEPTED);
    assert_eq!(
        mock.data
            .lock()
            .await
            .calls
            .iter()
            .filter(|(_, p, _, _)| p.ends_with("sharepage/save"))
            .count(),
        before_save + 1
    );
    let repeated = api(
        &router,
        "POST",
        "/api/admin/cloud-drive/save",
        token,
        save.clone(),
    )
    .await;
    assert_eq!(repeated.0, StatusCode::OK);
    assert_eq!(repeated.1, first.1);
    let altered = json!({"url":"https://pan.quark.cn/s/abc","autoShare":true,"requestKey":key});
    assert_eq!(
        api(
            &router,
            "POST",
            "/api/admin/cloud-drive/save",
            token,
            altered
        )
        .await
        .0,
        StatusCode::CONFLICT
    );
    assert_eq!(
        api(
            &router,
            "GET",
            &format!("/api/admin/cloud-drive/operations/{key}"),
            token,
            Value::Null
        )
        .await
        .1,
        first.1
    );
    let restarted_router = build_router(state.clone());
    assert_eq!(
        api(
            &restarted_router,
            "POST",
            "/api/admin/cloud-drive/save",
            token,
            save
        )
        .await
        .1,
        first.1
    );
    // Another administrator cannot query this actor's operation.
    let other_name = format!("cloud_other_{unique}");
    sqlx::query("INSERT INTO users(username,username_normalized,password_hash,role) VALUES($1,$1,$2,'admin')").bind(&other_name).bind(auth::hash_password(&unique).unwrap()).execute(&pool).await.unwrap();
    let other = state.auth().login(&other_name, &unique).await.unwrap().0;
    assert_eq!(
        api(
            &router,
            "GET",
            &format!("/api/admin/cloud-drive/operations/{key}"),
            Some(&other.token),
            Value::Null
        )
        .await
        .0,
        StatusCode::NOT_FOUND
    );
    // Read-only existing check never creates a share; explicit autoShare uses the same mutation guard.
    assert_eq!(
        api(
            &router,
            "POST",
            "/api/admin/cloud-drive/existing",
            token,
            json!({"url":"https://pan.quark.cn/s/abc","autoShare":false})
        )
        .await
        .0,
        StatusCode::OK
    );
    let id = format!("cloud_resource_{unique}");
    let resource_link =
        json!([{"type":"quark","url":"https://pan.quark.cn/s/abc","password":"a1b2"}]);
    sqlx::query("INSERT INTO managed_resources(id,name,links_json,cloud_types_json) VALUES($1,'原生网盘测试',$2,'[\"quark\"]'::jsonb)").bind(&id).bind(&resource_link).execute(&pool).await.unwrap();
    let checked = api(
        &router,
        "POST",
        "/api/admin/resources/check",
        token,
        json!({"ids":[id]}),
    )
    .await;
    assert_eq!(checked.0, StatusCode::OK);
    assert_eq!(checked.1["data"]["valid"], 1, "{}", checked.1);
    let status: String =
        sqlx::query_scalar("SELECT check_status FROM managed_resources WHERE id=$1")
            .bind(&id)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(status, "valid");
    let target = json!({"resourceId":id,"linkIndex":0});
    assert_eq!(
        api(
            &router,
            "POST",
            "/api/admin/cloud-drive/delete-preview",
            token,
            target.clone()
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    mock.data.lock().await.own_share = true;
    let preview = api(
        &router,
        "POST",
        "/api/admin/cloud-drive/delete-preview",
        token,
        target.clone(),
    )
    .await;
    assert_eq!(preview.0, StatusCode::OK, "{}", preview.1);
    let confirmation = preview.1["data"]["confirmationToken"].clone();
    let deletes_before = mock
        .data
        .lock()
        .await
        .calls
        .iter()
        .filter(|(_, p, _, _)| p.ends_with("file/delete"))
        .count();
    mock.data.lock().await.changed = true;
    let stale_key = uuid::Uuid::new_v4();
    assert_eq!(api(&router,"POST","/api/admin/resources/cloud-delete",token,json!({"resourceId":id,"linkIndex":0,"confirmationToken":confirmation,"requestKey":stale_key})).await.0,StatusCode::CONFLICT);
    assert_eq!(
        mock.data
            .lock()
            .await
            .calls
            .iter()
            .filter(|(_, p, _, _)| p.ends_with("file/delete"))
            .count(),
        deletes_before
    );
    mock.data.lock().await.changed = false;
    let deletion_key = uuid::Uuid::new_v4();
    let delete = json!({"resourceId":id,"linkIndex":0,"confirmationToken":confirmation,"requestKey":deletion_key});
    let deleted = api(
        &router,
        "POST",
        "/api/admin/resources/cloud-delete",
        token,
        delete.clone(),
    )
    .await;
    assert_eq!(deleted.0, StatusCode::OK, "{}", deleted.1);
    assert_eq!(deleted.1["data"]["deletedCount"], 2);
    assert_eq!(
        api(
            &router,
            "POST",
            "/api/admin/resources/cloud-delete",
            token,
            delete
        )
        .await
        .1,
        deleted.1
    );
    assert_eq!(
        mock.data
            .lock()
            .await
            .calls
            .iter()
            .filter(|(_, p, _, _)| p.ends_with("file/delete"))
            .count(),
        deletes_before + 1
    );
    let retained: Value =
        sqlx::query_scalar("SELECT links_json FROM managed_resources WHERE id=$1")
            .bind(&id)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(retained, resource_link);
    // Wrong credentials / temporary errors are unknown, not invalid.
    mock.data.lock().await.business_error = true;
    let baidu_unknown = api(
        &router,
        "POST",
        "/api/admin/cloud-drive/check",
        token,
        json!(share_input(Provider::Baidu)),
    )
    .await;
    assert_eq!(baidu_unknown.1["data"]["status"], "unknown");
    let invalid = api(
        &router,
        "POST",
        "/api/admin/resources/check",
        token,
        json!({"ids":[id]}),
    )
    .await;
    assert_eq!(invalid.1["data"]["invalid"], 1);
    mock.data.lock().await.business_error = false;
    // A failed post-write async task is persisted as uncertain and never replayed.
    mock.data.lock().await.async_task = true;
    mock.data.lock().await.failed_task = true;
    let uncertain_key = uuid::Uuid::new_v4();
    let uncertain =
        json!({"url":"https://pan.quark.cn/s/abc","autoShare":false,"requestKey":uncertain_key});
    let failed = api(
        &router,
        "POST",
        "/api/admin/cloud-drive/save",
        token,
        uncertain.clone(),
    )
    .await;
    assert_eq!(failed.1["data"]["status"], "uncertain");
    let writes = mock
        .data
        .lock()
        .await
        .calls
        .iter()
        .filter(|(_, p, _, _)| p.ends_with("sharepage/save"))
        .count();
    assert_eq!(
        api(
            &router,
            "POST",
            "/api/admin/cloud-drive/save",
            token,
            uncertain
        )
        .await
        .1,
        failed.1
    );
    assert_eq!(
        mock.data
            .lock()
            .await
            .calls
            .iter()
            .filter(|(_, p, _, _)| p.ends_with("sharepage/save"))
            .count(),
        writes
    );
    assert_eq!(
        api(
            &router,
            "PUT",
            "/api/settings/quark",
            token,
            json!({"cookie":null})
        )
        .await
        .1["data"]["configured"],
        false
    );
    state.auth().revoke_session(&session).await.unwrap();
    state.auth().revoke_session(&other).await.unwrap();
    sqlx::query("DELETE FROM cloud_delete_previews WHERE actor_id=$1")
        .bind(session.user_id)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("DELETE FROM cloud_drive_operations WHERE actor_id=$1")
        .bind(session.user_id)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("DELETE FROM managed_resources WHERE id=$1")
        .bind(&id)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("DELETE FROM users WHERE id=ANY($1)")
        .bind(vec![session.user_id.unwrap(), other.user_id.unwrap()])
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("DELETE FROM cloud_account_settings WHERE provider IN ('baidu','quark')")
        .execute(&pool)
        .await
        .unwrap();
    for (provider, credential) in previous {
        sqlx::query("INSERT INTO cloud_account_settings(provider,credential) VALUES($1,$2)")
            .bind(provider)
            .bind(credential)
            .execute(&pool)
            .await
            .unwrap();
    }
    pool.close().await;
}

#[test]
fn baidu_dedup_prefers_hash_and_never_reuses_known_different_content() {
    let mut original = file("shared", "same-name", 42, false);
    original.md5 = "hash-a".into();
    let mut wrong = file("wrong", "same-name", 42, false);
    wrong.md5 = "hash-b".into();
    let mut right = file("right", "renamed", 42, false);
    right.md5 = "hash-a".into();
    let (hit, missing) = match_existing(
        Provider::Baidu,
        &[original.clone()],
        &[wrong.clone(), right],
    );
    assert_eq!(hit[0].id, "right");
    assert!(missing.is_empty());
    let (hit, missing) = match_existing(Provider::Baidu, &[original], &[wrong]);
    assert!(hit.is_empty());
    assert_eq!(missing.len(), 1);
}

#[tokio::test]
async fn quark_rejects_non_owner_entries_even_when_share_id_matches() {
    let mock = Mock::start().await;
    {
        let mut state = mock.data.lock().await;
        state.own_share = true;
        state.non_owner_entry = true;
    }
    let drive = mock.drive(Provider::Quark);
    let ctx = drive
        .resolve(&share_input(Provider::Quark).parse().unwrap())
        .await
        .unwrap();
    assert_eq!(
        drive.owned(&ctx).await.unwrap_err().kind,
        ErrorKind::Ownership
    );
    assert!(!drive.wrote());
}
