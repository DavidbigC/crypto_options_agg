#!/usr/bin/env python3
"""
Python script for ETH options theta (time decay) trading analysis on Bybit
Focuses on tracking time decay patterns and identifying theta trading opportunities
"""

import requests
import json
from typing import Dict, List, Optional, Tuple
from datetime import datetime, timedelta
import numpy as np
import plotly.graph_objects as go
import plotly.express as px
from plotly.subplots import make_subplots
from dataclasses import dataclass
import time

@dataclass
class ThetaContract:
    """Represents an ETH option contract with theta focus"""
    symbol: str
    strike: float
    option_type: str  # 'call' or 'put'
    bid: float
    ask: float
    last: float
    volume: float
    delta: float
    gamma: float
    vega: float
    theta: float
    iv: float
    days_to_expiry: int
    timestamp: datetime
    
    @property
    def mid_price(self) -> float:
        """Calculate mid price between bid and ask"""
        if self.bid > 0 and self.ask > 0:
            return (self.bid + self.ask) / 2
        return self.last if self.last > 0 else 0
    
    @property
    def theta_per_day(self) -> float:
        """Theta represents daily time decay"""
        return self.theta
    
    @property
    def theta_yield(self) -> float:
        """Theta yield as percentage of option price"""
        if self.mid_price > 0:
            return abs(self.theta) / self.mid_price * 100
        return 0
    
    @property
    def is_high_theta(self) -> bool:
        """Check if this is a high theta contract (good for selling)"""
        return self.theta_yield > 2.0 and self.days_to_expiry <= 30

class BybitThetaAPI:
    def __init__(self):
        self.base_url = "https://api.bybit.com/v5"
        self.base_coin = "ETH"
    
    def get_eth_options_tickers(self) -> List[Dict]:
        """Get ticker data for all ETH options"""
        url = f"{self.base_url}/market/tickers"
        params = {
            "category": "option",
            "baseCoin": self.base_coin
        }
        response = requests.get(url, params=params)
        response.raise_for_status()
        data = response.json()
        
        if data.get("retCode") != 0:
            raise Exception(f"API Error: {data.get('retMsg')}")
        
        return data.get("result", {}).get("list", [])
    
    def get_eth_spot_price(self) -> float:
        """Get current ETH spot price"""
        url = f"{self.base_url}/market/tickers"
        params = {
            "category": "spot",
            "symbol": "ETHUSDT"
        }
        response = requests.get(url, params=params)
        response.raise_for_status()
        data = response.json()
        
        if data.get("retCode") != 0:
            raise Exception(f"API Error: {data.get('retMsg')}")
        
        tickers = data.get("result", {}).get("list", [])
        if tickers:
            return float(tickers[0].get("lastPrice", 0))
        return 0.0
    
    def parse_option_symbol(self, symbol: str) -> Dict:
        """Parse Bybit option symbol to extract date, strike, and type"""
        # Format: ETH-27MAR26-4000-P-USDT
        parts = symbol.split('-')
        if len(parts) < 4:
            return {}
        
        try:
            base = parts[0]
            date_str = parts[1]  # e.g., "27MAR26"
            strike = float(parts[2])
            option_type = "CALL" if parts[3] == "C" else "PUT"
            
            # Parse date format DDMMMYY (e.g., 27MAR26)
            day = int(date_str[:2])
            month_str = date_str[2:5]
            year = int("20" + date_str[5:7])
            
            # Convert month abbreviation to number
            months = {
                'JAN': 1, 'FEB': 2, 'MAR': 3, 'APR': 4, 'MAY': 5, 'JUN': 6,
                'JUL': 7, 'AUG': 8, 'SEP': 9, 'OCT': 10, 'NOV': 11, 'DEC': 12
            }
            month = months.get(month_str, 1)
            
            expiry_date = datetime(year, month, day)
            days_to_expiry = (expiry_date - datetime.now()).days
            
            return {
                "expiry_date": expiry_date,
                "days_to_expiry": max(0, days_to_expiry),
                "strike_price": strike,
                "option_type": option_type,
                "symbol": symbol,
                "base_coin": base
            }
        except (ValueError, IndexError, KeyError):
            return {}

