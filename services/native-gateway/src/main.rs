mod protocol;
mod session;

use std::collections::HashMap;
use std::env;
use std::fs;
use std::net::{Ipv4Addr, SocketAddr};
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use axum::body::Bytes;
use axum::extract::State;
use axum::extract::ws::WebSocketUpgrade;
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use sha2::Sha256;
use subtle::ConstantTimeEq;
use tokio::sync::Mutex;
use tracing::{error, info};
use uuid::Uuid;

use crate::protocol::{Invite, JoinIdentity, public_unicast};
use crate::session::{GlobalMeter, SessionConfig, SessionTicket};

type HmacSha256 = Hmac<Sha256>;
const TICKET_TTL: Duration = Duration::from_secs(60);
const SIGNATURE_SKEW: Duration = Duration::from_secs(30);
const MAX_CONTROL_BODY: usize = 16 * 1024;

#[derive(Clone)]
enum PublicWebsocketUrl {
    RequestHost,
    Static(String),
}

#[derive(Clone)]
struct Config {
    bind: SocketAddr,
    control_secret: Arc<[u8]>,
    global_daily_byte_cap: u64,
    max_sessions: usize,
    max_sessions_per_actor: usize,
    origins: Arc<[String]>,
    public_ip: Ipv4Addr,
    public_websocket_url: PublicWebsocketUrl,
    udp_port_start: u16,
    udp_port_end: u16,
}

impl Config {
    fn from_env() -> Result<Self, String> {
        let bind = env::var("BIND_ADDR")
            .unwrap_or_else(|_| "127.0.0.1:8080".into())
            .parse()
            .map_err(|_| "BIND_ADDR is invalid")?;
        let control_secret = secret_from_env_or_file("CONTROL_SECRET", "CONTROL_SECRET_FILE")?;
        if control_secret.len() < 32 {
            return Err("CONTROL_SECRET must contain at least 32 characters".into());
        }
        let public_websocket_url = match env::var("PUBLIC_WEBSOCKET_URL")
            .map_err(|_| "PUBLIC_WEBSOCKET_URL is required")?
        {
            value if value == "auto" => PublicWebsocketUrl::RequestHost,
            value if value.starts_with("wss://") && value.len() <= 512 => {
                PublicWebsocketUrl::Static(value)
            }
            _ => return Err("PUBLIC_WEBSOCKET_URL must be 'auto' or a wss:// URL".into()),
        };
        let origins: Vec<String> = env::var("ALLOWED_ORIGINS")
            .map_err(|_| "ALLOWED_ORIGINS is required")?
            .split(',')
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_owned)
            .collect();
        if origins.is_empty() || origins.iter().any(|value| value == "*") {
            return Err("ALLOWED_ORIGINS must contain explicit origins".into());
        }
        let public_ip: Ipv4Addr = env::var("PUBLIC_UDP_IP")
            .map_err(|_| "PUBLIC_UDP_IP is required")?
            .parse()
            .map_err(|_| "PUBLIC_UDP_IP must be IPv4")?;
        let allow_private = env::var("ALLOW_PRIVATE_UDP_IP").as_deref() == Ok("true");
        if !allow_private && !public_unicast(public_ip) {
            return Err("PUBLIC_UDP_IP must be a public unicast address".into());
        }
        let udp_port_start = env_u16("UDP_PORT_START", 40_000)?;
        let udp_port_end = env_u16("UDP_PORT_END", 40_127)?;
        if udp_port_end < udp_port_start || udp_port_end - udp_port_start > 4_096 {
            return Err("UDP port range is invalid".into());
        }
        Ok(Self {
            bind,
            control_secret: Arc::from(control_secret.into_bytes()),
            global_daily_byte_cap: env_u64(
                "GLOBAL_DAILY_BYTE_CAP",
                10_000_000_000,
                1_000_000,
                1_000_000_000_000,
            )?,
            max_sessions: env_usize("MAX_SESSIONS", 64, 1, 512)?,
            max_sessions_per_actor: env_usize("MAX_SESSIONS_PER_ACTOR", 2, 1, 8)?,
            origins: Arc::from(origins),
            public_ip,
            public_websocket_url,
            udp_port_start,
            udp_port_end,
        })
    }
}

fn secret_from_env_or_file(value_name: &str, file_name: &str) -> Result<String, String> {
    match (env::var(value_name), env::var(file_name)) {
        (Ok(_), Ok(_)) => Err(format!(
            "set only one of {value_name} or {file_name}, not both"
        )),
        (Ok(value), Err(_)) => Ok(value),
        (Err(_), Ok(path)) => fs::read_to_string(path)
            .map(|value| value.trim_end_matches(['\r', '\n']).to_owned())
            .map_err(|_| format!("{file_name} could not be read")),
        (Err(_), Err(_)) => Err(format!("{value_name} or {file_name} is required")),
    }
}

