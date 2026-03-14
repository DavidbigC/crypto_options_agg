use std::path::{Path, PathBuf};

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
pub enum AppMode {
    Public,
    Private,
}

impl Config {
    pub fn from_env() -> Self {
        if std::env::var("LOAD_DOTENV").as_deref() != Ok("false") {
            load_dotenv();
        }
        let app_mode = match std::env::var("APP_MODE").as_deref() {
            Ok("public") => AppMode::Public,
            _ => AppMode::Private,
        };
        let is_private = app_mode == AppMode::Private;
        Self {
            port: std::env::var("PORT")
                .ok()
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

fn load_dotenv() {
    let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    for path in dotenv_paths_from(&cwd) {
        if path.is_file() {
            let _ = load_dotenv_file(&path);
        }
    }
}

fn dotenv_paths_from(start_dir: &Path) -> Vec<PathBuf> {
    let mut paths = vec![start_dir.join(".env")];

    if let Some(project_root) = start_dir.parent() {
        paths.push(project_root.join(".env"));
        paths.push(project_root.join("archive").join("backend-node").join(".env"));
    }

    paths
}

fn load_dotenv_file(path: &Path) -> std::io::Result<()> {
    let contents = std::fs::read_to_string(path)?;
    for raw_line in contents.lines() {
        let line = raw_line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }

        let Some((raw_key, raw_value)) = line.split_once('=') else {
            continue;
        };

        let key = raw_key.trim();
        if !is_valid_env_key(key) {
            continue;
        }

        let value = raw_value.trim().trim_matches('"').trim_matches('\'');
        match std::env::var(key) {
            Ok(existing) if !existing.is_empty() => {}
            _ => std::env::set_var(key, value),
        }
    }
    Ok(())
}

fn is_valid_env_key(key: &str) -> bool {
    let mut chars = key.chars();
    match chars.next() {
        Some(first) if first.is_ascii_alphabetic() || first == '_' => {}
        _ => return false,
    }

    chars.all(|ch| ch.is_ascii_alphanumeric() || ch == '_')
}

#[cfg(test)]
mod tests {
    use super::{dotenv_paths_from, load_dotenv_file};
    use std::path::Path;

    #[test]
    fn dotenv_paths_include_backend_rust_root_and_archived_node_env_files() {
        let cwd = Path::new("/tmp/project/backend-rust");
        let paths = dotenv_paths_from(cwd);

        assert_eq!(
            paths,
            vec![
                cwd.join(".env"),
                Path::new("/tmp/project/.env").to_path_buf(),
                Path::new("/tmp/project/archive/backend-node/.env").to_path_buf(),
            ]
        );
    }

    #[test]
    fn dotenv_loading_does_not_override_non_empty_process_env() {
        let env_path = std::env::temp_dir().join("options-backend-config-test.env");
        std::fs::write(&env_path, "APP_MODE=public\n").unwrap();
        std::env::set_var("APP_MODE", "private");

        load_dotenv_file(&env_path).unwrap();

        assert_eq!(std::env::var("APP_MODE").unwrap(), "private");

        let _ = std::fs::remove_file(env_path);
    }

    #[test]
    fn dotenv_loading_skips_invalid_lines_and_keeps_valid_credentials() {
        let env_path = std::env::temp_dir().join("options-backend-config-invalid-lines.env");
        std::fs::write(
            &env_path,
            "apikey=test-okx\nAPI key name=options position\nBYBIT_API_KEY=test-bybit\n",
        )
        .unwrap();

        std::env::remove_var("apikey");
        std::env::remove_var("BYBIT_API_KEY");

        load_dotenv_file(&env_path).unwrap();

        assert_eq!(std::env::var("apikey").unwrap(), "test-okx");
        assert_eq!(std::env::var("BYBIT_API_KEY").unwrap(), "test-bybit");

        std::env::remove_var("apikey");
        std::env::remove_var("BYBIT_API_KEY");
        let _ = std::fs::remove_file(env_path);
    }
}
