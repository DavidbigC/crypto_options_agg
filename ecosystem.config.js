module.exports = {
  apps: [
    {
      name: 'options-backend',
      cwd: './backend-rust',
      script: `${process.env.HOME}/.cargo/bin/cargo`,
      args: 'run --release --bin options-backend',
      interpreter: 'none',
      env: {
        PORT: 3500,
        APP_MODE: 'public',
        LOAD_DOTENV: 'false',
        ENABLE_PORTFOLIO: 'false',
        ENABLE_OPTIMIZER: 'false',
        CORS_ORIGINS: 'https://your-domain.example',
        CARGO_INCREMENTAL: '0',
      },
      restart_delay: 3000,
    },
    {
      name: 'options-frontend',
      cwd: './frontend',
      script: 'node_modules/.bin/next',
      args: 'start -p 3000',
      env: {
        NODE_ENV: 'production',
        BACKEND_BASE_URL: 'http://127.0.0.1:3500',
        NEXT_PUBLIC_APP_MODE: 'public',
        NEXT_PUBLIC_ENABLE_PORTFOLIO: 'false',
        NEXT_PUBLIC_ENABLE_OPTIMIZER: 'false',
      },
      restart_delay: 3000,
    },
  ],
}
