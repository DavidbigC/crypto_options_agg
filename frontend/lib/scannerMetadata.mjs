export const SCANNER_ORDER = ['sell', 'gamma', 'vega']

export const SCANNER_META = {
  sell: {
    buttonLabel: 'Dual Invest',
    activeClass: 'bg-sky-600 text-white border-sky-600',
    idleClass: 'text-ink-2 border-rim hover:border-ink-3 hover:text-ink',
    panelTitle: 'Dual Investment',
    panelSubtitle: 'Earn yield by selling higher or buying lower with cash-secured option setups.',
    typeLabels: {
      call: 'Sell High',
      put: 'Buy Low',
    },
  },
  gamma: {
    buttonLabel: 'Gamma Scanner',
    activeClass: 'bg-violet-600 text-white border-violet-600',
    idleClass: 'text-ink-2 border-rim hover:border-ink-3 hover:text-ink',
  },
  vega: {
    buttonLabel: 'V Scanner',
    activeClass: 'bg-emerald-600 text-white border-emerald-600',
    idleClass: 'text-ink-2 border-rim hover:border-ink-3 hover:text-ink',
  },
}
