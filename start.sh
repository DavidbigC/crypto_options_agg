#!/bin/bash
# Local/private development helper.
# Starts the Rust backend and frontend with a single command.
# Ctrl+C stops both.

ROOT="$(cd "$(dirname "$0")" && pwd)"

# Install frontend deps if needed
if [ ! -d "$ROOT/frontend/node_modules" ]; then
  echo "Installing frontend dependencies..."
  (cd "$ROOT/frontend" && npm install)
fi

echo ""
echo "Starting Rust backend on http://localhost:3501"
echo "Starting frontend on http://localhost:3000"
echo "Press Ctrl+C to stop both."
echo "Mode: local/private (dotenv enabled if present)"
echo ""

terminate_descendants() {
  local parent_pid="$1"
  local child_pid

  for child_pid in $(pgrep -P "$parent_pid" 2>/dev/null || true); do
    terminate_descendants "$child_pid"
    kill "$child_pid" 2>/dev/null || true
  done
}

cleanup() {
  trap - EXIT INT TERM

  if [ -n "${BACKEND_PID:-}" ] && kill -0 "$BACKEND_PID" 2>/dev/null; then
    terminate_descendants "$BACKEND_PID"
    kill "$BACKEND_PID" 2>/dev/null || true
    wait "$BACKEND_PID" 2>/dev/null || true
  fi
}

# Start Rust backend in background.
# Keep incremental disabled here so startup is stable even if user overrides Cargo profiles.
(cd "$ROOT/backend-rust" && exec env APP_MODE=private PORT=3501 CARGO_INCREMENTAL=0 ~/.cargo/bin/cargo run --bin options-backend) &
BACKEND_PID=$!

# Kill backend when this script exits
trap cleanup EXIT INT TERM

# Wait for Rust backend to be ready (cargo compile + startup can take ~15s)
echo "Waiting for Rust backend to be ready..."
for i in $(seq 1 30); do
  if curl -sf http://localhost:3501/api/health > /dev/null 2>&1; then
    echo "Rust backend ready."
    break
  fi
  sleep 1
done

# Start frontend pointed at Rust backend
(cd "$ROOT/frontend" && BACKEND_BASE_URL=http://localhost:3501 NEXT_PUBLIC_SSE_BASE_URL=http://localhost:3501 npm run dev)
