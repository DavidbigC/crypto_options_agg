#!/bin/bash
# Start both backend and frontend with a single command.
# Ctrl+C stops both.

ROOT="$(cd "$(dirname "$0")" && pwd)"

# Install backend deps if needed
if [ ! -d "$ROOT/backend/node_modules" ]; then
  echo "Installing backend dependencies..."
  (cd "$ROOT/backend" && npm install)
fi

# Install frontend deps if needed
if [ ! -d "$ROOT/frontend/node_modules" ]; then
  echo "Installing frontend dependencies..."
  (cd "$ROOT/frontend" && npm install)
fi

# Copy backend .env if missing
if [ ! -f "$ROOT/backend/.env" ] && [ -f "$ROOT/backend/.env.example" ]; then
  cp "$ROOT/backend/.env.example" "$ROOT/backend/.env"
fi

echo ""
echo "Starting backend on http://localhost:8000"
echo "Starting frontend on http://localhost:3000"
echo "Press Ctrl+C to stop both."
echo ""

# Start backend in background, capture its PID
(cd "$ROOT/backend" && npm run dev) &
BACKEND_PID=$!

# Kill backend when this script exits
trap "kill $BACKEND_PID 2>/dev/null" EXIT

# Start frontend in foreground
(cd "$ROOT/frontend" && npm run dev)
