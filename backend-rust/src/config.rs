pub struct Config {
    pub port: u16,
    pub app_mode: AppMode,
    pub enable_portfolio: bool,
    pub enable_optimizer: bool,
    pub cors_origins: Vec<String>,
    pub okx_api_key: Option<String>,
    pub okx_api_secret: Option<String>,
    pub okx_passphrase: Option<String>,
    pub bybit_api_key: Option<String>,
    pub bybit_api_secret: Option<String>,
}

#[derive(Clone, PartialEq)]
pub enum AppMode { Public, Private }

impl Config {
    pub fn from_env() -> Self {
        if std::env::var("LOAD_DOTENV").as_deref() != Ok("false") {
            let _ = dotenvy::dotenv();
        }
        let app_mode = match std::env::var("APP_MODE").as_deref() {
            Ok("public") => AppMode::Public,
            _ => AppMode::Private,
        };
        let is_private = app_mode == AppMode::Private;
        Self {
            port: std::env::var("PORT").ok()
                .and_then(|p| p.parse().ok())
                .unwrap_or(3501),
            app_mode,
            enable_portfolio: std::env::var("ENABLE_PORTFOLIO")
                .map(|v| v == "true")
                .unwrap_or(is_private),
            enable_optimizer: std::env::var("ENABLE_OPTIMIZER")
                .map(|v| v == "true")
                .unwrap_or(is_private),
            cors_origins: std::env::var("CORS_ORIGINS")
                .unwrap_or_default()
                .split(',')
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(String::from)
                .collect(),
            okx_api_key: std::env::var("OKX_API_KEY").ok(),
            okx_api_secret: std::env::var("OKX_API_SECRET").ok(),
            okx_passphrase: std::env::var("OKX_PASSPHRASE").ok(),
            bybit_api_key: std::env::var("BYBIT_API_KEY").ok(),
            bybit_api_secret: std::env::var("BYBIT_API_SECRET").ok(),
        }
    }
}