fn env_u16(name: &str, default: u16) -> Result<u16, String> {
    match env::var(name) {
        Ok(value) => value.parse().map_err(|_| format!("{name} is invalid")),
        Err(_) => Ok(default),
    }
}

fn env_usize(name: &str, default: usize, minimum: usize, maximum: usize) -> Result<usize, String> {
    let value = match env::var(name) {
        Ok(value) => value.parse().map_err(|_| format!("{name} is invalid"))?,
        Err(_) => default,
    };
    if !(minimum..=maximum).contains(&value) {
        return Err(format!("{name} must be between {minimum} and {maximum}"));
    }
    Ok(value)
}

fn env_u64(name: &str, default: u64, minimum: u64, maximum: u64) -> Result<u64, String> {
    let value = match env::var(name) {
        Ok(value) => value.parse().map_err(|_| format!("{name} is invalid"))?,
        Err(_) => default,
    };
    if !(minimum..=maximum).contains(&value) {
        return Err(format!("{name} must be between {minimum} and {maximum}"));
    }
    Ok(value)
}

struct PendingTicket {
    expires: Instant,
    session: SessionTicket,
}

#[derive(Default)]
struct Store {
    actor_sessions: HashMap<String, usize>,
    request_ids: HashMap<Uuid, Instant>,
    reserved_sessions: usize,
    tickets: HashMap<String, PendingTicket>,
}

impl Store {
    fn cleanup(&mut self) {
        let now = Instant::now();
        self.request_ids.retain(|_, expires| *expires > now);
        let expired: Vec<String> = self
            .tickets
            .iter()
            .filter(|(_, value)| value.expires <= now)
            .map(|(ticket, _)| ticket.clone())
            .collect();
        for ticket in expired {
            if let Some(value) = self.tickets.remove(&ticket) {
                self.release_session(&value.session.actor_id);
            }
        }
    }

    fn release_session(&mut self, actor_id: &str) {
        self.reserved_sessions = self.reserved_sessions.saturating_sub(1);
        if let Some(count) = self.actor_sessions.get_mut(actor_id) {
            *count = count.saturating_sub(1);
            if *count == 0 {
                self.actor_sessions.remove(actor_id);
            }
        }
    }
}

#[derive(Clone)]
struct AppState {
    config: Config,
    global_meter: Arc<GlobalMeter>,
    store: Arc<Mutex<Store>>,
}

#[derive(Debug)]
struct ApiError {
    status: StatusCode,
    code: &'static str,
    message: &'static str,
}

impl ApiError {
    fn new(status: StatusCode, code: &'static str, message: &'static str) -> Self {
        Self {
            status,
            code,
            message,
        }
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (
            self.status,
            Json(serde_json::json!({
                "error": { "code": self.code, "message": self.message }
            })),
        )
            .into_response()
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct CreateSessionRequest {
    actor_id: String,
    identifier: String,
    invite: String,
    origin: String,
    request_id: Uuid,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CreateSessionResponse {
    local_identifier: String,
    peer_id: String,
    remote_identifier: String,
    ticket: String,
    websocket_url: String,
}

fn header<'a>(headers: &'a HeaderMap, name: &'static str) -> Result<&'a str, ApiError> {
    headers
        .get(name)
        .and_then(|value| value.to_str().ok())
        .ok_or_else(|| {
            ApiError::new(
                StatusCode::UNAUTHORIZED,
                "INVALID_SIGNATURE",
                "Gateway authentication failed.",
            )
        })
}

fn unix_millis() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

fn valid_hex(value: &str, size: usize) -> bool {
    value.len() == size
        && value
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}

fn public_websocket_url(
    configured: &PublicWebsocketUrl,
    headers: &HeaderMap,
) -> Result<String, ApiError> {
    if let PublicWebsocketUrl::Static(value) = configured {
        return Ok(value.clone());
    }
    let host = headers
        .get(axum::http::header::HOST)
        .and_then(|value| value.to_str().ok())
        .ok_or_else(|| {
            ApiError::new(
                StatusCode::BAD_REQUEST,
                "INVALID_HOST",
                "Gateway hostname is invalid.",
            )
        })?;
    if host.len() > 253
        || !host.ends_with(".cloudfront.net")
        || host.starts_with('.')
        || !host.bytes().all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-' || byte == b'.'
        })
    {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "INVALID_HOST",
            "Gateway hostname is invalid.",
        ));
    }
    Ok(format!("wss://{host}/v1/connect"))
}

