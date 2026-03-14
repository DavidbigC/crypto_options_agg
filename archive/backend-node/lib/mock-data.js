/**
 * Mock data for demo mode when API is not accessible
 */

export const mockSpotPrices = {
  BTCUSDT: 109650.0,
  ETHUSDT: 4475.0,
  SOLUSDT: 203.5
};

export const mockOptionData = {
  BTC: {
    spotPrice: 109650.0,
    expirations: ['2025-09-01', '2025-09-02', '2025-09-03', '2025-09-05', '2025-09-12'],
    data: {
      '2025-09-01': {
        calls: [
          {
            symbol: 'BTC-1SEP25-105000-C',
            strike: 105000,
            optionType: 'call',
            bid: 5200.0,
            ask: 5300.0,
            last: 5250.0,
            volume: 125.5,
            bidSize: 2.5,
            askSize: 3.2,
            delta: 0.85,
            gamma: 0.00012,
            theta: -15.2,
            vega: 8.5,
            impliedVolatility: 0.785,
            openInterest: 450,
            markPrice: 5275.0
          },
          {
            symbol: 'BTC-1SEP25-107000-C',
            strike: 107000,
            optionType: 'call',
            bid: 3800.0,
            ask: 3900.0,
            last: 3850.0,
            volume: 95.2,
            bidSize: 1.8,
            askSize: 2.1,
            delta: 0.72,
            gamma: 0.00015,
            theta: -18.5,
            vega: 12.3,
            impliedVolatility: 0.812,
            openInterest: 320,
            markPrice: 3875.0
          },
          {
            symbol: 'BTC-1SEP25-109000-C',
            strike: 109000,
            optionType: 'call',
            bid: 2200.0,
            ask: 2300.0,
            last: 2250.0,
            volume: 78.9,
            bidSize: 1.2,
            askSize: 1.5,
            delta: 0.55,
            gamma: 0.00018,
            theta: -22.1,
            vega: 15.8,
            impliedVolatility: 0.845,
            openInterest: 280,
            markPrice: 2275.0
          },
          {
            symbol: 'BTC-1SEP25-111000-C',
            strike: 111000,
            optionType: 'call',
            bid: 1200.0,
            ask: 1300.0,
            last: 1250.0,
            volume: 45.3,
            bidSize: 0.8,
            askSize: 1.0,
            delta: 0.38,
            gamma: 0.00019,
            theta: -25.8,
            vega: 18.2,
            impliedVolatility: 0.878,
            openInterest: 195,
            markPrice: 1275.0
          }
        ],
        puts: [
          {
            symbol: 'BTC-1SEP25-105000-P',
            strike: 105000,
            optionType: 'put',
            bid: 450.0,
            ask: 550.0,
            last: 500.0,
            volume: 89.7,
            bidSize: 1.5,
            askSize: 2.0,
            delta: -0.15,
            gamma: 0.00012,
            theta: -12.5,
            vega: 8.5,
            impliedVolatility: 0.785,
            openInterest: 380,
            markPrice: 525.0
          },
          {
            symbol: 'BTC-1SEP25-107000-P',
            strike: 107000,
            optionType: 'put',
            bid: 850.0,
            ask: 950.0,
            last: 900.0,
            volume: 112.4,
            bidSize: 2.1,
            askSize: 2.8,
            delta: -0.28,
            gamma: 0.00015,
            theta: -15.8,
            vega: 12.3,
            impliedVolatility: 0.812,
            openInterest: 425,
            markPrice: 925.0
          },
          {
            symbol: 'BTC-1SEP25-109000-P',
            strike: 109000,
            optionType: 'put',
            bid: 1550.0,
            ask: 1650.0,
            last: 1600.0,
            volume: 134.8,
            bidSize: 2.5,
            askSize: 3.2,
            delta: -0.45,
            gamma: 0.00018,
            theta: -19.2,
            vega: 15.8,
            impliedVolatility: 0.845,
            openInterest: 510,
            markPrice: 1625.0
          },
          {
            symbol: 'BTC-1SEP25-111000-P',
            strike: 111000,
            optionType: 'put',
            bid: 2550.0,
            ask: 2650.0,
            last: 2600.0,
            volume: 156.2,
            bidSize: 3.0,
            askSize: 3.8,
            delta: -0.62,
            gamma: 0.00019,
            theta: -22.8,
            vega: 18.2,
            impliedVolatility: 0.878,
            openInterest: 640,
            markPrice: 2625.0
          }
        ]
      },
      '2025-09-02': {
        calls: [
          {
            symbol: 'BTC-2SEP25-108000-C',
            strike: 108000,
            optionType: 'call',
            bid: 3100.0,
            ask: 3200.0,
            last: 3150.0,
            volume: 89.3,
            bidSize: 1.2,
            askSize: 1.5,
            delta: 0.68,
            gamma: 0.00014,
            theta: -12.8,
            vega: 11.2,
            impliedVolatility: 0.792,
            openInterest: 285,
            markPrice: 3175.0
          },
          {
            symbol: 'BTC-2SEP25-110000-C',
            strike: 110000,
            optionType: 'call',
            bid: 1800.0,
            ask: 1900.0,
            last: 1850.0,
            volume: 65.7,
            bidSize: 0.9,
            askSize: 1.2,
            delta: 0.52,
            gamma: 0.00017,
            theta: -15.5,
            vega: 14.8,
            impliedVolatility: 0.825,
            openInterest: 192,
            markPrice: 1875.0
          }
        ],
        puts: [
          {
            symbol: 'BTC-2SEP25-108000-P',
            strike: 108000,
            optionType: 'put',
            bid: 950.0,
            ask: 1050.0,
            last: 1000.0,
            volume: 102.4,
            bidSize: 1.8,
            askSize: 2.3,
            delta: -0.32,
            gamma: 0.00014,
            theta: -10.2,
            vega: 11.2,
            impliedVolatility: 0.792,
            openInterest: 367,
            markPrice: 1025.0
          },
          {
            symbol: 'BTC-2SEP25-110000-P',
            strike: 110000,
            optionType: 'put',
            bid: 1950.0,
            ask: 2050.0,
            last: 2000.0,
            volume: 87.9,
            bidSize: 2.1,
            askSize: 2.7,
            delta: -0.48,
            gamma: 0.00017,
            theta: -13.5,
            vega: 14.8,
            impliedVolatility: 0.825,
            openInterest: 453,
            markPrice: 2025.0
          }
        ]
      },
      '2025-09-03': {
        calls: [
          {
            symbol: 'BTC-3SEP25-109000-C',
            strike: 109000,
            optionType: 'call',
            bid: 2400.0,
            ask: 2500.0,
            last: 2450.0,
            volume: 112.8,
            bidSize: 1.5,
            askSize: 1.9,
            delta: 0.58,
            gamma: 0.00016,
            theta: -18.2,
            vega: 13.5,
            impliedVolatility: 0.808,
            openInterest: 328,
            markPrice: 2475.0
          }
        ],
        puts: [
          {
            symbol: 'BTC-3SEP25-109000-P',
            strike: 109000,
            optionType: 'put',
            bid: 1750.0,
            ask: 1850.0,
            last: 1800.0,
            volume: 94.6,
            bidSize: 2.0,
            askSize: 2.4,
            delta: -0.42,
            gamma: 0.00016,
            theta: -16.8,
            vega: 13.5,
            impliedVolatility: 0.808,
            openInterest: 412,
            markPrice: 1825.0
          }
        ]
      },
      '2025-09-05': {
        calls: [
          {
            symbol: 'BTC-5SEP25-107000-C',
            strike: 107000,
            optionType: 'call',
            bid: 4200.0,
            ask: 4300.0,
            last: 4250.0,
            volume: 78.9,
            bidSize: 1.1,
            askSize: 1.4,
            delta: 0.75,
            gamma: 0.00013,
            theta: -22.1,
            vega: 15.2,
            impliedVolatility: 0.785,
            openInterest: 256,
            markPrice: 4275.0
          }
        ],
        puts: [
          {
            symbol: 'BTC-5SEP25-107000-P',
            strike: 107000,
            optionType: 'put',
            bid: 650.0,
            ask: 750.0,
            last: 700.0,
            volume: 143.2,
            bidSize: 2.8,
            askSize: 3.5,
            delta: -0.25,
            gamma: 0.00013,
            theta: -19.8,
            vega: 15.2,
            impliedVolatility: 0.785,
            openInterest: 589,
            markPrice: 725.0
          }
        ]
      },
      '2025-09-12': {
        calls: [
          {
            symbol: 'BTC-12SEP25-105000-C',
            strike: 105000,
            optionType: 'call',
            bid: 6800.0,
            ask: 6900.0,
            last: 6850.0,
            volume: 45.3,
            bidSize: 0.8,
            askSize: 1.0,
            delta: 0.82,
            gamma: 0.00011,
            theta: -28.5,
            vega: 18.7,
            impliedVolatility: 0.772,
            openInterest: 189,
            markPrice: 6875.0
          }
        ],
        puts: [
          {
            symbol: 'BTC-12SEP25-105000-P',
            strike: 105000,
            optionType: 'put',
            bid: 350.0,
            ask: 450.0,
            last: 400.0,
            volume: 167.8,
            bidSize: 3.2,
            askSize: 4.1,
            delta: -0.18,
            gamma: 0.00011,
            theta: -25.2,
            vega: 18.7,
            impliedVolatility: 0.772,
            openInterest: 634,
            markPrice: 425.0
          }
        ]
      }
    }
  },
  ETH: {
    spotPrice: 4475.0,
    expirations: ['2025-09-01', '2025-09-02', '2025-09-03', '2025-09-05', '2025-09-12'],
    data: {
      '2025-09-01': {
        calls: [
          {
            symbol: 'ETH-1SEP25-4200-C',
            strike: 4200,
            optionType: 'call',
            bid: 320.0,
            ask: 340.0,
            last: 330.0,
            volume: 45.2,
            bidSize: 5.0,
            askSize: 6.5,
            delta: 0.78,
            gamma: 0.0008,
            theta: -2.1,
            vega: 1.8,
            impliedVolatility: 0.695,
            openInterest: 180,
            markPrice: 335.0
          },
          {
            symbol: 'ETH-1SEP25-4400-C',
            strike: 4400,
            optionType: 'call',
            bid: 180.0,
            ask: 200.0,
            last: 190.0,
            volume: 32.8,
            bidSize: 3.2,
            askSize: 4.1,
            delta: 0.58,
            gamma: 0.0012,
            theta: -2.8,
            vega: 2.5,
            impliedVolatility: 0.728,
            openInterest: 125,
            markPrice: 195.0
          }
        ],
        puts: [
          {
            symbol: 'ETH-1SEP25-4200-P',
            strike: 4200,
            optionType: 'put',
            bid: 45.0,
            ask: 55.0,
            last: 50.0,
            volume: 28.5,
            bidSize: 4.0,
            askSize: 5.2,
            delta: -0.22,
            gamma: 0.0008,
            theta: -1.8,
            vega: 1.8,
            impliedVolatility: 0.695,
            openInterest: 95,
            markPrice: 52.5
          },
          {
            symbol: 'ETH-1SEP25-4400-P',
            strike: 4400,
            optionType: 'put',
            bid: 105.0,
            ask: 125.0,
            last: 115.0,
            volume: 41.2,
            bidSize: 5.8,
            askSize: 7.2,
            delta: -0.42,
            gamma: 0.0012,
            theta: -2.5,
            vega: 2.5,
            impliedVolatility: 0.728,
            openInterest: 165,
            markPrice: 120.0
          }
        ]
      }
    }
  }
};

export function getMockOptionsData(baseCoin) {
  const data = mockOptionData[baseCoin];
  if (!data) return null;

  // Calculate expiration counts
  const expirationCounts = {};
  for (const [expiry, chainData] of Object.entries(data.data)) {
    expirationCounts[expiry] = {
      calls: chainData.calls.length,
      puts: chainData.puts.length
    };
  }

  return {
    spotPrice: data.spotPrice,
    expirations: data.expirations,
    expirationCounts,
    data: data.data
  };
}