use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Instant;

use axum::body::Body;
use axum::extract::Request;
use axum::http::StatusCode;
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};

#[derive(Clone)]
pub struct RateLimiter {
    buckets: Arc<Mutex<HashMap<String, (u32, Instant)>>>,
    limit: u32,
    window_secs: u64,
}

impl RateLimiter {
    pub fn new(limit: u32, window_secs: u64) -> Self {
        Self {
            buckets: Arc::new(Mutex::new(HashMap::new())),
            limit,
            window_secs,
        }
    }

    pub async fn layer(self, req: Request<Body>, next: Next) -> Response {
        let ip = req
            .headers()
            .get("x-forwarded-for")
            .and_then(|v| v.to_str().ok())
            .and_then(|s| s.split(',').next())
            .map(|s| s.trim().to_string())
            .unwrap_or_else(|| "unknown".to_string());

        let path = req.uri().path().to_string();
        let key = format!("{}:{}", ip, path);

        let now = Instant::now();
        let window = std::time::Duration::from_secs(self.window_secs);

        let allowed = {
            let mut map = self.buckets.lock().unwrap();
            let entry = map.entry(key).or_insert((0, now));
            if now.duration_since(entry.1) >= window {
                *entry = (1, now);
                true
            } else if entry.0 < self.limit {
                entry.0 += 1;
                true
            } else {
                false
            }
        };

        if allowed {
            next.run(req).await
        } else {
            (StatusCode::TOO_MANY_REQUESTS, "Rate limit exceeded").into_response()
        }
    }
}