async fn create_session(
    State(state): State<AppState>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<impl IntoResponse, ApiError> {
    if body.len() > MAX_CONTROL_BODY {
        return Err(ApiError::new(
            StatusCode::PAYLOAD_TOO_LARGE,
            "BODY_TOO_LARGE",
            "Request is too large.",
        ));
    }
    let timestamp_text = header(&headers, "x-halo-timestamp")?;
    let request_id_text = header(&headers, "x-halo-request-id")?;
    let signature_text = header(&headers, "x-halo-signature")?;
    let timestamp: u128 = timestamp_text.parse().map_err(|_| {
        ApiError::new(
            StatusCode::UNAUTHORIZED,
            "INVALID_SIGNATURE",
            "Gateway authentication failed.",
        )
    })?;
    if unix_millis().abs_diff(timestamp) > SIGNATURE_SKEW.as_millis() {
        return Err(ApiError::new(
            StatusCode::UNAUTHORIZED,
            "EXPIRED_SIGNATURE",
            "Gateway authentication expired.",
        ));
    }
    let request_id = Uuid::parse_str(request_id_text).map_err(|_| {
        ApiError::new(
            StatusCode::UNAUTHORIZED,
            "INVALID_SIGNATURE",
            "Gateway authentication failed.",
        )
    })?;
    let mut signed =
        Vec::with_capacity(timestamp_text.len() + request_id_text.len() + body.len() + 2);
    signed.extend_from_slice(timestamp_text.as_bytes());
    signed.push(b'\n');
    signed.extend_from_slice(request_id_text.as_bytes());
    signed.push(b'\n');
    signed.extend_from_slice(&body);
    let mut mac = <HmacSha256 as Mac>::new_from_slice(&state.config.control_secret)
        .expect("HMAC accepts every key size");
    mac.update(&signed);
    let expected = URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes());
    if expected
        .as_bytes()
        .ct_eq(signature_text.as_bytes())
        .unwrap_u8()
        != 1
    {
        return Err(ApiError::new(
            StatusCode::UNAUTHORIZED,
            "INVALID_SIGNATURE",
            "Gateway authentication failed.",
        ));
    }
    let input: CreateSessionRequest = serde_json::from_slice(&body).map_err(|_| {
        ApiError::new(
            StatusCode::BAD_REQUEST,
            "VALIDATION_FAILED",
            "Request body is invalid.",
        )
    })?;
    if input.request_id != request_id
        || !valid_hex(&input.actor_id, 32)
        || !valid_hex(&input.identifier, 12)
        || input.invite != input.invite.to_lowercase()
        || !state
            .config
            .origins
            .iter()
            .any(|value| value == &input.origin)
    {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "VALIDATION_FAILED",
            "Request body is invalid.",
        ));
    }
    let websocket_url = public_websocket_url(&state.config.public_websocket_url, &headers)?;
    let invite = Invite::parse(&input.invite).map_err(|_| {
        ApiError::new(
            StatusCode::BAD_REQUEST,
            "INVALID_INVITE",
            "The Halo invite is invalid.",
        )
    })?;
    let identity = JoinIdentity::generate().map_err(|_| {
        ApiError::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "RANDOM_UNAVAILABLE",
            "The gateway could not create a secure identity.",
        )
    })?;
    let peer_id = format!("native_{}", Uuid::new_v4().simple());
    let mut token_bytes = [0_u8; 32];
    getrandom::fill(&mut token_bytes).map_err(|_| {
        ApiError::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "RANDOM_UNAVAILABLE",
            "The gateway could not create a secure ticket.",
        )
    })?;
    let ticket = URL_SAFE_NO_PAD.encode(token_bytes);
    let local_identifier = hex::encode(identity.identifier);
    let remote_identifier = hex::encode(invite.host_identifier);
    let mut store = state.store.lock().await;
    store.cleanup();
    if store.request_ids.contains_key(&request_id) {
        return Err(ApiError::new(
            StatusCode::CONFLICT,
            "REPLAYED_REQUEST",
            "This gateway request was already used.",
        ));
    }
    if store.reserved_sessions >= state.config.max_sessions
        || store
            .actor_sessions
            .get(&input.actor_id)
            .copied()
            .unwrap_or(0)
            >= state.config.max_sessions_per_actor
    {
        return Err(ApiError::new(
            StatusCode::TOO_MANY_REQUESTS,
            "SESSION_LIMIT",
            "Too many native sessions are active.",
        ));
    }
    store
        .request_ids
        .insert(request_id, Instant::now() + SIGNATURE_SKEW);
    *store
        .actor_sessions
        .entry(input.actor_id.clone())
        .or_default() += 1;
    store.reserved_sessions += 1;
    store.tickets.insert(
        ticket.clone(),
        PendingTicket {
            expires: Instant::now() + TICKET_TTL,
            session: SessionTicket {
                actor_id: input.actor_id,
                identity,
                invite,
                origin: input.origin,
                peer_id: peer_id.clone(),
            },
        },
    );
    drop(store);
    Ok((
        StatusCode::CREATED,
        Json(CreateSessionResponse {
            local_identifier,
            peer_id,
            remote_identifier,
            ticket,
            websocket_url,
        }),
    ))
}

