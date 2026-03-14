use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::{broadcast, RwLock};

pub const CHANNEL_CAPACITY: usize = 16;
pub const HEARTBEAT_SECS: u64 = 5;
pub const LEASE_SECS: u64 = 30 * 60; // 30 minutes

pub type SseSenders = Arc<RwLock<HashMap<String, broadcast::Sender<String>>>>;

/// Get or create the broadcast channel for a given "exchange:coin" key.
/// Returns a clone of the sender (cheap — just increments a ref count).
pub async fn get_or_create_sender(senders: &SseSenders, key: &str) -> broadcast::Sender<String> {
    {
        let read = senders.read().await;
        if let Some(tx) = read.get(key) {
            return tx.clone();
        }
    }
    let mut write = senders.write().await;
    // Double-check after acquiring write lock (another task may have inserted)
    if let Some(tx) = write.get(key) {
        return tx.clone();
    }
    let (tx, _) = broadcast::channel(CHANNEL_CAPACITY);
    write.insert(key.to_string(), tx.clone());
    tx
}

/// Broadcast a JSON payload string to all SSE clients for the given key.
/// Silently ignores if no receivers (SendError just means zero subscribers).
pub async fn broadcast(senders: &SseSenders, key: &str, payload: String) {
    let read = senders.read().await;
    if let Some(tx) = read.get(key) {
        let _ = tx.send(payload);
    }
}
