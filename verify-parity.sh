#!/usr/bin/env bash
# verify-parity.sh — compare Node.js (3500) vs Rust (3501) endpoint response keys
set -euo pipefail

NODE=http://localhost:3500
RUST=http://localhost:3501

PASS=0
FAIL=0

check() {
  local ep="$1"
  local node_keys rust_keys
  node_keys=$(curl -sf "${NODE}${ep}" 2>/dev/null | jq -r 'if type == "array" then .[0] | keys_unsorted | sort | .[] else keys_unsorted | sort | .[] end' 2>/dev/null || echo "ERROR")
  rust_keys=$(curl -sf "${RUST}${ep}" 2>/dev/null | jq -r 'if type == "array" then .[0] | keys_unsorted | sort | .[] else keys_unsorted | sort | .[] end' 2>/dev/null || echo "ERROR")

  if [ "$node_keys" = "$rust_keys" ]; then
    echo "  OK  $ep"
    PASS=$((PASS + 1))
  else
    echo " FAIL $ep"
    diff <(echo "$node_keys") <(echo "$rust_keys") | sed 's/^/        /'
    FAIL=$((FAIL + 1))
  fi
}

echo "=== Health ==="
check "/api/health"

echo ""
echo "=== Spots ==="
check "/api/spots"
check "/api/spot/BTCUSDT"
check "/api/okx/spots"

echo ""
echo "=== Options chains ==="
check "/api/options/BTC"
check "/api/okx/options/BTC-USD"
check "/api/deribit/options/BTC"
check "/api/binance/options/BTC"
check "/api/derive/options/BTC"
check "/api/combined/options/BTC"

echo ""
echo "=== Futures ==="
check "/api/futures/BTC"
check "/api/futures/ETH"
check "/api/futures/SOL"

echo ""
echo "=== Analysis ==="
check "/api/analysis/deribit/BTC"
check "/api/analysis/okx/BTC"
check "/api/analysis/combined/BTC"

echo ""
echo "=== Arbs ==="
check "/api/arbs/BTC"
check "/api/arbs/ETH"

echo ""
echo "=== Scanners ==="
check "/api/scanners/deribit/BTC"
check "/api/scanners/combined/BTC"
check "/api/scanners/bybit/ETH"

echo ""
echo "=== Debug ==="
check "/api/debug/bybit"

echo ""
echo "=== Polymarket ==="
check "/api/polymarket/BTC/weekly"
check "/api/polymarket/surface/BTC"

echo ""
echo "─────────────────────────────────"
echo "  Passed: ${PASS}  Failed: ${FAIL}"
if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
