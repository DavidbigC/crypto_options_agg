import test from 'node:test'
import assert from 'node:assert/strict'

const { collectSortedStrikes, findAtmStrike, getStrikeBand, getOptionMoneyness } = await import('./lib/optionsChainLayout.js')

test('collectSortedStrikes merges calls and puts into a sorted unique list', () => {
  const strikes = collectSortedStrikes({
    calls: [{ strike: 70000 }, { strike: 68000 }],
    puts: [{ strike: 70000 }, { strike: 72000 }],
  })

  assert.deepEqual(strikes, [68000, 70000, 72000])
})

test('findAtmStrike returns null for an empty strike list', () => {
  assert.equal(findAtmStrike([], 70000), null)
})

test('findAtmStrike picks the closest strike to spot', () => {
  assert.equal(findAtmStrike([68000, 70000, 72000], 70950), 70000)
})

test('getStrikeBand returns atm for the atm strike', () => {
  assert.equal(getStrikeBand({ strike: 70000, atmStrike: 70000 }), 'atm')
})

test('getStrikeBand returns itm for strikes below atm', () => {
  assert.equal(getStrikeBand({ strike: 68000, spotPrice: 70000, atmStrike: 70000 }), 'itm')
})

test('getStrikeBand returns otm for strikes above atm', () => {
  assert.equal(getStrikeBand({ strike: 72000, spotPrice: 70000, atmStrike: 70000 }), 'otm')
})

test('getOptionMoneyness classifies calls correctly', () => {
  assert.equal(getOptionMoneyness({ optionType: 'call', strike: 68000, spotPrice: 70000, atmStrike: 70000 }), 'itm')
  assert.equal(getOptionMoneyness({ optionType: 'call', strike: 72000, spotPrice: 70000, atmStrike: 70000 }), 'otm')
})

test('getOptionMoneyness classifies puts correctly', () => {
  assert.equal(getOptionMoneyness({ optionType: 'put', strike: 68000, spotPrice: 70000, atmStrike: 70000 }), 'otm')
  assert.equal(getOptionMoneyness({ optionType: 'put', strike: 72000, spotPrice: 70000, atmStrike: 70000 }), 'itm')
})

test('getOptionMoneyness returns atm for both sides on the atm strike', () => {
  assert.equal(getOptionMoneyness({ optionType: 'call', strike: 70000, spotPrice: 70020, atmStrike: 70000 }), 'atm')
  assert.equal(getOptionMoneyness({ optionType: 'put', strike: 70000, spotPrice: 69980, atmStrike: 70000 }), 'atm')
})
