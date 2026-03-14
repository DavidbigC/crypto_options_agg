/**
 * Utility functions for the Bybit Options backend
 */

/**
 * Calculate time until expiration
 */
export function calculateTimeToExpiration(expirationDate) {
  const now = new Date();
  const expiry = new Date(expirationDate + 'T08:00:00.000Z'); // Assuming 8:00 UTC expiration
  const diffMs = expiry.getTime() - now.getTime();
  
  if (diffMs <= 0) {
    return { expired: true, days: 0, hours: 0, minutes: 0 };
  }
  
  const days = Math.floor(diffMs / (1000 * 60 * 60 * 24));
  const hours = Math.floor((diffMs % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
  const minutes = Math.floor((diffMs % (1000 * 60 * 60)) / (1000 * 60));
  
  return { expired: false, days, hours, minutes };
}

/**
 * Format number with appropriate precision
 */
export function formatNumber(value, decimals = 4) {
  if (value === 0 || value === null || value === undefined) {
    return '0';
  }
  
  if (value < 0.0001) {
    return value.toExponential(2);
  }
  
  return parseFloat(value).toFixed(decimals);
}

/**
 * Calculate mid price from bid/ask
 */
export function calculateMidPrice(bid, ask) {
  if (!bid || !ask || bid <= 0 || ask <= 0) {
    return 0;
  }
  return (parseFloat(bid) + parseFloat(ask)) / 2;
}

/**
 * Determine if option is in-the-money
 */
export function isITM(optionType, strike, spotPrice) {
  if (optionType.toLowerCase() === 'call') {
    return strike < spotPrice;
  } else {
    return strike > spotPrice;
  }
}

/**
 * Calculate option's intrinsic value
 */
export function calculateIntrinsicValue(optionType, strike, spotPrice) {
  if (optionType.toLowerCase() === 'call') {
    return Math.max(0, spotPrice - strike);
  } else {
    return Math.max(0, strike - spotPrice);
  }
}

/**
 * Group options by strike price
 */
export function groupOptionsByStrike(calls, puts) {
  const strikes = new Set();
  
  calls.forEach(call => strikes.add(call.strike));
  puts.forEach(put => strikes.add(put.strike));
  
  const sortedStrikes = Array.from(strikes).sort((a, b) => a - b);
  
  const callsMap = new Map();
  const putsMap = new Map();
  
  calls.forEach(call => callsMap.set(call.strike, call));
  puts.forEach(put => putsMap.set(put.strike, put));
  
  return sortedStrikes.map(strike => ({
    strike,
    call: callsMap.get(strike) || null,
    put: putsMap.get(strike) || null,
  }));
}

/**
 * Find the at-the-money (ATM) strike
 */
export function findATMStrike(strikes, spotPrice) {
  return strikes.reduce((prev, curr) => 
    Math.abs(curr - spotPrice) < Math.abs(prev - spotPrice) ? curr : prev
  );
}

/**
 * Calculate option Greeks (simplified Black-Scholes approximation)
 */
export function calculateGreeks(optionType, strike, spotPrice, timeToExpiry, volatility, riskFreeRate = 0.05) {
  // This is a simplified implementation
  // In production, you'd want to use a proper financial library
  
  if (timeToExpiry <= 0) {
    return { delta: 0, gamma: 0, theta: 0, vega: 0 };
  }
  
  const S = spotPrice;
  const K = strike;
  const T = timeToExpiry;
  const sigma = volatility;
  const r = riskFreeRate;
  
  const d1 = (Math.log(S / K) + (r + sigma * sigma / 2) * T) / (sigma * Math.sqrt(T));
  const d2 = d1 - sigma * Math.sqrt(T);
  
  // Simplified Greeks calculation
  const isCall = optionType.toLowerCase() === 'call';
  
  const delta = isCall ? normCDF(d1) : normCDF(d1) - 1;
  const gamma = normPDF(d1) / (S * sigma * Math.sqrt(T));
  const theta = isCall ? 
    -(S * normPDF(d1) * sigma) / (2 * Math.sqrt(T)) - r * K * Math.exp(-r * T) * normCDF(d2) :
    -(S * normPDF(d1) * sigma) / (2 * Math.sqrt(T)) + r * K * Math.exp(-r * T) * normCDF(-d2);
  const vega = S * normPDF(d1) * Math.sqrt(T);
  
  return { delta, gamma, theta: theta / 365, vega: vega / 100 };
}

/**
 * Normal cumulative distribution function
 */
function normCDF(x) {
  return (1.0 + erf(x / Math.sqrt(2.0))) / 2.0;
}

/**
 * Normal probability density function
 */
function normPDF(x) {
  return Math.exp(-x * x / 2.0) / Math.sqrt(2.0 * Math.PI);
}

/**
 * Error function approximation
 */
function erf(x) {
  const a1 =  0.254829592;
  const a2 = -0.284496736;
  const a3 =  1.421413741;
  const a4 = -1.453152027;
  const a5 =  1.061405429;
  const p  =  0.3275911;

  const sign = x < 0 ? -1 : 1;
  x = Math.abs(x);

  const t = 1.0 / (1.0 + p * x);
  const y = 1.0 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);

  return sign * y;
}

/**
 * Validate and sanitize option data
 */
export function sanitizeOptionData(option) {
  return {
    ...option,
    bid: Math.max(0, parseFloat(option.bid || 0)),
    ask: Math.max(0, parseFloat(option.ask || 0)),
    last: Math.max(0, parseFloat(option.last || 0)),
    volume: Math.max(0, parseFloat(option.volume || 0)),
    delta: parseFloat(option.delta || 0),
    gamma: parseFloat(option.gamma || 0),
    theta: parseFloat(option.theta || 0),
    vega: parseFloat(option.vega || 0),
  };
}