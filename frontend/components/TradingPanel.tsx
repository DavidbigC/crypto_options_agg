'use client'

import { Exchange } from '@/types/options'

interface TradingPanelProps {
  selectedCrypto: string
  spotPrice?: number
  selectedExpiration: string
  exchange?: Exchange
}

export default function TradingPanel({
  selectedCrypto,
  spotPrice = 0,
  selectedExpiration,
  exchange = 'bybit',
}: TradingPanelProps) {

  return (
    <div className="space-y-4">
      {/* Market Info Card */}
      <div className="card">
        <h3 className="font-semibold text-gray-900 mb-3">Market Overview</h3>
        <div className="space-y-2 text-sm">
          <div className="flex justify-between">
            <span className="text-gray-600">Asset</span>
            <span className="text-gray-900 font-mono">{selectedCrypto}-{exchange === 'okx' ? 'USD' : 'USDT'}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-gray-600">Spot Price</span>
            <span className="text-gray-900 font-mono">${spotPrice.toLocaleString()}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-gray-600">24h Change</span>
            <span className="text-green-600">+2.34%</span>
          </div>
          <div className="flex justify-between">
            <span className="text-gray-600">Implied Vol</span>
            <span className="text-gray-900">78.5%</span>
          </div>
          {selectedExpiration && (
            <div className="flex justify-between">
              <span className="text-gray-600">Expiration</span>
              <span className="text-gray-900">{new Date(selectedExpiration).toLocaleDateString()}</span>
            </div>
          )}
        </div>
      </div>

      {/* Market Analytics */}
      <div className="card">
        <h4 className="font-medium text-gray-900 mb-3">Market Analytics</h4>
        <div className="space-y-2 text-sm">
          <div className="flex justify-between">
            <span className="text-gray-600">Put/Call Ratio</span>
            <span className="text-gray-900">0.87</span>
          </div>
          <div className="flex justify-between">
            <span className="text-gray-600">Max Pain</span>
            <span className="text-gray-900">${(spotPrice * 0.98).toLocaleString()}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-gray-600">IV Rank</span>
            <span className="text-yellow-600">High (89%)</span>
          </div>
          <div className="flex justify-between">
            <span className="text-gray-600">Skew</span>
            <span className="text-gray-900">12.3%</span>
          </div>
        </div>
      </div>

      {/* Greeks Summary */}
      <div className="card">
        <h4 className="font-medium text-gray-900 mb-3">Greeks Overview</h4>
        <div className="space-y-2 text-sm">
          <div className="flex justify-between">
            <span className="text-gray-600">Delta Exposure</span>
            <span className="text-gray-900">+1,248</span>
          </div>
          <div className="flex justify-between">
            <span className="text-gray-600">Gamma Exposure</span>
            <span className="text-gray-900">+0.234</span>
          </div>
          <div className="flex justify-between">
            <span className="text-gray-600">Theta Decay</span>
            <span className="text-red-600">-124.5</span>
          </div>
          <div className="flex justify-between">
            <span className="text-gray-600">Vega Risk</span>
            <span className="text-gray-900">+89.7</span>
          </div>
        </div>
      </div>
    </div>
  )
}