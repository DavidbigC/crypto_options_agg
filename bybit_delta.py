#!/usr/bin/env python3
"""
Bybit Delta Scanner - Find best delta/price ratios across all available markets
"""

import requests
import json
from typing import Dict, List, Optional
from datetime import datetime
from collections import defaultdict
import time

class BybitDeltaScanner:
    def __init__(self):
        self.base_url = "https://api.bybit.com/v5"
        self.available_coins = []
    
    def get_available_base_coins(self) -> List[str]:
        """Get all available base coins for options"""
        url = f"{self.base_url}/market/instruments-info"
        params = {"category": "option"}
        
        try:
            response = requests.get(url, params=params)
            response.raise_for_status()
            data = response.json()
            
            if data.get("retCode") != 0:
                print(f"API Error: {data.get('retMsg')}")
                # Fallback to common coins
                return ["BTC", "ETH"]
            
            instruments = data.get("result", {}).get("list", [])
            base_coins = set()
            
            for instrument in instruments:
                base_coin = instrument.get("baseCoin", "")
                if base_coin:
                    base_coins.add(base_coin)
            
            found_coins = sorted(list(base_coins))
            print(f"🔍 Debug: Found {len(found_coins)} base coins: {found_coins}")
            
            # Ensure BTC and ETH are always included if we found any coins
            if found_coins:
                essential_coins = ["BTC", "ETH"]
                for coin in essential_coins:
                    if coin not in found_coins:
                        found_coins.append(coin)
                found_coins = sorted(found_coins)
            
            return found_coins if found_coins else ["BTC", "ETH"]
            
        except Exception as e:
            print(f"Error fetching available coins: {e}")
            # Fallback to common coins
            return ["BTC", "ETH"]
    
    def get_spot_price(self, symbol: str) -> float:
        """Get current spot price for the underlying asset"""
        url = f"{self.base_url}/market/tickers"
        params = {
            "category": "spot",
            "symbol": symbol
        }
        
        try:
            response = requests.get(url, params=params)
            response.raise_for_status()
            data = response.json()
            
            if data.get("retCode") != 0:
                return 0.0
            
            tickers = data.get("result", {}).get("list", [])
            if tickers:
                return float(tickers[0].get("lastPrice", 0))
            return 0.0
            
        except Exception as e:
            print(f"Error fetching spot price for {symbol}: {e}")
            return 0.0
    
    def get_options_tickers(self, base_coin: str) -> List[Dict]:
        """Get ticker data for all options of the specified base coin"""
        url = f"{self.base_url}/market/tickers"
        params = {
            "category": "option",
            "baseCoin": base_coin
        }
        
        try:
            response = requests.get(url, params=params)
            response.raise_for_status()
            data = response.json()
            
            if data.get("retCode") != 0:
                print(f"API Error for {base_coin}: {data.get('retMsg')}")
                return []
            
            return data.get("result", {}).get("list", [])
            
        except Exception as e:
            print(f"Error fetching {base_coin} options: {e}")
            return []
    
    def parse_option_symbol(self, symbol: str) -> Dict:
        """Parse Bybit option symbol to extract date, strike, and type"""
        parts = symbol.split('-')
        if len(parts) < 4:
            return {}
        
        try:
            base = parts[0]
            date_str = parts[1]
            strike = float(parts[2])
            option_type = "CALL" if parts[3] == "C" else "PUT"
            
            # Parse date format DDMMMYY or DMMMYY
            if len(date_str) == 6:  # DMMMYY format
                day = int(date_str[:1])
                month_str = date_str[1:4]
                year = int("20" + date_str[4:6])
            elif len(date_str) == 7:  # DDMMMYY format
                day = int(date_str[:2])
                month_str = date_str[2:5]
                year = int("20" + date_str[5:7])
            else:
                return {}
            
            months = {
                'JAN': 1, 'FEB': 2, 'MAR': 3, 'APR': 4, 'MAY': 5, 'JUN': 6,
                'JUL': 7, 'AUG': 8, 'SEP': 9, 'OCT': 10, 'NOV': 11, 'DEC': 12
            }
            month = months.get(month_str, 1)
            
            expiry_date = f"{year}-{month:02d}-{day:02d}"
            
            return {
                "expiry_date": expiry_date,
                "strike_price": strike,
                "option_type": option_type,
                "symbol": symbol,
                "base_coin": base
            }
        except (ValueError, IndexError, KeyError):
            return {}
    
    def calculate_delta_price_ratios(self, base_coin: str, spot_price: float) -> List[Dict]:
        """Calculate delta/price ratios for all options of a base coin"""
        tickers = self.get_options_tickers(base_coin)
        if not tickers:
            return []
        
        ratios = []
        
        for ticker in tickers:
            symbol = ticker.get("symbol", "")
            parsed = self.parse_option_symbol(symbol)
            if not parsed:
                continue
            
            ask = float(ticker.get("ask1Price", 0))
            delta = float(ticker.get("delta", 0))
            volume = float(ticker.get("volume24h", 0))
            
            if ask > 0 and abs(delta) > 0:
                abs_delta = abs(delta)
                ratio = abs_delta / ask
                
                # Calculate distance from spot
                strike = parsed["strike_price"]
                distance_pct = ((strike - spot_price) / spot_price) * 100
                
                # Determine ITM/OTM
                if parsed["option_type"] == "CALL":
                    itm_otm = "ITM" if strike < spot_price else "OTM"
                else:  # PUT
                    itm_otm = "ITM" if strike > spot_price else "OTM"
                
                ratios.append({
                    "base_coin": base_coin,
                    "symbol": symbol,
                    "expiry_date": parsed["expiry_date"],
                    "option_type": parsed["option_type"],
                    "strike": strike,
                    "ask": ask,
                    "delta": delta,
                    "abs_delta": abs_delta,
                    "ratio": ratio,
                    "volume": volume,
                    "spot_price": spot_price,
                    "distance_pct": distance_pct,
                    "itm_otm": itm_otm
                })
        
        return ratios
    
    def scan_all_markets(self) -> List[Dict]:
        """Scan all available markets for best delta/price ratios"""
        print("🔍 Scanning all available markets...")
        
        # Get available base coins
        base_coins = self.get_available_base_coins()
        if not base_coins:
            print("❌ No base coins found")
            return []
        
        print(f"📊 Found {len(base_coins)} markets: {', '.join(base_coins)}")
        
        all_ratios = []
        
        for i, base_coin in enumerate(base_coins, 1):
            print(f"[{i}/{len(base_coins)}] Processing {base_coin}...")
            
            # Get spot price
            spot_symbol = f"{base_coin}USDT"
            spot_price = self.get_spot_price(spot_symbol)
            
            if spot_price == 0:
                print(f"   ⚠️  Could not get spot price for {base_coin}")
                continue
            
            # Calculate ratios for this market
            ratios = self.calculate_delta_price_ratios(base_coin, spot_price)
            all_ratios.extend(ratios)
            
            print(f"   ✅ Found {len(ratios)} options for {base_coin} (Spot: ${spot_price:,.2f})")
            
            # Small delay to avoid rate limiting
            time.sleep(0.1)
        
        return all_ratios
    
    def display_best_ratios(self, all_ratios: List[Dict], top_n: int = 20):
        """Display the best delta/price ratios across all markets"""
        if not all_ratios:
            print("❌ No options data found")
            return
        
        # Sort by ratio (highest first)
        sorted_ratios = sorted(all_ratios, key=lambda x: x["ratio"], reverse=True)
        
        # Separate calls and puts
        calls = [r for r in sorted_ratios if r["option_type"] == "CALL"]
        puts = [r for r in sorted_ratios if r["option_type"] == "PUT"]
        
        print(f"\n{'='*100}")
        print(f"🏆 TOP {top_n} BEST DELTA/ASK RATIOS ACROSS ALL MARKETS")
        print(f"{'='*100}")
        
        # Display best calls
        print(f"\n📈 BEST CALLS:")
        print(f"{'Rank':<4} {'Market':<6} {'Strike':<10} {'Expiry':<12} {'Ask':<12} {'Delta':<10} {'Ratio':<10} {'Distance':<10} {'Volume':<8}")
        print("-" * 100)
        
        for i, option in enumerate(calls[:top_n], 1):
            print(f"{i:<4} {option['base_coin']:<6} ${option['strike']:<9.0f} {option['expiry_date']:<12} ${option['ask']:<11.5f} {option['delta']:<9.5f} {option['ratio']:<9.5f} {option['distance_pct']:+6.1f}% {option['itm_otm']:<3} {option['volume']:<8.0f}")
        
        # Display best puts
        print(f"\n📉 BEST PUTS:")
        print(f"{'Rank':<4} {'Market':<6} {'Strike':<10} {'Expiry':<12} {'Ask':<12} {'Delta':<10} {'Ratio':<10} {'Distance':<10} {'Volume':<8}")
        print("-" * 100)
        
        for i, option in enumerate(puts[:top_n], 1):
            print(f"{i:<4} {option['base_coin']:<6} ${option['strike']:<9.0f} {option['expiry_date']:<12} ${option['ask']:<11.5f} {option['delta']:<9.5f} {option['ratio']:<9.5f} {option['distance_pct']:+6.1f}% {option['itm_otm']:<3} {option['volume']:<8.0f}")
        
        # Overall top recommendations
        print(f"\n🎯 OVERALL TOP 3 RECOMMENDATIONS (All Markets):")
        print("=" * 60)
        
        for i, option in enumerate(sorted_ratios[:3], 1):
            print(f"{i}. {option['base_coin']} {option['option_type']} ${option['strike']:.0f} exp:{option['expiry_date']}")
            print(f"   Ask: ${option['ask']:.5f} | Delta: {option['delta']:.5f} | Ratio: {option['ratio']:.5f}")
            print(f"   Distance: {option['distance_pct']:+.1f}% {option['itm_otm']} | Volume: {option['volume']:.0f}")
            print()
    
    def display_market_summary(self, all_ratios: List[Dict]):
        """Display summary by market"""
        if not all_ratios:
            return
        
        market_summary = defaultdict(lambda: {"calls": [], "puts": [], "spot_price": 0})
        
        for option in all_ratios:
            market = option["base_coin"]
            market_summary[market]["spot_price"] = option["spot_price"]
            
            if option["option_type"] == "CALL":
                market_summary[market]["calls"].append(option)
            else:
                market_summary[market]["puts"].append(option)
        
        print(f"\n📊 MARKET SUMMARY:")
        print(f"{'Market':<8} {'Spot Price':<12} {'Best Call Ratio':<16} {'Best Put Ratio':<16} {'Total Options':<14}")
        print("-" * 80)
        
        for market in sorted(market_summary.keys()):
            data = market_summary[market]
            spot_price = data["spot_price"]
            
            best_call_ratio = max([c["ratio"] for c in data["calls"]], default=0)
            best_put_ratio = max([p["ratio"] for p in data["puts"]], default=0)
            total_options = len(data["calls"]) + len(data["puts"])
            
            print(f"{market:<8} ${spot_price:<11.2f} {best_call_ratio:<15.5f} {best_put_ratio:<15.5f} {total_options:<14}")

    def scan_single_market(self, base_coin: str) -> List[Dict]:
        """Scan a single market for best delta/price ratios"""
        print(f"🔍 Scanning {base_coin} market...")
        
        # Get spot price
        spot_symbol = f"{base_coin}USDT"
        spot_price = self.get_spot_price(spot_symbol)
        
        if spot_price == 0:
            print(f"❌ Could not get spot price for {base_coin}")
            return []
        
        print(f"📊 {base_coin} Spot Price: ${spot_price:,.2f}")
        
        # Calculate ratios for this market
        ratios = self.calculate_delta_price_ratios(base_coin, spot_price)
        
        print(f"✅ Found {len(ratios)} options for {base_coin}")
        
        return ratios

