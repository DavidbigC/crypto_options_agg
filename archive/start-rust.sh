#!/bin/bash
# Compatibility wrapper for the default Rust startup path.

ROOT="$(cd "$(dirname "$0")" && pwd)"
exec "$ROOT/start.sh"
