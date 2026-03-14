# WS Testing

This directory holds the standalone websocket feasibility probe inputs and outputs for the Rust backend migration.

Planned contents:
- `reports/` for generated comparison artifacts
- `cargo run --bin ws_probe -- <exchange>` for live probe runs

The probe will compare exchange REST payloads, exchange websocket snapshots, and the current Rust endpoint output before any production transport swap.
