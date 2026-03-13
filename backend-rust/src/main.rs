mod config;
mod cache;
mod state;
mod routes;
mod exchanges;
mod analysis;
mod sse;

use axum::{Router, routing::get};
use std::sync::Arc;
use tower_http::cors::{CorsLayer, Any};
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt};

#[tokio::main]
async fn main() {
    tracing_subscriber::registry()
        .with(tracing_subscriber::EnvFilter::new(
            std::env::var("RUST_LOG").unwrap_or_else(|_| "info".into()),
        ))
        .with(tracing_subscriber::fmt::layer())
        .init();

    let cfg = config::Config::from_env();
    let state = Arc::new(state::AppState::new());

    let http_client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .unwrap();

    exchanges::bybit::start_polling(state.clone(), http_client.clone());
    exchanges::okx::start(state.clone(), http_client.clone());
    exchanges::deribit::start(state.clone(), http_client.clone());
    exchanges::binance::start(state.clone());
    exchanges::derive::start(state.clone(), http_client.clone());
    exchanges::futures::start_polling(state.clone(), http_client.clone());

    let cors = CorsLayer::new().allow_origin(Any).allow_methods(Any).allow_headers(Any);

    let app = Router::new()
        .route("/api/health", get(routes::health::handler))
        .route("/api/options/:base_coin", get(routes::bybit::options_chain))
        .route("/api/options/:base_coin/:expiration", get(routes::bybit::options_chain_expiry))
        .route("/api/spots", get(routes::bybit::spots))
        .route("/api/spot/:symbol", get(routes::bybit::spot_single))
        .route("/api/okx/options/:inst_family", get(routes::okx::options_chain))
        .route("/api/okx/spots", get(routes::okx::spots))
        .route("/api/okx/debug/:inst_family", get(routes::okx::debug))
        .route("/api/deribit/options/:coin", get(routes::deribit::options_chain))
        .route("/api/binance/options/:coin", get(routes::binance::options_chain))
        .route("/api/derive/options/:coin", get(routes::derive::options_chain))
        .route("/api/derive/debug/:coin", get(routes::derive::debug))
        .route("/api/combined/options/:base_coin", get(routes::combined::options_chain))
        .route("/api/futures/:coin", get(routes::futures::futures_chain))
        .route("/api/analysis/:exchange/:coin", get(routes::analysis::handler))
        .route("/api/arbs/:coin", get(routes::arbs::handler))
        .route("/api/scanners/:exchange/:coin", get(routes::scanners::handler))
        .route("/api/stream/:exchange/:coin", get(routes::stream::handler))
        .layer(cors)
        .with_state(state);

    let addr = format!("0.0.0.0:{}", cfg.port);
    tracing::info!("Listening on {}", addr);
    let listener = tokio::net::TcpListener::bind(&addr).await.unwrap();
    axum::serve(listener, app).await.unwrap();
}
