/**
 * Shared exchange color constants — single source of truth.
 * Bybit = amber, OKX = zinc, Deribit = blue
 */

/** Solid badge: colored bg + white text */
export const EX_BADGE: Record<string, string> = {
  bybit:    'bg-amber-500 text-white',
  okx:      'bg-zinc-600  text-white',
  deribit:  'bg-blue-600  text-white',
  derive:   'bg-pink-500  text-white',
  combined: 'bg-zinc-500  text-white',
}

/** Soft badge: translucent bg + colored text */
export const EX_SOFT: Record<string, string> = {
  bybit:    'bg-amber-500/20 text-amber-600 dark:text-amber-400',
  okx:      'bg-zinc-500/20  text-zinc-500',
  deribit:  'bg-blue-600/20  text-blue-600  dark:text-blue-400',
  derive:   'bg-pink-500/20  text-pink-600  dark:text-pink-400',
  combined: 'bg-zinc-500/20  text-zinc-500',
}

/** Active/selected state for toggle buttons */
export const EX_ACTIVE: Record<string, string> = {
  bybit:    'bg-amber-500 text-white',
  okx:      'bg-zinc-600  text-white',
  deribit:  'bg-blue-600  text-white',
  derive:   'bg-pink-500  text-white',
  combined: 'bg-zinc-500  text-white',
}

/** Full display name */
export const EX_NAME: Record<string, string> = {
  bybit: 'Bybit', okx: 'OKX', deribit: 'Deribit', derive: 'Derive', combined: 'All',
}

/** Short label */
export const EX_LABEL: Record<string, string> = {
  bybit: 'BYB', okx: 'OKX', deribit: 'DER', derive: 'DRV', combined: 'ALL',
}
