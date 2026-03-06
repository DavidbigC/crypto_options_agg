/**
 * Bybit Options API Client - Using axios for better networking
 */

import axios from 'axios';

export class BybitOptionsAPI {
  constructor() {
    this.baseURL = 'https://api.bybit.com/v5';
    this.client = axios.create({
      baseURL: this.baseURL,
      timeout: 30000, // 30 second timeout
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'Bybit-Options-Client/1.0.0',
        'Connection': 'keep-alive',
      }
    });

    // Add request interceptor for logging
    this.client.interceptors.request.use((config) => {
      console.log(`API Request: ${config.method.toUpperCase()} ${config.baseURL}${config.url}${config.params ? '?' + new URLSearchParams(config.params).toString() : ''}`);
      return config;
    });

    // Add response interceptor for logging
    this.client.interceptors.response.use(
      (response) => {
        console.log(`API Response: ${response.status} ${response.config.url}`);
        return response;
      },
      (error) => {
        if (error.response) {
          console.error(`API Error Response: ${error.response.status} ${error.response.config.url}`);
          console.error('Response data:', error.response.data);
        } else if (error.request) {
          console.error(`API Request Error: ${error.message} (${error.config?.url || 'unknown'})`);
        } else {
          console.error(`API Setup Error: ${error.message}`);
        }
        return Promise.reject(error);
      }
    );
  }

  /**
   * Make HTTP GET request
   */
  async makeRequest(endpoint, params = {}) {
    try {
      const response = await this.client.get(endpoint, { params });
      return response.data;
    } catch (error) {
      if (error.code === 'ECONNABORTED') {
        throw new Error('Request timeout - API server may be slow');
      } else if (error.response) {
        throw new Error(`HTTP ${error.response.status}: ${error.response.data?.retMsg || error.response.statusText}`);
      } else if (error.request) {
        throw new Error(`Network error: ${error.message}`);
      } else {
        throw new Error(`Request setup error: ${error.message}`);
      }
    }
  }

  /**
   * Get available options instruments for the specified base coin
   */
  async getInstrumentsInfo(baseCoin = 'BTC') {
    try {
      const response = await this.makeRequest('/market/instruments-info', {
        category: 'option',
        baseCoin: baseCoin,
      });

      if (response.retCode !== 0) {
        throw new Error(`API Error: ${response.retMsg}`);
      }

      return response.result?.list || [];
    } catch (error) {
      console.error('Error fetching instruments info:', error.message);
      throw error;
    }
  }

  /**
   * Get ticker data for all options of the specified base coin
   */
  async getOptionsTickers(baseCoin = 'BTC') {
    try {
      const response = await this.makeRequest('/market/tickers', {
        category: 'option',
        baseCoin: baseCoin,
      });

      if (response.retCode !== 0) {
        throw new Error(`API Error: ${response.retMsg}`);
      }

      return response.result?.list || [];
    } catch (error) {
      console.error('Error fetching options tickers:', error.message);
      throw error;
    }
  }

  /**
   * Get current spot price for the underlying asset
   */
  async getSpotPrice(symbol = 'BTCUSDT') {
    try {
      const response = await this.makeRequest('/market/tickers', {
        category: 'spot',
        symbol: symbol,
      });

      if (response.retCode !== 0) {
        throw new Error(`API Error: ${response.retMsg || 'Unknown error'}`);
      }

      const tickers = response.result?.list || [];
      if (tickers.length > 0) {
        return parseFloat(tickers[0].lastPrice || 0);
      }
      
      return 0.0;
    } catch (error) {
      console.error('Error fetching spot price:', error.message);
      throw error;
    }
  }

  /**
   * Parse Bybit option symbol to extract date, strike, and type
   * Format examples: BTC-27MAR26-70000-P or BTC-5SEP25-109000-C-USDT
   */
  parseOptionSymbol(symbol) {
    try {
      const parts = symbol.split('-');
      if (parts.length < 4) {
        return null;
      }

      const base = parts[0];
      const dateStr = parts[1]; // e.g., "27MAR26" or "5SEP25"
      const strike = parseFloat(parts[2]);
      const optionType = parts[3] === 'C' ? 'CALL' : 'PUT';

      // Parse date format DDMMMYY or DMMMYY (e.g., 27MAR26 or 5SEP25)
      let day, monthStr, year;

      if (dateStr.length === 6) {
        // DMMMYY format (e.g., 5SEP25)
        day = parseInt(dateStr.substring(0, 1));
        monthStr = dateStr.substring(1, 4);
        year = parseInt('20' + dateStr.substring(4, 6));
      } else if (dateStr.length === 7) {
        // DDMMMYY format (e.g., 27MAR26)
        day = parseInt(dateStr.substring(0, 2));
        monthStr = dateStr.substring(2, 5);
        year = parseInt('20' + dateStr.substring(5, 7));
      } else {
        return null;
      }

      // Convert month abbreviation to number
      const months = {
        'JAN': 1, 'FEB': 2, 'MAR': 3, 'APR': 4, 'MAY': 5, 'JUN': 6,
        'JUL': 7, 'AUG': 8, 'SEP': 9, 'OCT': 10, 'NOV': 11, 'DEC': 12
      };

      const month = months[monthStr];
      if (!month) {
        return null;
      }

      const expiryDate = `${year}-${month.toString().padStart(2, '0')}-${day.toString().padStart(2, '0')}`;

      return {
        expiryDate,
        strikePrice: strike,
        optionType,
        symbol,
        baseCoin: base
      };

    } catch (error) {
      console.error('Error parsing option symbol:', symbol, error.message);
      return null;
    }
  }

  /**
   * Get multiple spot prices at once
   */
  async getMultipleSpotPrices(symbols) {
    try {
      const promises = symbols.map(symbol => this.getSpotPrice(symbol));
      const results = await Promise.allSettled(promises);
      
      const prices = {};
      results.forEach((result, index) => {
        if (result.status === 'fulfilled') {
          prices[symbols[index]] = result.value;
        } else {
          console.error(`Failed to fetch price for ${symbols[index]}:`, result.reason.message);
          prices[symbols[index]] = 0;
        }
      });

      return prices;
    } catch (error) {
      console.error('Error fetching multiple spot prices:', error.message);
      throw error;
    }
  }
}