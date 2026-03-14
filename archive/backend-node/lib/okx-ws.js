/**
 * OKX WebSocket client
 * Maintains a persistent connection to OKX's public WS feed and keeps an
 * in-memory cache of the latest opt-summary data for BTC-USD and ETH-USD.
 */

import { WebSocket } from 'ws';

const WS_URL = 'wss://ws.okx.com:8443/ws/v5/public';
const FAMILIES = ['BTC-USD', 'ETH-USD'];
const HEARTBEAT_MS = 25_000;
const RECONNECT_BASE_MS = 2_000;
const RECONNECT_MAX_MS = 60_000;

// Greeks / IV cache: { 'BTC-USD': { [instId]: rawItem }, 'ETH-USD': {...} }
export const okxCache = {
  'BTC-USD': {},
  'ETH-USD': {},
};

export function startOkxWebSocket() {
  let reconnectDelay = RECONNECT_BASE_MS;

  function connect() {
    console.log('OKX WS: connecting...');
    const ws = new WebSocket(WS_URL);
    let heartbeatTimer = null;

    ws.on('open', () => {
      console.log('OKX WS: connected');
      reconnectDelay = RECONNECT_BASE_MS;

      ws.send(JSON.stringify({
        op: 'subscribe',
        args: FAMILIES.map(f => ({ channel: 'opt-summary', instFamily: f })),
      }));

      heartbeatTimer = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) ws.send('ping');
      }, HEARTBEAT_MS);
    });

    ws.on('message', (raw) => {
      const str = raw.toString();
      if (str === 'pong') return;

      let msg;
      try { msg = JSON.parse(str); } catch { return; }

      if (msg.event === 'subscribe') {
        console.log(`OKX WS: subscribed to ${msg.arg?.channel} ${msg.arg?.instFamily}`);
        return;
      }

      if (msg.event === 'error') {
        console.error('OKX WS error event:', msg.msg, msg.code);
        return;
      }

      if (msg.data) {
        const family = msg.arg?.instFamily;
        if (family && okxCache[family] !== undefined) {
          for (const item of msg.data) {
            okxCache[family][item.instId] = item;
          }
        }
      }
    });

    ws.on('close', () => {
      clearInterval(heartbeatTimer);
      console.log(`OKX WS: closed, reconnecting in ${reconnectDelay}ms`);
      setTimeout(connect, reconnectDelay);
      reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS);
    });

    ws.on('error', (err) => {
      console.error('OKX WS error:', err.message);
      ws.terminate();
    });
  }

  connect();
}
