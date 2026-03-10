'use client'

import { useState } from 'react'
import Header from '@/components/Header'
import TargetInputs from '@/components/optimizer/TargetInputs'
import ResultCard from '@/components/optimizer/ResultCard'
import { OptimizerTargets, OptimizerResult, GreekTarget } from '@/types/optimizer'
import { Exchange } from '@/types/options'

const DEFAULT_TARGETS: OptimizerTargets = {
  delta: 'neutral',
  gamma: 'long',
  vega:  'ignore',
  theta: 'ignore',
}

export default function OptimizerPage() {
  const [coin, setCoin]           = useState<'BTC' | 'ETH' | 'SOL'>('BTC')
  const [targets, setTargets]     = useState<OptimizerTargets>(DEFAULT_TARGETS)
  const [maxCost, setMaxCost]     = useState(0)
  const [maxLegs, setMaxLegs]     = useState(4)
  const [loading, setLoading]     = useState(false)
  const [results, setResults]     = useState<OptimizerResult[]>([])
  const [error, setError]         = useState<string | null>(null)
  const [targetExpiry, setTargetExpiry] = useState('')
  const [exchanges, setExchanges]   = useState<string[]>(['bybit', 'okx', 'deribit'])
  const [spotPrice]               = useState(0)

  const handleTargetChange = (greek: keyof OptimizerTargets, val: GreekTarget) => {
    setTargets(prev => ({ ...prev, [greek]: val }))
  }

  const handleRun = async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(`http://localhost:3500/api/optimizer/${coin}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targets, maxCost, maxLegs, targetExpiry: targetExpiry || null, exchanges }),
      })
      if (!res.ok) throw new Error(`Server error ${res.status}`)
      const data: OptimizerResult[] = await res.json()
      setResults(data)
      if (data.length === 0) setError('No strategies found matching your targets. Try relaxing constraints.')
    } catch (e: any) {
      setError(e.message ?? 'Unknown error')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="min-h-screen bg-surface">
      <Header exchange={'bybit' as Exchange} onExchangeChange={() => {}} />

      <main className="container mx-auto px-4 py-4">
        <div className="flex gap-4 items-start">
          {/* Left panel */}
          <div className="w-72 shrink-0">
            <TargetInputs
              coin={coin}
              targets={targets}
              maxCost={maxCost}
              maxLegs={maxLegs}
              loading={loading}
              onCoinChange={setCoin}
              onTargetChange={handleTargetChange}
              onMaxCostChange={setMaxCost}
              onMaxLegsChange={setMaxLegs}
              targetExpiry={targetExpiry}
              onTargetExpiryChange={setTargetExpiry}
              exchanges={exchanges}
              onExchangeChange={ex => setExchanges(prev =>
                prev.includes(ex)
                  ? prev.length > 1 ? prev.filter(e => e !== ex) : prev  // keep at least 1
                  : [...prev, ex]
              )}
              onRun={handleRun}
            />
          </div>

          {/* Right panel */}
          <div className="flex-1 min-w-0 space-y-3">
            {!loading && results.length === 0 && !error && (
              <div className="card flex items-center justify-center h-48">
                <p className="text-ink-2 text-sm">Set your Greek targets and click Find Strategies.</p>
              </div>
            )}

            {loading && (
              <div className="card flex items-center justify-center h-48">
                <p className="text-ink-2 text-sm">Searching strategies…</p>
              </div>
            )}

            {error && (
              <div className="card text-sm text-rose-600 dark:text-rose-400 p-4">{error}</div>
            )}

            {!loading && results.map((r, i) => (
              <ResultCard
                key={`${r.name}-${i}`}
                result={r}
                targets={targets}
                rank={i + 1}
                coin={coin}
                spotPrice={spotPrice}
              />
            ))}
          </div>
        </div>
      </main>
    </div>
  )
}
