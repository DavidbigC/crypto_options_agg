import { WebSocket } from 'ws'

const WS_URL = 'wss://ws-subscriptions-clob.polymarket.com/ws/market'
const RECONNECT_BASE_MS = 2_000
const RECONNECT_MAX_MS = 60_000

export const polymarketPriceCache = {}

let _socket = null
let _reconnectDelay = RECONNECT_BASE_MS
let _updateCallback = null
const _subscribedAssetIds = new Set()
let _subscribedOnce = false

function toFiniteNumber(value) {
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function midpointFromBook(message) {
  const bids = Array.isArray(message?.buys) ? message.buys : Array.isArray(message?.bids) ? message.bids : []
  const asks = Array.isArray(message?.sells) ? message.sells : Array.isArray(message?.asks) ? message.asks : []

  const bestBid = toFiniteNumber(bids[0]?.price ?? bids[0]?.p ?? bids[0])
  const bestAsk = toFiniteNumber(asks[0]?.price ?? asks[0]?.p ?? asks[0])

  if (Number.isFinite(bestBid) && Number.isFinite(bestAsk) && bestBid >= 0 && bestAsk >= 0) {
    return Number(((bestBid + bestAsk) / 2).toFixed(6))
  }
  if (Number.isFinite(bestBid)) return bestBid
  if (Number.isFinite(bestAsk)) return bestAsk
  return null
}

export function extractPolymarketWsUpdates(message) {
  const messages = Array.isArray(message) ? message : [message]
  const updates = []

  for (const item of messages) {
    if (!item || typeof item !== 'object') continue
    const assetId = item.asset_id ?? item.assetId ?? item.market ?? item.token_id ?? item.tokenId
    if (!assetId) continue

    const directPrice = toFiniteNumber(
      item.price
      ?? item.last_trade_price
      ?? item.lastTradePrice
      ?? item.mid
      ?? item.mid_price
      ?? item.best_ask
      ?? item.bestAsk,
    )
    const bookPrice = directPrice ?? midpointFromBook(item)
    if (!Number.isFinite(bookPrice)) continue

    updates.push({
      assetId: String(assetId),
      price: bookPrice,
      updatedAt: Date.now(),
    })
  }

  return updates
}

function flushSubscriptions() {
  if (!_socket || _socket.readyState !== WebSocket.OPEN || !_subscribedAssetIds.size) return
  if (!_subscribedOnce) {
    _socket.send(JSON.stringify({
      type: 'market',
      assets_ids: Array.from(_subscribedAssetIds),
      custom_feature_enabled: true,
    }))
    _subscribedOnce = true
    return
  }

  _socket.send(JSON.stringify({
    operation: 'subscribe',
    assets_ids: Array.from(_subscribedAssetIds),
    custom_feature_enabled: true,
  }))
}

export function subscribePolymarketAssetIds(assetIds = []) {
  let changed = false
  for (const assetId of assetIds) {
    if (!assetId) continue
    const normalized = String(assetId)
    if (_subscribedAssetIds.has(normalized)) continue
    _subscribedAssetIds.add(normalized)
    changed = true
  }
  if (changed) flushSubscriptions()
}

export function lookupPolymarketPrice(assetId) {
  if (!assetId) return null
  const value = polymarketPriceCache[String(assetId)]
  return Number.isFinite(Number(value?.price)) ? Number(value.price) : null
}

export function setPolymarketUpdateCallback(fn) {
  _updateCallback = fn
}

export function startPolymarketWS() {
  if (_socket && (_socket.readyState === WebSocket.OPEN || _socket.readyState === WebSocket.CONNECTING)) {
    return
  }

  function connect() {
    _socket = new WebSocket(WS_URL)

    _socket.on('open', () => {
      _reconnectDelay = RECONNECT_BASE_MS
      _subscribedOnce = false
      flushSubscriptions()
    })

    _socket.on('message', (raw) => {
      let payload
      try {
        payload = JSON.parse(raw.toString())
      } catch {
        return
      }

      const updates = extractPolymarketWsUpdates(payload)
      for (const update of updates) {
        polymarketPriceCache[update.assetId] = {
          price: update.price,
          updatedAt: update.updatedAt,
        }
        if (_updateCallback) _updateCallback(update.assetId)
      }
    })

    _socket.on('close', () => {
      setTimeout(connect, _reconnectDelay)
      _reconnectDelay = Math.min(_reconnectDelay * 2, RECONNECT_MAX_MS)
    })

    _socket.on('error', () => {
      _socket?.terminate()
    })
  }

  connect()
}