def main():
    """Main function to scan markets for best delta/price ratios"""
    scanner = BybitDeltaScanner()
    
    print("=== Bybit Delta Scanner ===")
    
    # Get available markets
    print("🔍 Fetching available markets...")
    available_coins = scanner.get_available_base_coins()
    
    if not available_coins:
        print("❌ No markets found")
        return
    
    print(f"\nAvailable markets: {', '.join(available_coins)}")
    
    # Let user choose
    print(f"\nSelect trading mode:")
    print("1. Scan ALL markets (find best ratios across everything)")
    print("2. Select specific market")
    
    try:
        mode_choice = input("Enter choice (1 or 2, default=2): ").strip()
    except EOFError:
        mode_choice = "2"
    
    if mode_choice == "1":
        # Scan all markets
        print("\n🔍 Scanning ALL available markets...")
        all_ratios = scanner.scan_all_markets()
        
        if not all_ratios:
            print("❌ No options data found across all markets")
            return
        
        print(f"\n✅ Scan complete! Found {len(all_ratios)} options across all markets")
        
        # Display results
        scanner.display_market_summary(all_ratios)
        scanner.display_best_ratios(all_ratios, top_n=15)
        
    else:
        # Select specific market
        print(f"\nAvailable tokens:")
        for i, coin in enumerate(available_coins, 1):
            print(f"{i:2d}. {coin}")
        
        try:
            choice = input(f"\nSelect token (1-{len(available_coins)}, default=1): ").strip()
            if choice:
                selected_coin = available_coins[int(choice) - 1]
            else:
                selected_coin = available_coins[0]
        except (ValueError, IndexError, EOFError):
            selected_coin = available_coins[0]
        
        print(f"\n🎯 Selected: {selected_coin}")
        
        # Scan selected market
        ratios = scanner.scan_single_market(selected_coin)
        
        if not ratios:
            print(f"❌ No options data found for {selected_coin}")
            return
        
        # Display results for single market
        scanner.display_best_ratios(ratios, top_n=20)
    
    print(f"\n💡 TIP: Higher ratio = more delta per dollar spent")
    print(f"📅 Check expiry dates - closer expiry may have higher time decay risk")

if __name__ == "__main__":
    main()