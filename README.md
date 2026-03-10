# Crypto Options Workspace

App-first workspace for watching crypto options markets, comparing exchange quotes, and testing strategy ideas from a browser UI.

The public repo is centered on the web app:

- `frontend/`: Next.js interface for chains, scanners, optimizer, builder, portfolio, and analysis views
- `backend/`: Express API and market-data services for Bybit, OKX, Deribit, and Derive
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

## Repo layout

```text
.
├── backend/             # Express API, exchange adapters, analytics, tests
├── docs/                # Plans and reference docs
├── frontend/            # Next.js app router UI
├── ecosystem.config.js  # Optional PM2 config
├── start.sh             # Starts backend and frontend together
└── README.md
```

## Requirements

- Node.js 18+
- npm

## Local development

Install and run both services with:

```bash
./start.sh
```

That script:

- installs backend dependencies if missing
- installs frontend dependencies if missing
- seeds `backend/.env` from `backend/.env.example` if needed
- starts the backend on `http://localhost:3500`
- starts the frontend on `http://localhost:3000`

If you prefer to run each service manually:

```bash
cd backend
npm install
cp .env.example .env
npm run dev
```

```bash
cd frontend
npm install
npm run dev
```

## Environment

The backend reads `backend/.env`. The checked-in example is enough for local startup; the only required runtime setting in the current codepath is `PORT`, which defaults to `3500`.

If you add private exchange credentials or other local settings, keep them in ignored `.env` files only.

## Key app areas

- `/`: main options chain and scanner surface
- `/optimizer`: multi-leg strategy optimizer
- `/builder`: position builder
- `/portfolio`: portfolio tools
- `/analysis`: analysis workspace

## Notes for GitHub

This repository is being kept intentionally narrow for publishing:

- core app code lives in `frontend/` and `backend/`
- planning docs stay under `docs/`
- generated files, private env files, research folders, and local scratch material are excluded

## Development notes

- Backend entrypoint: `backend/server.js`
- Frontend entrypoint: `frontend/app/page.tsx`
- Package manifests live in `backend/package.json` and `frontend/package.json`

## License

No license is currently declared in this repository.