class ThetaAnalyzer:
    """Analyze theta trading opportunities"""
    
    def __init__(self, api: BybitThetaAPI):
        self.api = api
    
    def get_all_theta_contracts(self) -> List[ThetaContract]:
        """Get all ETH option contracts with theta data"""
        tickers = self.api.get_eth_options_tickers()
        contracts = []
        
        for ticker in tickers:
            symbol = ticker.get("symbol", "")
            parsed = self.api.parse_option_symbol(symbol)
            if not parsed:
                continue
            
            try:
                contract = ThetaContract(
                    symbol=symbol,
                    strike=parsed["strike_price"],
                    option_type=parsed["option_type"].lower(),
                    bid=float(ticker.get("bid1Price", 0)),
                    ask=float(ticker.get("ask1Price", 0)),
                    last=float(ticker.get("lastPrice", 0)),
                    volume=float(ticker.get("volume24h", 0)),
                    delta=float(ticker.get("delta", 0)),
                    gamma=float(ticker.get("gamma", 0)),
                    vega=float(ticker.get("vega", 0)),
                    theta=float(ticker.get("theta", 0)),
                    iv=float(ticker.get("markIv", 0)),
                    days_to_expiry=parsed["days_to_expiry"],
                    timestamp=datetime.now()
                )
                contracts.append(contract)
            except (ValueError, KeyError) as e:
                continue
        
        return contracts
    
    def find_high_theta_opportunities(self, contracts: List[ThetaContract], spot_price: float) -> List[ThetaContract]:
        """Find contracts with high theta for selling opportunities"""
        high_theta_contracts = []
        
        for contract in contracts:
            # Filter criteria for theta trading
            if (contract.theta < -0.01 and  # Meaningful negative theta
                contract.days_to_expiry <= 45 and  # Within 45 days
                contract.days_to_expiry >= 7 and   # Not too close to expiry
                contract.volume > 0 and            # Has trading volume
                contract.mid_price > 0.01):        # Reasonable price
                
                high_theta_contracts.append(contract)
        
        # Sort by theta yield (highest first)
        high_theta_contracts.sort(key=lambda x: x.theta_yield, reverse=True)
        return high_theta_contracts
    
    def analyze_theta_decay_pattern(self, contracts: List[ThetaContract]) -> Dict:
        """Analyze theta decay patterns by days to expiry"""
        theta_by_dte = {}
        
        for contract in contracts:
            dte = contract.days_to_expiry
            if dte not in theta_by_dte:
                theta_by_dte[dte] = []
            theta_by_dte[dte].append(abs(contract.theta))
        
        # Calculate average theta by DTE
        avg_theta_by_dte = {}
        for dte, theta_values in theta_by_dte.items():
            if theta_values:
                avg_theta_by_dte[dte] = np.mean(theta_values)
        
        return avg_theta_by_dte
    
    def find_theta_arbitrage_opportunities(self, contracts: List[ThetaContract], spot_price: float) -> List[Dict]:
        """Find potential theta arbitrage opportunities"""
        opportunities = []
        
        # Group by strike and expiry
        by_strike_expiry = {}
        for contract in contracts:
            key = (contract.strike, contract.days_to_expiry)
            if key not in by_strike_expiry:
                by_strike_expiry[key] = {'calls': [], 'puts': []}
            
            if contract.option_type == 'call':
                by_strike_expiry[key]['calls'].append(contract)
            else:
                by_strike_expiry[key]['puts'].append(contract)
        
        # Look for put-call parity violations and theta imbalances
        for (strike, dte), options in by_strike_expiry.items():
            if options['calls'] and options['puts']:
                call = options['calls'][0]
                put = options['puts'][0]
                
                # Check for significant theta imbalance
                theta_diff = abs(call.theta - put.theta)
                if theta_diff > 0.05:  # Significant theta difference
                    opportunities.append({
                        'strike': strike,
                        'days_to_expiry': dte,
                        'call_theta': call.theta,
                        'put_theta': put.theta,
                        'theta_diff': theta_diff,
                        'call_symbol': call.symbol,
                        'put_symbol': put.symbol,
                        'call_price': call.mid_price,
                        'put_price': put.mid_price
                    })
        
        # Sort by theta difference
        opportunities.sort(key=lambda x: x['theta_diff'], reverse=True)
        return opportunities

