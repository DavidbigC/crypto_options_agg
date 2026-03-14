# Crypto Options Workspace

App-first workspace for watching crypto options markets, comparing exchange quotes, and testing strategy ideas from a browser UI.

The public repo is centered on the web app:

- `frontend/`: Next.js interface for chains, scanners, optimizer, builder, portfolio, and analysis views
- `backend-rust/`: active Rust API and market-data services
- `archive/backend-node/`: archived Node/Express backend source, kept for reference only
- `docs/`: design notes and implementation plans

Legacy research material and local-only experiments are intentionally left out of the GitHub-facing scope.

## Current capabilities

- Live options chains for BTC, ETH, and SOL
- Exchange switching for Bybit, OKX, and combined views
- Cross-exchange arbitrage and box spread views
- Gamma and vega scanners
- Strategy optimizer
- Position builder and portfolio pages
- Backend services for streaming and polling market data

Hosted public mode intentionally disables sensitive pages and APIs:

- `/portfolio`
- `/optimizer`

## Repo layout

```text
.
├── archive/
│   └── backend-node/    # Archived Node/Express backend source only
├── backend-rust/        # Active Rust backend
├── docs/                # Plans and reference docs
├── frontend/            # Next.js app router UI
├── ecosystem.config.js  # Optional PM2 config for frontend + Rust backend
├── start.sh             # Starts Rust backend and frontend together
└── README.md
```

## Requirements

- Node.js 18+
- npm
- Rust toolchain with Cargo

## Modes

The app now supports two runtime modes.

- `private`: local/dev mode with dotenv loading enabled by default and all pages available
- `public`: hosted mode with dotenv loading disabled by default, portfolio disabled, and optimizer disabled

## Local development

Install and run both services with:

```bash
./start.sh
```

That script:

- installs frontend dependencies if missing
- starts the Rust backend on `http://localhost:3501`
- starts the frontend on `http://localhost:3000`

`start.sh` is for local/private use only. It is not the production startup path.

`start-rust.sh` remains as a compatibility alias and now delegates to `./start.sh`.

If you prefer to run each service manually:

```bash
cd backend-rust
APP_MODE=private PORT=3501 cargo run --bin options-backend
```

```bash
cd frontend
npm install
BACKEND_BASE_URL=http://localhost:3501 NEXT_PUBLIC_SSE_BASE_URL=http://localhost:3501 npm run dev
```

## Environment

### Local/private mode

The Rust backend reads local `.env` files by default. It checks `backend-rust/.env`, then the project root `.env`, then the archived Node backend env file as a fallback for reference preservation. The default local port in the startup scripts is `3501`.

If you add private exchange credentials or other local settings, keep them in ignored `.env` files only.

### Hosted/public mode

Do not place a `.env` file on the host server.

Use host-injected environment variables only. Minimum recommended settings:

```bash
APP_MODE=public
LOAD_DOTENV=false
ENABLE_PORTFOLIO=false
ENABLE_OPTIMIZER=false
CORS_ORIGINS=https://your-domain.example
BACKEND_BASE_URL=http://127.0.0.1:3500
NEXT_PUBLIC_APP_MODE=public
NEXT_PUBLIC_ENABLE_PORTFOLIO=false
NEXT_PUBLIC_ENABLE_OPTIMIZER=false
```

Notes:

- `BACKEND_BASE_URL` is used by the Next.js `/api` rewrite
- `NEXT_PUBLIC_*` values must be present when building the frontend for production
- hosted public mode should not receive OKX or Bybit portfolio credentials

## Key app areas

- `/`: main options chain and scanner surface
- `/builder`: position builder
- `/analysis`: analysis workspace
- `/polysis`: Polymarket probability surface

Private-only areas:

- `/optimizer`: multi-leg strategy optimizer
- `/portfolio`: portfolio tools

## Notes for GitHub

This repository is being kept intentionally narrow for publishing:

- core app code lives in `frontend/` and `backend-rust/`
- archived Node source lives in `archive/backend-node/`
- planning docs stay under `docs/`
- generated files, private env files, research folders, and local scratch material are excluded

## Development notes

- Backend entrypoint: `backend-rust/src/main.rs`
- Frontend entrypoint: `frontend/app/page.tsx`
- Package manifests live in `backend-rust/Cargo.toml` and `frontend/package.json`
- Hosted mode design: `docs/plans/2026-03-12-hosted-public-mode-design.md`

## Production notes

- Browser API calls use relative `/api/...` paths so the frontend can run behind your server domain
- Public mode applies CORS allowlisting and basic in-memory request limiting
- Public mode does not mount portfolio or optimizer backend routes
- Public mode returns `notFound()` for the portfolio and optimizer frontend pages

## License

No license is currently declared in this repository.
