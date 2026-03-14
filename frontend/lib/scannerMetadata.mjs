export const SCANNER_ORDER = ['sell', 'gamma', 'vega']

export const SCANNER_META = {
  sell: {
    buttonLabel: 'Dual Income',
    activeClass: 'bg-card text-ink border-rim shadow-sm ring-1 ring-rim',
    idleClass: 'text-ink-2 border-rim hover:bg-card hover:text-ink',
    panelTitle: 'Dual Investment',
    panelSubtitle: 'Earn yield by selling higher or buying lower with cash-secured option setups.',
    typeLabels: {
      call: 'Sell High',
      put: 'Buy Low',
    },
  },
  gamma: {
    buttonLabel: 'Gamma Lens',
    activeClass: 'bg-card text-ink border-rim shadow-sm ring-1 ring-rim',
    idleClass: 'text-ink-2 border-rim hover:bg-card hover:text-ink',
  },
  vega: {
    buttonLabel: 'Vega Lens',
    activeClass: 'bg-card text-ink border-rim shadow-sm ring-1 ring-rim',
    idleClass: 'text-ink-2 border-rim hover:bg-card hover:text-ink',
  },
}