def display_theta_dashboard(analyzer: ThetaAnalyzer, spot_price: float):
    """Display comprehensive theta trading dashboard"""
    print(f"{'='*80}")
    print(f"ETH OPTIONS THETA TRADING DASHBOARD")
    print(f"{'='*80}")
    print(f"ETH Spot Price: ${spot_price:,.2f}")
    print(f"Analysis Time: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
    
    # Get all contracts
    contracts = analyzer.get_all_theta_contracts()
    if not contracts:
        print("No options data available")
        return
    
    print(f"Total ETH Options Analyzed: {len(contracts)}")
    
    # High theta opportunities
    high_theta = analyzer.find_high_theta_opportunities(contracts, spot_price)
    print(f"\n{'='*80}")
    print(f"TOP THETA SELLING OPPORTUNITIES (High Time Decay)")
    print(f"{'='*80}")
    
    if high_theta:
        print(f"{'Symbol':<20} {'Type':<6} {'Strike':<8} {'DTE':<5} {'Theta':<8} {'Yield%':<8} {'Price':<8} {'Volume':<8}")
        print("-" * 85)
        
        for contract in high_theta[:15]:  # Top 15
            print(f"{contract.symbol:<20} {contract.option_type.upper():<6} ${contract.strike:<7.0f} {contract.days_to_expiry:<5} {contract.theta:<8.4f} {contract.theta_yield:<8.2f} ${contract.mid_price:<7.4f} {contract.volume:<8.0f}")
    else:
        print("No high theta opportunities found")
    
    # Theta decay analysis
    theta_patterns = analyzer.analyze_theta_decay_pattern(contracts)
    print(f"\n{'='*80}")
    print(f"THETA DECAY PATTERNS BY DAYS TO EXPIRY")
    print(f"{'='*80}")
    
    if theta_patterns:
        sorted_dte = sorted(theta_patterns.keys())
        print(f"{'DTE':<5} {'Avg Theta':<12} {'Decay Rate':<12}")
        print("-" * 35)
        
        for dte in sorted_dte:
            if dte <= 60:  # Focus on near-term options
                avg_theta = theta_patterns[dte]
                print(f"{dte:<5} {avg_theta:<12.4f} {'High' if avg_theta > 0.05 else 'Medium' if avg_theta > 0.02 else 'Low':<12}")
    
    # Theta arbitrage opportunities
    arbitrage_ops = analyzer.find_theta_arbitrage_opportunities(contracts, spot_price)
    print(f"\n{'='*80}")
    print(f"THETA ARBITRAGE OPPORTUNITIES")
    print(f"{'='*80}")
    
    if arbitrage_ops:
        print(f"{'Strike':<8} {'DTE':<5} {'Call Theta':<12} {'Put Theta':<12} {'Diff':<8}")
        print("-" * 55)
        
        for opp in arbitrage_ops[:10]:  # Top 10
            print(f"${opp['strike']:<7.0f} {opp['days_to_expiry']:<5} {opp['call_theta']:<12.4f} {opp['put_theta']:<12.4f} {opp['theta_diff']:<8.4f}")
    else:
        print("No theta arbitrage opportunities found")
    
    # Interactive menu
    print(f"\n{'='*80}")
    print("THETA ANALYSIS OPTIONS")
    print("1. Show theta decay chart")
    print("2. Show high theta contracts by expiry")
    print("3. Show theta vs volatility analysis")
    print("4. Export theta data to CSV")
    print("5. Monitor theta changes (live)")
    print("0. Exit")
    
    try:
        choice = input("\nSelect option (0-5): ").strip()
        
        if choice == "1":
            plot_theta_decay_chart(contracts, spot_price)
        elif choice == "2":
            show_theta_by_expiry(contracts)
        elif choice == "3":
            show_theta_vs_iv_analysis(contracts)
        elif choice == "4":
            export_theta_data(contracts)
        elif choice == "5":
            monitor_theta_changes(analyzer, spot_price)
        
    except EOFError:
        pass

def plot_theta_decay_chart(contracts: List[ThetaContract], spot_price: float):
    """Plot theta decay patterns"""
    # Group by days to expiry
    theta_by_dte = {}
    for contract in contracts:
        dte = contract.days_to_expiry
        if dte <= 60 and dte > 0:  # Focus on next 60 days
            if dte not in theta_by_dte:
                theta_by_dte[dte] = []
            theta_by_dte[dte].append(abs(contract.theta))
    
    if not theta_by_dte:
        print("No data available for chart")
        return
    
    # Calculate average theta by DTE
    dtes = sorted(theta_by_dte.keys())
    avg_thetas = [np.mean(theta_by_dte[dte]) for dte in dtes]
    
    fig = go.Figure()
    
    # Add theta decay curve
    fig.add_trace(go.Scatter(
        x=dtes,
        y=avg_thetas,
        mode='lines+markers',
        name='Average Theta Decay',
        line=dict(color='red', width=3),
        marker=dict(size=8)
    ))
    
    # Add exponential decay reference line
    theoretical_theta = [0.1 * np.exp(-dte/30) for dte in dtes]
    fig.add_trace(go.Scatter(
        x=dtes,
        y=theoretical_theta,
        mode='lines',
        name='Theoretical Decay',
        line=dict(color='blue', dash='dash'),
        opacity=0.7
    ))
    
    fig.update_layout(
        title=f'ETH Options Theta Decay Pattern<br><sub>Current ETH: ${spot_price:,.2f}</sub>',
        xaxis_title='Days to Expiry',
        yaxis_title='Average |Theta|',
        width=1000,
        height=600,
        template='plotly_white'
    )
    
    fig.show()

def show_theta_by_expiry(contracts: List[ThetaContract]):
    """Show theta breakdown by expiry date"""
    from collections import defaultdict
    
    theta_by_expiry = defaultdict(list)
    
    for contract in contracts:
        if contract.days_to_expiry <= 90:  # Next 3 months
            theta_by_expiry[contract.days_to_expiry].append(contract)
    
    print(f"\n{'='*80}")
    print("THETA ANALYSIS BY EXPIRY")
    print(f"{'='*80}")
    
    for dte in sorted(theta_by_expiry.keys()):
        contracts_at_dte = theta_by_expiry[dte]
        avg_theta = np.mean([abs(c.theta) for c in contracts_at_dte])
        high_theta_count = sum(1 for c in contracts_at_dte if c.is_high_theta)
        
        print(f"\n{dte} Days to Expiry:")
        print(f"  Total Contracts: {len(contracts_at_dte)}")
        print(f"  Average |Theta|: {avg_theta:.4f}")
        print(f"  High Theta Contracts: {high_theta_count}")
        
        # Show top 3 highest theta contracts for this expiry
        top_theta = sorted(contracts_at_dte, key=lambda x: abs(x.theta), reverse=True)[:3]
        for i, contract in enumerate(top_theta, 1):
            print(f"    {i}. {contract.symbol}: Theta={contract.theta:.4f}, Yield={contract.theta_yield:.2f}%")

def show_theta_vs_iv_analysis(contracts: List[ThetaContract]):
    """Analyze theta vs implied volatility relationship"""
    valid_contracts = [c for c in contracts if c.iv > 0 and c.theta != 0]
    
    if not valid_contracts:
        print("No valid data for theta vs IV analysis")
        return
    
    ivs = [c.iv * 100 for c in valid_contracts]  # Convert to percentage
    thetas = [abs(c.theta) for c in valid_contracts]
    
    fig = go.Figure()
    
    fig.add_trace(go.Scatter(
        x=ivs,
        y=thetas,
        mode='markers',
        name='ETH Options',
        marker=dict(
            size=8,
            color=thetas,
            colorscale='Reds',
            colorbar=dict(title="Theta"),
            opacity=0.7
        ),
        text=[f"{c.symbol}<br>Strike: ${c.strike}<br>DTE: {c.days_to_expiry}" for c in valid_contracts],
        hovertemplate='<b>%{text}</b><br>IV: %{x:.1f}%<br>Theta: %{y:.4f}<extra></extra>'
    ))
    
    fig.update_layout(
        title='ETH Options: Theta vs Implied Volatility',
        xaxis_title='Implied Volatility (%)',
        yaxis_title='|Theta|',
        width=1000,
        height=600,
        template='plotly_white'
    )
    
    fig.show()

def export_theta_data(contracts: List[ThetaContract]):
    """Export theta data to CSV"""
    import csv
    
    filename = f"eth_theta_data_{datetime.now().strftime('%Y%m%d_%H%M%S')}.csv"
    
    with open(filename, 'w', newline='') as csvfile:
        fieldnames = [
            'symbol', 'option_type', 'strike', 'days_to_expiry',
            'bid', 'ask', 'mid_price', 'last', 'volume',
            'delta', 'gamma', 'vega', 'theta', 'iv',
            'theta_yield', 'is_high_theta', 'timestamp'
        ]
        
        writer = csv.DictWriter(csvfile, fieldnames=fieldnames)
        writer.writeheader()
        
        for contract in contracts:
            writer.writerow({
                'symbol': contract.symbol,
                'option_type': contract.option_type,
                'strike': contract.strike,
                'days_to_expiry': contract.days_to_expiry,
                'bid': contract.bid,
                'ask': contract.ask,
                'mid_price': contract.mid_price,
                'last': contract.last,
                'volume': contract.volume,
                'delta': contract.delta,
                'gamma': contract.gamma,
                'vega': contract.vega,
                'theta': contract.theta,
                'iv': contract.iv,
                'theta_yield': contract.theta_yield,
                'is_high_theta': contract.is_high_theta,
                'timestamp': contract.timestamp
            })
    
    print(f"Theta data exported to: {filename}")

def monitor_theta_changes(analyzer: ThetaAnalyzer, spot_price: float, interval_seconds: int = 300):
    """Monitor theta changes in real-time"""
    print(f"Starting theta monitoring (updates every {interval_seconds} seconds)...")
    print("Press Ctrl+C to stop")
    
    previous_contracts = {}
    
    try:
        while True:
            current_contracts = analyzer.get_all_theta_contracts()
            current_time = datetime.now()
            
            print(f"\n--- Theta Update at {current_time.strftime('%H:%M:%S')} ---")
            
            # Track changes
            changes_detected = 0
            for contract in current_contracts:
                if contract.symbol in previous_contracts:
                    prev_theta = previous_contracts[contract.symbol].theta
                    theta_change = contract.theta - prev_theta
                    
                    if abs(theta_change) > 0.001:  # Meaningful change
                        changes_detected += 1
                        if changes_detected <= 5:  # Show top 5 changes
                            print(f"{contract.symbol}: Theta {prev_theta:.4f} → {contract.theta:.4f} (Δ{theta_change:+.4f})")
            
            if changes_detected == 0:
                print("No significant theta changes detected")
            elif changes_detected > 5:
                print(f"... and {changes_detected - 5} other changes")
            
            # Update previous contracts
            previous_contracts = {c.symbol: c for c in current_contracts}
            
            # Wait for next update
            time.sleep(interval_seconds)
            
    except KeyboardInterrupt:
        print("\nTheta monitoring stopped")

def main():
    """Main function for ETH theta trading analysis"""
    api = BybitThetaAPI()
    analyzer = ThetaAnalyzer(api)
    
    try:
        print("Fetching ETH options data...")
        spot_price = api.get_eth_spot_price()
        
        if spot_price == 0:
            print("Error: Could not fetch ETH spot price")
            return
        
        display_theta_dashboard(analyzer, spot_price)
        
    except Exception as e:
        print(f"Error: {e}")

if __name__ == "__main__":
    main()