fn websocket_ticket(headers: &HeaderMap) -> Option<String> {
    headers
        .get("sec-websocket-protocol")?
        .to_str()
        .ok()?
        .split(',')
        .map(str::trim)
        .find_map(|value| value.strip_prefix("ticket.").map(str::to_owned))
}

async fn connect(
    State(state): State<AppState>,
    headers: HeaderMap,
    upgrade: WebSocketUpgrade,
) -> Result<Response, ApiError> {
    let origin = header(&headers, "origin")?.to_owned();
    let token = websocket_ticket(&headers).ok_or_else(|| {
        ApiError::new(
            StatusCode::UNAUTHORIZED,
            "INVALID_TICKET",
            "Native session ticket is missing.",
        )
    })?;
    if token.len() < 32
        || token.len() > 128
        || !token
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
    {
        return Err(ApiError::new(
            StatusCode::UNAUTHORIZED,
            "INVALID_TICKET",
            "Native session ticket is invalid.",
        ));
    }
    let mut store = state.store.lock().await;
    store.cleanup();
    let pending = store.tickets.remove(&token).ok_or_else(|| {
        ApiError::new(
            StatusCode::UNAUTHORIZED,
            "INVALID_TICKET",
            "Native session ticket is invalid or expired.",
        )
    })?;
    if pending.session.origin != origin {
        store.release_session(&pending.session.actor_id);
        return Err(ApiError::new(
            StatusCode::FORBIDDEN,
            "ORIGIN_FORBIDDEN",
            "Browser origin does not match the ticket.",
        ));
    }
    drop(store);
    let session_state = state.clone();
    Ok(upgrade
        .max_message_size(crate::protocol::FRAME_MAX_SIZE)
        .max_frame_size(crate::protocol::FRAME_MAX_SIZE)
        .protocols(["halo-native-v1"])
        .on_upgrade(move |socket| async move {
            let actor_id = pending.session.actor_id.clone();
            let peer_id = pending.session.peer_id.clone();
            let config = SessionConfig {
                global_meter: session_state.global_meter.clone(),
                public_ip: session_state.config.public_ip,
                udp_port_start: session_state.config.udp_port_start,
                udp_port_end: session_state.config.udp_port_end,
            };
            if let Err(error) = session::run(socket, pending.session, config).await {
                error!(%error, %peer_id, "native session ended with error");
            }
            session_state.store.lock().await.release_session(&actor_id);
        }))
}

async fn health() -> impl IntoResponse {
    Json(serde_json::json!({ "ok": true, "service": "halo-native-gateway", "v": 1 }))
}

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .json()
        .init();
    let config = Config::from_env().unwrap_or_else(|error| panic!("configuration error: {error}"));
    let bind = config.bind;
    let state = AppState {
        global_meter: Arc::new(GlobalMeter::new(config.global_daily_byte_cap)),
        config,
        store: Arc::new(Mutex::new(Store::default())),
    };
    let app = Router::new()
        .route("/health", get(health))
        .route("/v1/sessions", post(create_session))
        .route("/v1/connect", get(connect))
        .with_state(state)
        .layer(axum::extract::DefaultBodyLimit::max(MAX_CONTROL_BODY));
    let listener = tokio::net::TcpListener::bind(bind)
        .await
        .expect("gateway bind failed");
    info!(%bind, "native gateway listening");
    axum::serve(listener, app)
        .await
        .expect("gateway server failed");
}

#[cfg(test)]
mod tests {
    use axum::http::{HeaderMap, HeaderValue};

    use super::{PublicWebsocketUrl, public_websocket_url};

    #[test]
    fn derives_cloudfront_websocket_url_from_request_host() {
        let mut headers = HeaderMap::new();
        headers.insert(
            "host",
            HeaderValue::from_static("d123example.cloudfront.net"),
        );
        assert_eq!(
            public_websocket_url(&PublicWebsocketUrl::RequestHost, &headers).unwrap(),
            "wss://d123example.cloudfront.net/v1/connect"
        );
    }

    #[test]
    fn rejects_untrusted_derived_host() {
        let mut headers = HeaderMap::new();
        headers.insert("host", HeaderValue::from_static("attacker.example"));
        assert!(public_websocket_url(&PublicWebsocketUrl::RequestHost, &headers).is_err());
    }

    #[test]
    fn preserves_explicit_websocket_url() {
        let headers = HeaderMap::new();
        assert_eq!(
            public_websocket_url(
                &PublicWebsocketUrl::Static("wss://native.example/v1/connect".into()),
                &headers,
            )
            .unwrap(),
            "wss://native.example/v1/connect"
        );
    }
}
