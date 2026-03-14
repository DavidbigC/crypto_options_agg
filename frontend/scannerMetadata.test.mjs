import test from 'node:test'
import assert from 'node:assert/strict'

const { SCANNER_ORDER, SCANNER_META } = await import('./lib/scannerMetadata.mjs')

test('dual investment scanner metadata leads toolbar and uses exchange-style copy', () => {
  assert.deepEqual(
    SCANNER_ORDER.map((key) => SCANNER_META[key].buttonLabel),
    ['Dual Invest', 'Gamma Scanner', 'V Scanner'],
  )
  assert.equal(SCANNER_ORDER[0], 'sell')
  assert.equal(SCANNER_META.sell.panelTitle, 'Dual Investment')
  assert.equal(
    SCANNER_META.sell.panelSubtitle,
    'Earn yield by selling higher or buying lower with cash-secured option setups.',
  )
  assert.deepEqual(SCANNER_META.sell.typeLabels, {
    call: 'Sell High',
    put: 'Buy Low',
  })
})
