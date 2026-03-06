#!/usr/bin/env python3
"""
Python script to fetch and display BTC/ETH options market data from Bybit grouped by expiration date
"""

import requests
import json
from typing import Dict, List, Optional, Tuple
from datetime import datetime
from collections import defaultdict
import numpy as np
import plotly.graph_objects as go
import plotly.express as px
from plotly.subplots import make_subplots
from dataclasses import dataclass

@dataclass
class OptionContract:
    """Represents an individual option contract"""
    symbol: str
    strike: float
    option_type: str  # 'call' or 'put'
    bid: float
    ask: float
    last: float
    volume: float
    delta: float
    
    @property
    def mid_price(self) -> float:
        """Calculate mid price between bid and ask"""
        if self.bid > 0 and self.ask > 0:
            return (self.bid + self.ask) / 2
        return self.last if self.last > 0 else 0
    
    @property
    def notional_value(self) -> float:
        """Calculate notional value for fee calculation"""
        return self.strike

@dataclass
class StrategyLeg:
    """Represents one leg of an options strategy"""
    contract: OptionContract
    quantity: int  # positive for long, negative for short
    
    def calculate_pnl(self, spot_price: float) -> float:
        """Calculate P&L for this leg at given spot price"""
        if self.contract.option_type.lower() == 'call':
            intrinsic = max(0, spot_price - self.contract.strike)
        else:  # put
            intrinsic = max(0, self.contract.strike - spot_price)
        
        # Use bid/ask prices as taker
        if self.quantity > 0:  # long position - we buy at ask price
            entry_price = self.contract.ask
            return self.quantity * (intrinsic - entry_price)
        else:  # short position - we sell at bid price
            entry_price = self.contract.bid
            return self.quantity * (intrinsic - entry_price)
    
    def calculate_fees(self) -> float:
        """Calculate taker trading fees (0.003% of notional)"""
        fee_rate = 0.0003  # 0.003% as decimal
        return abs(self.quantity) * self.contract.notional_value * fee_rate

def calculate_bybit_options_fee(premium: float, current_price: float) -> float:
    """
    Calculate Bybit options trading fees
    
    Args:
        premium: The bid/ask price of the option
        current_price: Current price of the underlying asset
    
    Returns:
        The trading fee amount
    
    Fee structure:
    - Maximum 7% of premium if option is low value
    - Otherwise 0.03% of current price
    """
    # Calculate both fee types
    premium_fee = premium * 0.07  # 7% of premium
    current_price_fee = current_price * 0.0003  # 0.03% of current price
    
    # Return the minimum of the two (Bybit charges whichever is lower)
    return min(premium_fee, current_price_fee)

class OptionsStrategy:
    """Base class for options strategies"""
    
    def __init__(self, name: str, legs: List[StrategyLeg]):
        self.name = name
        self.legs = legs
        self.total_fees = sum(leg.calculate_fees() for leg in legs)
    
    def calculate_pnl(self, spot_price: float) -> float:
        """Calculate total P&L at given spot price"""
        pnl = sum(leg.calculate_pnl(spot_price) for leg in self.legs)
        return pnl - self.total_fees
    
    def get_pnl_range(self, price_range: Tuple[float, float], num_points: int = 100) -> Tuple[np.ndarray, np.ndarray]:
        """Calculate P&L across a price range"""
        prices = np.linspace(price_range[0], price_range[1], num_points)
        pnls = np.array([self.calculate_pnl(price) for price in prices])
        return prices, pnls
    
    def get_breakeven_points(self, price_range: Tuple[float, float]) -> List[float]:
        """Find breakeven points where P&L = 0"""
        prices, pnls = self.get_pnl_range(price_range, 1000)
        breakevens = []
        
        for i in range(len(pnls) - 1):
            if (pnls[i] <= 0 <= pnls[i + 1]) or (pnls[i] >= 0 >= pnls[i + 1]):
                # Linear interpolation to find more precise breakeven
                if pnls[i + 1] != pnls[i]:
                    x = prices[i] + (prices[i + 1] - prices[i]) * (-pnls[i]) / (pnls[i + 1] - pnls[i])
                    breakevens.append(x)
        
        return breakevens
    
    def get_max_profit_loss(self, price_range: Tuple[float, float]) -> Tuple[float, float]:
        """Get maximum profit and loss in the price range"""
        _, pnls = self.get_pnl_range(price_range, 1000)
        return float(np.max(pnls)), float(np.min(pnls))
    
    def net_premium(self) -> float:
        """Calculate net premium paid (positive) or received (negative)"""
        return sum(leg.quantity * leg.contract.mid_price for leg in self.legs)

class StrategyBuilder:
    """Helper class to build common options strategies"""
    
    @staticmethod
    def iron_condor(call_contracts: Dict[float, OptionContract], 
                   put_contracts: Dict[float, OptionContract],
                   lower_put_strike: float, upper_put_strike: float,
                   lower_call_strike: float, upper_call_strike: float) -> OptionsStrategy:
        """Build Iron Condor strategy"""
        legs = [
            StrategyLeg(put_contracts[lower_put_strike], 1),    # Buy lower put
            StrategyLeg(put_contracts[upper_put_strike], -1),   # Sell upper put
            StrategyLeg(call_contracts[lower_call_strike], -1), # Sell lower call
            StrategyLeg(call_contracts[upper_call_strike], 1)   # Buy upper call
        ]
        return OptionsStrategy("Iron Condor", legs)
    
    @staticmethod
    def butterfly(contracts: Dict[float, OptionContract], option_type: str,
                 lower_strike: float, middle_strike: float, upper_strike: float) -> OptionsStrategy:
        """Build Butterfly strategy"""
        target_contracts = contracts
        legs = [
            StrategyLeg(target_contracts[lower_strike], 1),   # Buy lower
            StrategyLeg(target_contracts[middle_strike], -2), # Sell 2x middle
            StrategyLeg(target_contracts[upper_strike], 1)    # Buy upper
        ]
        return OptionsStrategy(f"{option_type.title()} Butterfly", legs)
    
    @staticmethod
    def wide_butterfly(contracts: Dict[float, OptionContract], option_type: str,
                      lower_strike: float, middle_strike: float, upper_strike: float) -> OptionsStrategy:
        """Build Wide Butterfly strategy with strikes spread further apart"""
        target_contracts = contracts
        legs = [
            StrategyLeg(target_contracts[lower_strike], 1),   # Buy lower
            StrategyLeg(target_contracts[middle_strike], -2), # Sell 2x middle
            StrategyLeg(target_contracts[upper_strike], 1)    # Buy upper
        ]
        return OptionsStrategy(f"Wide {option_type.title()} Butterfly", legs)
    
    @staticmethod
    def iron_butterfly(call_contracts: Dict[float, OptionContract], put_contracts: Dict[float, OptionContract],
                      lower_put_strike: float, middle_strike: float, upper_call_strike: float) -> OptionsStrategy:
        """Build Iron Butterfly strategy"""
        legs = [
            StrategyLeg(put_contracts[lower_put_strike], 1),   # Buy lower put
            StrategyLeg(put_contracts[middle_strike], -1),     # Sell ATM put
            StrategyLeg(call_contracts[middle_strike], -1),    # Sell ATM call  
            StrategyLeg(call_contracts[upper_call_strike], 1)  # Buy upper call
        ]
        return OptionsStrategy("Iron Butterfly", legs)
    
    @staticmethod
    def jade_lizard(call_contracts: Dict[float, OptionContract], put_contracts: Dict[float, OptionContract],
                   put_strike: float, call_strike_1: float, call_strike_2: float) -> OptionsStrategy:
        """Build Jade Lizard strategy (Short Put + Short Call Spread)"""
        legs = [
            StrategyLeg(put_contracts[put_strike], -1),         # Sell put
            StrategyLeg(call_contracts[call_strike_1], -1),     # Sell lower call
            StrategyLeg(call_contracts[call_strike_2], 1)       # Buy upper call
        ]
        return OptionsStrategy("Jade Lizard", legs)
    
    @staticmethod
    def reverse_iron_condor(call_contracts: Dict[float, OptionContract], put_contracts: Dict[float, OptionContract],
                           lower_put_strike: float, upper_put_strike: float, 
                           lower_call_strike: float, upper_call_strike: float) -> OptionsStrategy:
        """Build Reverse Iron Condor strategy"""
        legs = [
            StrategyLeg(put_contracts[lower_put_strike], -1),   # Sell lower put
            StrategyLeg(put_contracts[upper_put_strike], 1),    # Buy upper put
            StrategyLeg(call_contracts[lower_call_strike], 1),  # Buy lower call
            StrategyLeg(call_contracts[upper_call_strike], -1)  # Sell upper call
        ]
        return OptionsStrategy("Reverse Iron Condor", legs)

    @staticmethod
    def straddle(call_contracts: Dict[float, OptionContract],
                put_contracts: Dict[float, OptionContract],
                strike: float, long: bool = True) -> OptionsStrategy:
        """Build Straddle strategy"""
        mult = 1 if long else -1
        legs = [
            StrategyLeg(call_contracts[strike], mult),  # Long/Short call
            StrategyLeg(put_contracts[strike], mult)    # Long/Short put
        ]
        name = "Long Straddle" if long else "Short Straddle"
        return OptionsStrategy(name, legs)
    
    @staticmethod
    def strangle(call_contracts: Dict[float, OptionContract],
                put_contracts: Dict[float, OptionContract],
                put_strike: float, call_strike: float, long: bool = True) -> OptionsStrategy:
        """Build Strangle strategy"""
        mult = 1 if long else -1
        legs = [
            StrategyLeg(call_contracts[call_strike], mult),  # Long/Short call
            StrategyLeg(put_contracts[put_strike], mult)     # Long/Short put
        ]
        name = "Long Strangle" if long else "Short Strangle"
        return OptionsStrategy(name, legs)

class BybitOptionsAPI:
    def __init__(self):
        self.base_url = "https://api.bybit.com/v5"
    
    def get_instruments_info(self, base_coin: str = "BTC") -> List[Dict]:
        """Get available options instruments for the specified base coin"""
        url = f"{self.base_url}/market/instruments-info"
        params = {
            "category": "option",
            "baseCoin": base_coin
        }
        response = requests.get(url, params=params)
        response.raise_for_status()
        data = response.json()
        
        if data.get("retCode") != 0:
            raise Exception(f"API Error: {data.get('retMsg')}")
        
        return data.get("result", {}).get("list", [])
    
    def get_options_tickers(self, base_coin: str = "BTC") -> List[Dict]:
        """Get ticker data for all options of the specified base coin"""
        url = f"{self.base_url}/market/tickers"
        params = {
            "category": "option",
            "baseCoin": base_coin
        }
        response = requests.get(url, params=params)
        response.raise_for_status()
        data = response.json()
        
        if data.get("retCode") != 0:
            raise Exception(f"API Error: {data.get('retMsg')}")
        
        return data.get("result", {}).get("list", [])
    
    def get_spot_price(self, symbol: str = "BTCUSDT") -> float:
        """Get current spot price for the underlying asset"""
        url = f"{self.base_url}/market/tickers"
        params = {
            "category": "spot",
            "symbol": symbol
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
        # Format: BTC-27MAR26-70000-P or BTC-5SEP25-109000-C-USDT
        parts = symbol.split('-')
        if len(parts) < 4:
            return {}
        
        try:
            base = parts[0]
            date_str = parts[1]  # e.g., "27MAR26" or "5SEP25"
            strike = float(parts[2])
            option_type = "CALL" if parts[3] == "C" else "PUT"
            
            # Parse date format DDMMMYY or DMMMYY (e.g., 27MAR26 or 5SEP25)
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
            
            # Convert month abbreviation to number
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

def display_options_by_date(api: BybitOptionsAPI, base_coin: str = "BTC"):
    """Display options grouped by expiration date with bid/ask data"""
    try:
        # Get spot price
        spot_symbol = f"{base_coin}USDT"
        spot_price = api.get_spot_price(spot_symbol)
        print(f"{base_coin} Spot Price: ${spot_price:,.2f}\n")
        
        # Get all ticker data for options
        tickers = api.get_options_tickers(base_coin)
        
        if not tickers:
            print(f"No {base_coin} options data available")
            return
        
        # Group options by expiration date
        options_by_date = defaultdict(lambda: {"calls": [], "puts": []})
        
        for ticker in tickers:
            symbol = ticker.get("symbol", "")
            parsed = api.parse_option_symbol(symbol)
            if not parsed:
                continue
            
            option_data = {
                "symbol": symbol,
                "strike": parsed["strike_price"],
                "bid": float(ticker.get("bid1Price", 0)),
                "ask": float(ticker.get("ask1Price", 0)),
                "last": float(ticker.get("lastPrice", 0)),
                "volume": float(ticker.get("volume24h", 0)),
                "bid_qty": float(ticker.get("bid1Size", 0)),
                "ask_qty": float(ticker.get("ask1Size", 0)),
                "delta": float(ticker.get("delta", 0)),
                "gamma": float(ticker.get("gamma", 0)),
                "vega": float(ticker.get("vega", 0))
            }
            
            expiry = parsed["expiry_date"]
            option_type = parsed["option_type"].lower()
            
            if option_type == "call":
                options_by_date[expiry]["calls"].append(option_data)
            else:
                options_by_date[expiry]["puts"].append(option_data)
        
        
        # Sort dates
        sorted_dates = sorted(options_by_date.keys())
        
        if not sorted_dates:
            print(f"No {base_coin} options expiration dates found")
            return
        
        print("Available expiration dates:")
        for i, date in enumerate(sorted_dates, 1):
            call_count = len(options_by_date[date]["calls"])
            put_count = len(options_by_date[date]["puts"])
            print(f"{i:2d}. {date} ({call_count} calls, {put_count} puts)")
        
        # Let user select a date
        print(f"\nEnter the number for the date you want to view (or press Enter for first date):")
        try:
            choice = input().strip()
        except EOFError:
            choice = ""
        
        try:
            if choice:
                selected_date = sorted_dates[int(choice) - 1]
            else:
                selected_date = sorted_dates[0]
        except (ValueError, IndexError):
            selected_date = sorted_dates[0]
        
        # Display the options chain first
        display_options_for_date(selected_date, options_by_date[selected_date], spot_price, base_coin)
        
        # Get user's expected price range BEFORE strategy analysis
        print(f"\n{'='*80}")
        print("MARKET OUTLOOK & STRATEGY SELECTION")
        print(f"{'='*80}")
        user_price_range = get_user_price_range(spot_price, base_coin)
        
        # Then offer strategy analysis with the expected range
        analyze_strategies(selected_date, options_by_date[selected_date], spot_price, base_coin, user_price_range)
        
    except Exception as e:
        print(f"Error: {e}")

def create_option_contracts(options_data: Dict) -> Tuple[Dict[float, OptionContract], Dict[float, OptionContract]]:
    """Convert options data to OptionContract objects"""
    call_contracts = {}
    put_contracts = {}
    
    for call in options_data["calls"]:
        contract = OptionContract(
            symbol=call["symbol"],
            strike=call["strike"],
            option_type="call",
            bid=call["bid"],
            ask=call["ask"],
            last=call["last"],
            volume=call["volume"],
            delta=call["delta"]
        )
        call_contracts[call["strike"]] = contract
    
    for put in options_data["puts"]:
        contract = OptionContract(
            symbol=put["symbol"],
            strike=put["strike"],
            option_type="put",
            bid=put["bid"],
            ask=put["ask"],
            last=put["last"],
            volume=put["volume"],
            delta=put["delta"]
        )
        put_contracts[put["strike"]] = contract
    
    return call_contracts, put_contracts

def plot_strategy_pnl(strategy: OptionsStrategy, spot_price: float, base_coin: str, user_price_range: tuple = None):
    """Plot P&L diagram for the strategy using Plotly"""
    # Always show ±10% from current spot price for full view
    chart_range = (spot_price * 0.9, spot_price * 1.1)
    
    # If user has a specific range, make sure chart covers it too
    if user_price_range:
        min_chart = min(chart_range[0], user_price_range[0] * 0.95)
        max_chart = max(chart_range[1], user_price_range[1] * 1.05)
        chart_range = (min_chart, max_chart)
    
    prices, pnls = strategy.get_pnl_range(chart_range)
    breakevens = strategy.get_breakeven_points(chart_range)
    max_profit, max_loss = strategy.get_max_profit_loss(chart_range)
    current_pnl = strategy.calculate_pnl(spot_price)
    
    fig = go.Figure()
    
    # Add profit areas (green fill)
    profit_mask = pnls > 0
    if np.any(profit_mask):
        fig.add_trace(go.Scatter(
            x=prices, y=pnls,
            fill='tonexty',
            fillcolor='rgba(0, 255, 0, 0.2)',
            line=dict(color='rgba(0, 255, 0, 0)'),
            showlegend=False,
            hoverinfo='skip'
        ))
    
    # Add loss areas (red fill)
    loss_mask = pnls < 0
    if np.any(loss_mask):
        fig.add_trace(go.Scatter(
            x=prices, y=np.where(pnls < 0, pnls, 0),
            fill='tozeroy',
            fillcolor='rgba(255, 0, 0, 0.2)',
            line=dict(color='rgba(255, 0, 0, 0)'),
            showlegend=False,
            hoverinfo='skip'
        ))
    
    # Main P&L line
    fig.add_trace(go.Scatter(
        x=prices, y=pnls,
        mode='lines',
        name=f'{strategy.name} P&L',
        line=dict(color='blue', width=3),
        hovertemplate=f'<b>{base_coin} Price:</b> $%{{x:,.0f}}<br>' +
                     '<b>P&L:</b> $%{y:,.2f}<extra></extra>'
    ))
    
    # Zero line
    fig.add_hline(y=0, line_dash="dash", line_color="black", opacity=0.5,
                  annotation_text="Breakeven Line")
    
    # Current spot price line
    fig.add_vline(x=spot_price, line_dash="dot", line_color="green", opacity=0.7,
                  annotation_text=f"Current Spot: ${spot_price:,.0f}")
    
    # Current P&L point
    fig.add_trace(go.Scatter(
        x=[spot_price], y=[current_pnl],
        mode='markers',
        name='Current P&L',
        marker=dict(color='green', size=12, symbol='circle'),
        hovertemplate=f'<b>Current Spot:</b> ${spot_price:,.0f}<br>' +
                     f'<b>Current P&L:</b> ${current_pnl:,.2f}<extra></extra>'
    ))
    
    # Breakeven points
    if breakevens:
        fig.add_trace(go.Scatter(
            x=breakevens, y=[0] * len(breakevens),
            mode='markers',
            name='Breakeven Points',
            marker=dict(color='red', size=10, symbol='diamond'),
            hovertemplate='<b>Breakeven:</b> $%{x:,.0f}<extra></extra>'
        ))
        
        for be in breakevens:
            fig.add_vline(x=be, line_dash="dash", line_color="red", opacity=0.3)
    
    # Update layout
    fig.update_layout(
        title=f'{strategy.name} - P&L at Expiration<br>' +
              f'<sub>Chart Range: ±10% from Spot | Net Premium: ${strategy.net_premium():.2f} | Fees: ${strategy.total_fees:.2f}</sub>',
        xaxis_title=f'{base_coin} Price ($)',
        yaxis_title='Profit/Loss ($)',
        width=1000,
        height=600,
        hovermode='x unified',
        legend=dict(yanchor="top", y=0.99, xanchor="left", x=0.01),
        template='plotly_white'
    )
    
    # Add user's expected price range if provided (highlighted zone)
    if user_price_range:
        fig.add_vrect(
            x0=user_price_range[0], x1=user_price_range[1],
            fillcolor="gold", opacity=0.3,
            line_width=2,
            line_color="orange",
            annotation_text=f"Your Expected Range<br>${user_price_range[0]:,.0f} - ${user_price_range[1]:,.0f}",
            annotation_position="top left"
        )
        
        # Add range boundary lines
        fig.add_vline(x=user_price_range[0], line_dash="dash", line_color="orange", opacity=0.8,
                      annotation_text=f"Expected Low: ${user_price_range[0]:,.0f}")
        fig.add_vline(x=user_price_range[1], line_dash="dash", line_color="orange", opacity=0.8,
                      annotation_text=f"Expected High: ${user_price_range[1]:,.0f}")
    
    # Add breakeven text annotation
    if breakevens:
        be_text = ', '.join([f'${be:.0f}' for be in breakevens])
        fig.add_annotation(
            x=0.02, y=0.98,
            xref='paper', yref='paper',
            text=f'Breakevens: {be_text}',
            showarrow=False,
            bgcolor='wheat',
            bordercolor='black',
            borderwidth=1
        )
    
    fig.show()

def analyze_strategies(date: str, options_data: Dict, spot_price: float, base_coin: str, user_price_range: tuple = None):
    """Analyze and display available strategies with user's expected price range"""
    call_contracts, put_contracts = create_option_contracts(options_data)
    
    if not call_contracts or not put_contracts:
        print("Insufficient options data for strategy analysis")
        return
    
    # Show market outlook summary
    if user_price_range:
        min_price, max_price = user_price_range
        mid_price = (min_price + max_price) / 2
        move_percent = abs(mid_price - spot_price) / spot_price * 100
        direction = "bullish" if mid_price > spot_price else "bearish" if mid_price < spot_price else "neutral"
        
        print(f"\n📊 Market Outlook Summary:")
        print(f"   Expected Range: ${min_price:,.0f} - ${max_price:,.0f}")
        print(f"   Midpoint: ${mid_price:,.0f} ({direction.upper()})")
        print(f"   Expected Move: {move_percent:.1f}% from current spot")
        
        # Suggest optimal strategies based on outlook
        print(f"\n💡 Recommended Strategies for {direction.title()} Outlook:")
        suggest_strategies_for_outlook(direction, move_percent, user_price_range, spot_price)
    
    print(f"\n{'='*80}")
    print(f"STRATEGY ANALYSIS")
    print(f"{'='*80}")
    
    print("\nAvailable Strategies:")
    print("1. Iron Condor")
    print("2. Call Butterfly")
    print("3. Put Butterfly") 
    print("4. Wide Call Butterfly")
    print("5. Wide Put Butterfly")
    print("6. Iron Butterfly")
    print("7. Long Straddle")
    print("8. Short Straddle")
    print("9. Long Strangle")
    print("10. Short Strangle")
    print("11. Jade Lizard")
    print("12. Reverse Iron Condor")
    print("13. Compare Multiple Strategies")
    print("14. Auto-Select Best Strategy for Your Outlook")
    print("0. Return to main menu")
    
    try:
        choice = input("\nSelect strategy (0-14): ").strip()
    except EOFError:
        return
    
    if choice == "0":
        return
    
    try:
        if choice == "14":
            auto_select_best_strategy(call_contracts, put_contracts, spot_price, base_coin, user_price_range)
        else:
            analyze_specific_strategy(choice, call_contracts, put_contracts, spot_price, base_coin, user_price_range)
    except Exception as e:
        print(f"Error analyzing strategy: {e}")

def suggest_strategies_for_outlook(direction: str, move_percent: float, price_range: tuple, spot_price: float):
    """Suggest optimal strategies based on market outlook"""
    
    if direction == "neutral" or move_percent < 5:
        print("   • Iron Condor (profit from low volatility)")
        print("   • Short Straddle/Strangle (collect premium from time decay)")
        print("   • Butterfly spreads (profit from price staying near strikes)")
        
    elif direction == "bullish":
        if move_percent < 10:
            print("   • Call spreads or covered calls (moderate upside)")
            print("   • Short put spreads (collect premium on support)")
        else:
            print("   • Long calls or call spreads (significant upside)")
            print("   • Long straddle if uncertain about timing")
            
    elif direction == "bearish":
        if move_percent < 10:
            print("   • Put spreads (moderate downside)")
            print("   • Short call spreads (collect premium on resistance)")
        else:
            print("   • Long puts or put spreads (significant downside)")
            print("   • Long straddle if uncertain about timing")
    
    if move_percent > 15:
        print("   • Long Straddle/Strangle (high volatility expected)")

def auto_select_best_strategy(call_contracts: Dict[float, OptionContract], put_contracts: Dict[float, OptionContract], 
                             spot_price: float, base_coin: str, user_price_range: tuple = None):
    """Automatically select and analyze the best strategy for user's outlook"""
    
    if not user_price_range:
        print("❌ Auto-selection requires expected price range. Please set your market outlook first.")
        return
    
    print(f"\n🔍 Auto-Selecting Best Strategy...")
    print(f"Analyzing all strategies for your expected range...")
    
    # Build all available strategies
    strategies = build_all_strategies(call_contracts, put_contracts, spot_price)
    
    if not strategies:
        print("❌ Could not build strategies with available options")
        return
    
    # Score strategies based on user's expected range
    best_strategy = score_strategies_for_range(strategies, user_price_range, spot_price)
    
    if best_strategy:
        print(f"\n🏆 RECOMMENDED STRATEGY: {best_strategy.name}")
        display_strategy_analysis(best_strategy, spot_price, base_coin, user_price_range)
    else:
        print("❌ Could not determine optimal strategy")

def build_all_strategies(call_contracts: Dict[float, OptionContract], put_contracts: Dict[float, OptionContract], 
                        spot_price: float) -> List[OptionsStrategy]:
    """Build all possible strategies for comparison"""
    strategies = []
    strikes = sorted(call_contracts.keys())
    atm_strike = min(strikes, key=lambda x: abs(x - spot_price))
    
    try:
        # Iron Condor
        put_strikes = [s for s in strikes if s <= atm_strike][-2:]
        call_strikes = [s for s in strikes if s >= atm_strike][:2]
        if len(put_strikes) >= 2 and len(call_strikes) >= 2:
            ic = StrategyBuilder.iron_condor(call_contracts, put_contracts, put_strikes[0], put_strikes[1], call_strikes[0], call_strikes[1])
            strategies.append(ic)
        
        # Straddles
        if atm_strike in call_contracts and atm_strike in put_contracts:
            long_straddle = StrategyBuilder.straddle(call_contracts, put_contracts, atm_strike, True)
            short_straddle = StrategyBuilder.straddle(call_contracts, put_contracts, atm_strike, False)
            strategies.extend([long_straddle, short_straddle])
        
        # Butterflies
        idx = strikes.index(atm_strike)
        if idx > 0 and idx < len(strikes) - 1:
            call_butterfly = StrategyBuilder.butterfly(call_contracts, "call", strikes[idx-1], strikes[idx], strikes[idx+1])
            put_butterfly = StrategyBuilder.butterfly(put_contracts, "put", strikes[idx-1], strikes[idx], strikes[idx+1])
            strategies.extend([call_butterfly, put_butterfly])
        
        # Wide Butterflies
        if idx >= 2 and idx < len(strikes) - 2:
            wide_call_butterfly = StrategyBuilder.wide_butterfly(call_contracts, "call", strikes[idx-2], strikes[idx], strikes[idx+2])
            wide_put_butterfly = StrategyBuilder.wide_butterfly(put_contracts, "put", strikes[idx-2], strikes[idx], strikes[idx+2])
            strategies.extend([wide_call_butterfly, wide_put_butterfly])
        
        # Iron Butterfly
        if idx >= 3 and idx < len(strikes) - 3:
            iron_butterfly = StrategyBuilder.iron_butterfly(call_contracts, put_contracts, strikes[idx-3], strikes[idx], strikes[idx+3])
            strategies.append(iron_butterfly)
        
        # Strangles
        otm_put = min([s for s in strikes if s < spot_price], key=lambda x: abs(x - spot_price*0.95), default=None)
        otm_call = min([s for s in strikes if s > spot_price], key=lambda x: abs(x - spot_price*1.05), default=None)
        if otm_put and otm_call:
            long_strangle = StrategyBuilder.strangle(call_contracts, put_contracts, otm_put, otm_call, True)
            short_strangle = StrategyBuilder.strangle(call_contracts, put_contracts, otm_put, otm_call, False)
            strategies.extend([long_strangle, short_strangle])
        
        # Jade Lizard (if we have enough strikes)
        far_otm_put = min([s for s in strikes if s < spot_price * 0.90], key=lambda x: abs(x - spot_price*0.85), default=None)
        otm_call_1 = min([s for s in strikes if s > spot_price * 1.05], key=lambda x: abs(x - spot_price*1.10), default=None)
        otm_call_2 = min([s for s in strikes if s > spot_price * 1.15], key=lambda x: abs(x - spot_price*1.20), default=None)
        
        if far_otm_put and otm_call_1 and otm_call_2:
            jade_lizard = StrategyBuilder.jade_lizard(call_contracts, put_contracts, far_otm_put, otm_call_1, otm_call_2)
            strategies.append(jade_lizard)
        
        # Reverse Iron Condor
        if idx >= 2 and idx < len(strikes) - 2:
            reverse_ic = StrategyBuilder.reverse_iron_condor(call_contracts, put_contracts, 
                                                           strikes[idx-2], strikes[idx-1], strikes[idx+1], strikes[idx+2])
            strategies.append(reverse_ic)
        
    except Exception as e:
        print(f"Error building strategies: {e}")
    
    return strategies

def score_strategies_for_range(strategies: List[OptionsStrategy], price_range: tuple, spot_price: float) -> OptionsStrategy:
    """Score and rank strategies based on expected price range"""
    min_price, max_price = price_range
    mid_price = (min_price + max_price) / 2
    strategy_scores = []
    
    print(f"\n🔍 Evaluating {len(strategies)} strategies for your range (${min_price:,.0f} - ${max_price:,.0f})...")
    
    for strategy in strategies:
        # Simple evaluation: P&L at user's key price levels
        min_pnl = strategy.calculate_pnl(min_price)
        mid_pnl = strategy.calculate_pnl(mid_price)
        max_pnl = strategy.calculate_pnl(max_price)
        
        # Check if profitable throughout user's range
        is_range_profitable = check_profitability_in_range(strategy, price_range)
        
        # Simple scoring: average of the three key points + big bonus for full profitability
        avg_pnl = (min_pnl + mid_pnl + max_pnl) / 3
        range_bonus = 1000 if is_range_profitable else 0
        score = avg_pnl + range_bonus
        
        strategy_scores.append((strategy, score, avg_pnl, min_pnl, mid_pnl, max_pnl, is_range_profitable))
    
    # Sort by score descending
    strategy_scores.sort(key=lambda x: x[1], reverse=True)
    
    # Display top 3 candidates
    print("\n🏆 TOP STRATEGIES FOR YOUR EXPECTED RANGE:")
    print(f"{'Rank':<4} {'Strategy':<18} {'Profitable':<12} {'Avg P&L':<12}")
    print("=" * 50)
    
    for i, (strategy, score, avg_pnl, min_pnl, mid_pnl, max_pnl, is_profitable) in enumerate(strategy_scores[:3], 1):
        profitable_icon = "✅ YES" if is_profitable else "❌ NO"
        print(f"{i:<4} {strategy.name:<18} {profitable_icon:<12} ${avg_pnl:<11.0f}")
    
    best_strategy = strategy_scores[0][0] if strategy_scores else None
    if best_strategy:
        is_best_profitable = strategy_scores[0][6]
        print(f"\n🎯 RECOMMENDED: {best_strategy.name}")
        if is_best_profitable:
            print("   ✅ This strategy is profitable throughout your expected range!")
        else:
            print("   ⚠️  This strategy has mixed results in your expected range.")
    
    return best_strategy

def optimize_strikes_for_range(strikes: List[float], user_range: tuple, strategy_type: str) -> tuple:
    """Find optimal strike prices to make strategy profitable in user's expected range"""
    min_price, max_price = user_range
    mid_price = (min_price + max_price) / 2
    
    if strategy_type == "iron_condor":
        # For Iron Condor, we want the profitable zone to cover the user's range
        # Profitable zone is between the middle strikes (short strikes)
        # So we want: short_put_strike <= min_price and short_call_strike >= max_price
        
        # Find strikes that bracket the user's range
        short_put_strike = max([s for s in strikes if s <= min_price], default=min_price)
        short_call_strike = min([s for s in strikes if s >= max_price], default=max_price)
        
        # Long strikes should be further out for protection
        long_put_strike = max([s for s in strikes if s < short_put_strike], default=short_put_strike - 25)
        long_call_strike = min([s for s in strikes if s > short_call_strike], default=short_call_strike + 25)
        
        return (long_put_strike, short_put_strike, short_call_strike, long_call_strike)
    
    elif strategy_type == "butterfly":
        # For butterfly, max profit is at the middle strike
        # So middle strike should be near the middle of user's range
        middle_strike = min(strikes, key=lambda x: abs(x - mid_price))
        idx = strikes.index(middle_strike)
        
        if idx > 0 and idx < len(strikes) - 1:
            return (strikes[idx-1], middle_strike, strikes[idx+1])
        return None
    
    elif strategy_type == "wide_butterfly":
        # For wide butterfly, spread strikes further apart to capture broader range
        middle_strike = min(strikes, key=lambda x: abs(x - mid_price))
        idx = strikes.index(middle_strike)
        
        # Try to use strikes that are 2-3 positions apart instead of adjacent
        lower_idx = max(0, idx - 2)
        upper_idx = min(len(strikes) - 1, idx + 2)
        
        # Ensure we have valid strikes
        if lower_idx < idx < upper_idx:
            return (strikes[lower_idx], middle_strike, strikes[upper_idx])
        return None
    
    elif strategy_type == "iron_butterfly":
        # Iron butterfly: profitable at the middle strike, use strikes around range
        middle_strike = min(strikes, key=lambda x: abs(x - mid_price))
        idx = strikes.index(middle_strike)
        
        # Use wider strikes to capture more of the user's range
        lower_idx = max(0, idx - 3)
        upper_idx = min(len(strikes) - 1, idx + 3)
        
        if lower_idx < idx < upper_idx:
            return (strikes[lower_idx], middle_strike, strikes[upper_idx])
        return None
    
    elif strategy_type == "jade_lizard":
        # Jade Lizard: Short put below range, short call spread above
        put_strike = max([s for s in strikes if s <= min_price * 0.95], default=min_price)
        call_strike_1 = min([s for s in strikes if s >= max_price], default=max_price)
        call_strike_2 = min([s for s in strikes if s >= max_price * 1.05], default=call_strike_1 + 50)
        
        return (put_strike, call_strike_1, call_strike_2)
    
    elif strategy_type == "reverse_iron_condor":
        # Reverse Iron Condor: Profitable when price moves within the inner strikes
        # Put strikes: sell lower, buy higher (around min_price)
        # Call strikes: buy lower, sell higher (around max_price)
        lower_put_strike = max([s for s in strikes if s <= min_price * 0.95], default=min_price - 25)
        upper_put_strike = min([s for s in strikes if s >= min_price], default=min_price)
        lower_call_strike = max([s for s in strikes if s <= max_price], default=max_price)
        upper_call_strike = min([s for s in strikes if s >= max_price * 1.05], default=max_price + 25)
        
        return (lower_put_strike, upper_put_strike, lower_call_strike, upper_call_strike)
    
    elif strategy_type == "straddle":
        # For straddle, pick strike closest to middle of user's range
        optimal_strike = min(strikes, key=lambda x: abs(x - mid_price))
        return optimal_strike
    
    elif strategy_type == "strangle":
        # For strangle, put strike below range, call strike above range
        put_strike = max([s for s in strikes if s <= min_price], default=min_price)
        call_strike = min([s for s in strikes if s >= max_price], default=max_price)
        return (put_strike, call_strike)
    
    return None

def analyze_specific_strategy(choice: str, call_contracts: Dict[float, OptionContract], 
                            put_contracts: Dict[float, OptionContract], spot_price: float, base_coin: str, user_price_range: tuple = None):
    """Analyze a specific strategy based on user choice"""
    
    strikes = sorted(call_contracts.keys())
    atm_strike = min(strikes, key=lambda x: abs(x - spot_price))
    
    if choice == "1":  # Iron Condor
        print(f"\n=== Iron Condor Analysis ===")
        if user_price_range:
            print(f"Optimizing Iron Condor for your expected range: ${user_price_range[0]:,.0f} - ${user_price_range[1]:,.0f}")
            optimal_strikes = optimize_strikes_for_range(strikes, user_price_range, "iron_condor")
            
            if optimal_strikes and len(optimal_strikes) == 4:
                long_put, short_put, short_call, long_call = optimal_strikes
                print(f"Optimal strikes: Long Put ${long_put}, Short Put ${short_put}, Short Call ${short_call}, Long Call ${long_call}")
                
                # Check if all strikes are available
                if (long_put in put_contracts and short_put in put_contracts and 
                    short_call in call_contracts and long_call in call_contracts):
                    strategy = StrategyBuilder.iron_condor(
                        call_contracts, put_contracts,
                        long_put, short_put, short_call, long_call
                    )
                    display_strategy_analysis(strategy, spot_price, base_coin, user_price_range)
                else:
                    print("❌ Not all optimal strikes are available. Using default ATM strikes...")
                    # Fall back to default
                    put_strikes = [s for s in strikes if s <= atm_strike][-2:]
                    call_strikes = [s for s in strikes if s >= atm_strike][:2]
                    
                    if len(put_strikes) >= 2 and len(call_strikes) >= 2:
                        strategy = StrategyBuilder.iron_condor(
                            call_contracts, put_contracts,
                            put_strikes[0], put_strikes[1], call_strikes[0], call_strikes[1]
                        )
                        display_strategy_analysis(strategy, spot_price, base_coin, user_price_range)
            else:
                print("❌ Could not optimize strikes for your range")
        else:
            print("Using default ATM strikes (no expected range provided)")
            # Default behavior
            put_strikes = [s for s in strikes if s <= atm_strike][-2:]
            call_strikes = [s for s in strikes if s >= atm_strike][:2]
            
            if len(put_strikes) >= 2 and len(call_strikes) >= 2:
                strategy = StrategyBuilder.iron_condor(
                    call_contracts, put_contracts,
                    put_strikes[0], put_strikes[1], call_strikes[0], call_strikes[1]
                )
                display_strategy_analysis(strategy, spot_price, base_coin, user_price_range)
    
    elif choice == "2":  # Call Butterfly
        print(f"\n=== Call Butterfly Analysis ===")
        if user_price_range:
            print(f"Optimizing Call Butterfly for your expected range: ${user_price_range[0]:,.0f} - ${user_price_range[1]:,.0f}")
            optimal_strikes = optimize_strikes_for_range(strikes, user_price_range, "butterfly")
            if optimal_strikes:
                lower, middle, upper = optimal_strikes
                print(f"Optimal strikes: ${lower}, ${middle}, ${upper}")
                strategy = StrategyBuilder.butterfly(call_contracts, "call", lower, middle, upper)
                display_strategy_analysis(strategy, spot_price, base_coin, user_price_range)
            else:
                print("❌ Could not optimize strikes for your range")
        else:
            idx = strikes.index(atm_strike)
            if idx > 0 and idx < len(strikes) - 1:
                strategy = StrategyBuilder.butterfly(call_contracts, "call", strikes[idx-1], strikes[idx], strikes[idx+1])
                display_strategy_analysis(strategy, spot_price, base_coin, user_price_range)
    
    elif choice == "3":  # Put Butterfly  
        print(f"\n=== Put Butterfly Analysis ===")
        if user_price_range:
            print(f"Optimizing Put Butterfly for your expected range: ${user_price_range[0]:,.0f} - ${user_price_range[1]:,.0f}")
            optimal_strikes = optimize_strikes_for_range(strikes, user_price_range, "butterfly")
            if optimal_strikes:
                lower, middle, upper = optimal_strikes
                print(f"Optimal strikes: ${lower}, ${middle}, ${upper}")
                strategy = StrategyBuilder.butterfly(put_contracts, "put", lower, middle, upper)
                display_strategy_analysis(strategy, spot_price, base_coin, user_price_range)
            else:
                print("❌ Could not optimize strikes for your range")
        else:
            idx = strikes.index(atm_strike)
            if idx > 0 and idx < len(strikes) - 1:
                strategy = StrategyBuilder.butterfly(put_contracts, "put", strikes[idx-1], strikes[idx], strikes[idx+1])
                display_strategy_analysis(strategy, spot_price, base_coin, user_price_range)
    
    elif choice == "4":  # Long Straddle
        print(f"\n=== Long Straddle Analysis ===")
        if user_price_range:
            print(f"Optimizing Long Straddle for your expected range: ${user_price_range[0]:,.0f} - ${user_price_range[1]:,.0f}")
            optimal_strike = optimize_strikes_for_range(strikes, user_price_range, "straddle")
            print(f"Optimal strike: ${optimal_strike}")
            if optimal_strike in call_contracts and optimal_strike in put_contracts:
                strategy = StrategyBuilder.straddle(call_contracts, put_contracts, optimal_strike, True)
                display_strategy_analysis(strategy, spot_price, base_coin, user_price_range)
        else:
            if atm_strike in call_contracts and atm_strike in put_contracts:
                strategy = StrategyBuilder.straddle(call_contracts, put_contracts, atm_strike, True)
                display_strategy_analysis(strategy, spot_price, base_coin, user_price_range)
    
    elif choice == "5":  # Short Straddle
        print(f"\n=== Short Straddle Analysis ===")
        if user_price_range:
            print(f"Optimizing Short Straddle for your expected range: ${user_price_range[0]:,.0f} - ${user_price_range[1]:,.0f}")
            optimal_strike = optimize_strikes_for_range(strikes, user_price_range, "straddle")
            print(f"Optimal strike: ${optimal_strike}")
            if optimal_strike in call_contracts and optimal_strike in put_contracts:
                strategy = StrategyBuilder.straddle(call_contracts, put_contracts, optimal_strike, False)
                display_strategy_analysis(strategy, spot_price, base_coin, user_price_range)
        else:
            if atm_strike in call_contracts and atm_strike in put_contracts:
                strategy = StrategyBuilder.straddle(call_contracts, put_contracts, atm_strike, False)
                display_strategy_analysis(strategy, spot_price, base_coin, user_price_range)
    
    elif choice == "6":  # Long Strangle
        print(f"\n=== Long Strangle Analysis ===")
        if user_price_range:
            print(f"Optimizing Long Strangle for your expected range: ${user_price_range[0]:,.0f} - ${user_price_range[1]:,.0f}")
            optimal_strikes = optimize_strikes_for_range(strikes, user_price_range, "strangle")
            if optimal_strikes:
                put_strike, call_strike = optimal_strikes
                print(f"Optimal strikes: Put ${put_strike}, Call ${call_strike}")
                strategy = StrategyBuilder.strangle(call_contracts, put_contracts, put_strike, call_strike, True)
                display_strategy_analysis(strategy, spot_price, base_coin, user_price_range)
        else:
            otm_put = min([s for s in strikes if s < spot_price], key=lambda x: abs(x - spot_price*0.95), default=None)
            otm_call = min([s for s in strikes if s > spot_price], key=lambda x: abs(x - spot_price*1.05), default=None)
            
            if otm_put and otm_call:
                strategy = StrategyBuilder.strangle(call_contracts, put_contracts, otm_put, otm_call, True)
                display_strategy_analysis(strategy, spot_price, base_coin, user_price_range)
    
    elif choice == "7":  # Long Straddle
        print(f"\n=== Long Straddle Analysis ===")
        if user_price_range:
            print(f"Optimizing Long Straddle for your expected range: ${user_price_range[0]:,.0f} - ${user_price_range[1]:,.0f}")
            optimal_strike = optimize_strikes_for_range(strikes, user_price_range, "straddle")
            if optimal_strike:
                print(f"Optimal strike: ${optimal_strike}")
                strategy = StrategyBuilder.straddle(call_contracts, put_contracts, optimal_strike, True)
                display_strategy_analysis(strategy, spot_price, base_coin, user_price_range)
        else:
            strategy = StrategyBuilder.straddle(call_contracts, put_contracts, atm_strike, True)
            display_strategy_analysis(strategy, spot_price, base_coin, user_price_range)
    
    elif choice == "4":  # Wide Call Butterfly
        print(f"\n=== Wide Call Butterfly Analysis ===")
        if user_price_range:
            print(f"Optimizing Wide Call Butterfly for your expected range: ${user_price_range[0]:,.0f} - ${user_price_range[1]:,.0f}")
            optimal_strikes = optimize_strikes_for_range(strikes, user_price_range, "wide_butterfly")
            if optimal_strikes:
                lower, middle, upper = optimal_strikes
                print(f"Optimal strikes: ${lower}, ${middle}, ${upper}")
                strategy = StrategyBuilder.wide_butterfly(call_contracts, "call", lower, middle, upper)
                display_strategy_analysis(strategy, spot_price, base_coin, user_price_range)
            else:
                print("❌ Could not optimize strikes for your range")
        else:
            idx = strikes.index(atm_strike)
            if idx >= 2 and idx < len(strikes) - 2:
                strategy = StrategyBuilder.wide_butterfly(call_contracts, "call", strikes[idx-2], strikes[idx], strikes[idx+2])
                display_strategy_analysis(strategy, spot_price, base_coin, user_price_range)
    
    elif choice == "5":  # Wide Put Butterfly
        print(f"\n=== Wide Put Butterfly Analysis ===")
        if user_price_range:
            print(f"Optimizing Wide Put Butterfly for your expected range: ${user_price_range[0]:,.0f} - ${user_price_range[1]:,.0f}")
            optimal_strikes = optimize_strikes_for_range(strikes, user_price_range, "wide_butterfly")
            if optimal_strikes:
                lower, middle, upper = optimal_strikes
                print(f"Optimal strikes: ${lower}, ${middle}, ${upper}")
                strategy = StrategyBuilder.wide_butterfly(put_contracts, "put", lower, middle, upper)
                display_strategy_analysis(strategy, spot_price, base_coin, user_price_range)
            else:
                print("❌ Could not optimize strikes for your range")
        else:
            idx = strikes.index(atm_strike)
            if idx >= 2 and idx < len(strikes) - 2:
                strategy = StrategyBuilder.wide_butterfly(put_contracts, "put", strikes[idx-2], strikes[idx], strikes[idx+2])
                display_strategy_analysis(strategy, spot_price, base_coin, user_price_range)
    
    elif choice == "6":  # Iron Butterfly
        print(f"\n=== Iron Butterfly Analysis ===")
        if user_price_range:
            print(f"Optimizing Iron Butterfly for your expected range: ${user_price_range[0]:,.0f} - ${user_price_range[1]:,.0f}")
            optimal_strikes = optimize_strikes_for_range(strikes, user_price_range, "iron_butterfly")
            if optimal_strikes:
                lower, middle, upper = optimal_strikes
                print(f"Optimal strikes: ${lower}, ${middle}, ${upper}")
                strategy = StrategyBuilder.iron_butterfly(call_contracts, put_contracts, lower, middle, upper)
                display_strategy_analysis(strategy, spot_price, base_coin, user_price_range)
            else:
                print("❌ Could not optimize strikes for your range")
        else:
            idx = strikes.index(atm_strike)
            if idx >= 3 and idx < len(strikes) - 3:
                strategy = StrategyBuilder.iron_butterfly(call_contracts, put_contracts, strikes[idx-3], strikes[idx], strikes[idx+3])
                display_strategy_analysis(strategy, spot_price, base_coin, user_price_range)
    
    elif choice == "8":  # Short Straddle (renumbered)
        print(f"\n=== Short Straddle Analysis ===")
        if user_price_range:
            print(f"Optimizing Short Straddle for your expected range: ${user_price_range[0]:,.0f} - ${user_price_range[1]:,.0f}")
            optimal_strike = optimize_strikes_for_range(strikes, user_price_range, "straddle")
            if optimal_strike:
                print(f"Optimal strike: ${optimal_strike}")
                strategy = StrategyBuilder.straddle(call_contracts, put_contracts, optimal_strike, False)
                display_strategy_analysis(strategy, spot_price, base_coin, user_price_range)
        else:
            strategy = StrategyBuilder.straddle(call_contracts, put_contracts, atm_strike, False)
            display_strategy_analysis(strategy, spot_price, base_coin, user_price_range)
    
    elif choice == "9":  # Long Strangle (renumbered)
        print(f"\n=== Long Strangle Analysis ===")
        if user_price_range:
            print(f"Optimizing Long Strangle for your expected range: ${user_price_range[0]:,.0f} - ${user_price_range[1]:,.0f}")
            optimal_strikes = optimize_strikes_for_range(strikes, user_price_range, "strangle")
            if optimal_strikes:
                put_strike, call_strike = optimal_strikes
                print(f"Optimal strikes: Put ${put_strike}, Call ${call_strike}")
                strategy = StrategyBuilder.strangle(call_contracts, put_contracts, put_strike, call_strike, True)
                display_strategy_analysis(strategy, spot_price, base_coin, user_price_range)
        else:
            otm_put = min([s for s in strikes if s < spot_price], key=lambda x: abs(x - spot_price*0.95), default=None)
            otm_call = min([s for s in strikes if s > spot_price], key=lambda x: abs(x - spot_price*1.05), default=None)
            
            if otm_put and otm_call:
                strategy = StrategyBuilder.strangle(call_contracts, put_contracts, otm_put, otm_call, True)
                display_strategy_analysis(strategy, spot_price, base_coin, user_price_range)
    
    elif choice == "10":  # Short Strangle (renumbered)
        print(f"\n=== Short Strangle Analysis ===")
        if user_price_range:
            print(f"Optimizing Short Strangle for your expected range: ${user_price_range[0]:,.0f} - ${user_price_range[1]:,.0f}")
            optimal_strikes = optimize_strikes_for_range(strikes, user_price_range, "strangle")
            if optimal_strikes:
                put_strike, call_strike = optimal_strikes
                print(f"Optimal strikes: Put ${put_strike}, Call ${call_strike}")
                strategy = StrategyBuilder.strangle(call_contracts, put_contracts, put_strike, call_strike, False)
                display_strategy_analysis(strategy, spot_price, base_coin, user_price_range)
        else:
            otm_put = min([s for s in strikes if s < spot_price], key=lambda x: abs(x - spot_price*0.95), default=None)
            otm_call = min([s for s in strikes if s > spot_price], key=lambda x: abs(x - spot_price*1.05), default=None)
            
            if otm_put and otm_call:
                strategy = StrategyBuilder.strangle(call_contracts, put_contracts, otm_put, otm_call, False)
                display_strategy_analysis(strategy, spot_price, base_coin, user_price_range)
    
    elif choice == "11":  # Jade Lizard
        print(f"\n=== Jade Lizard Analysis ===")
        if user_price_range:
            print(f"Optimizing Jade Lizard for your expected range: ${user_price_range[0]:,.0f} - ${user_price_range[1]:,.0f}")
            optimal_strikes = optimize_strikes_for_range(strikes, user_price_range, "jade_lizard")
            if optimal_strikes:
                put_strike, call_strike_1, call_strike_2 = optimal_strikes
                print(f"Optimal strikes: Put ${put_strike}, Call Spread ${call_strike_1}/${call_strike_2}")
                strategy = StrategyBuilder.jade_lizard(call_contracts, put_contracts, put_strike, call_strike_1, call_strike_2)
                display_strategy_analysis(strategy, spot_price, base_coin, user_price_range)
            else:
                print("❌ Could not optimize strikes for your range")
        else:
            # Default Jade Lizard setup
            otm_put = min([s for s in strikes if s < spot_price * 0.95], key=lambda x: abs(x - spot_price*0.9), default=None)
            otm_call_1 = min([s for s in strikes if s > spot_price * 1.05], key=lambda x: abs(x - spot_price*1.1), default=None)
            otm_call_2 = min([s for s in strikes if s > spot_price * 1.15], key=lambda x: abs(x - spot_price*1.2), default=None)
            
            if otm_put and otm_call_1 and otm_call_2:
                strategy = StrategyBuilder.jade_lizard(call_contracts, put_contracts, otm_put, otm_call_1, otm_call_2)
                display_strategy_analysis(strategy, spot_price, base_coin, user_price_range)
    
    elif choice == "12":  # Reverse Iron Condor
        print(f"\n=== Reverse Iron Condor Analysis ===")
        if user_price_range:
            print(f"Optimizing Reverse Iron Condor for your expected range: ${user_price_range[0]:,.0f} - ${user_price_range[1]:,.0f}")
            optimal_strikes = optimize_strikes_for_range(strikes, user_price_range, "reverse_iron_condor")
            if optimal_strikes:
                lower_put, upper_put, lower_call, upper_call = optimal_strikes
                print(f"Optimal strikes: Put spread ${lower_put}/${upper_put}, Call spread ${lower_call}/${upper_call}")
                strategy = StrategyBuilder.reverse_iron_condor(call_contracts, put_contracts, lower_put, upper_put, lower_call, upper_call)
                display_strategy_analysis(strategy, spot_price, base_coin, user_price_range)
            else:
                print("❌ Could not optimize strikes for your range")
        else:
            # Default reverse iron condor around ATM
            idx = strikes.index(atm_strike)
            if idx >= 2 and idx < len(strikes) - 2:
                strategy = StrategyBuilder.reverse_iron_condor(call_contracts, put_contracts, 
                                                            strikes[idx-2], strikes[idx-1], strikes[idx+1], strikes[idx+2])
                display_strategy_analysis(strategy, spot_price, base_coin, user_price_range)

    elif choice == "13":  # Compare strategies
        compare_strategies(call_contracts, put_contracts, spot_price, base_coin, user_price_range)

def get_user_price_range(spot_price: float, base_coin: str) -> tuple:
    """Get user's expected price range for the asset at expiration"""
    try:
        print(f"\n--- Expected Price Range at Expiration ---")
        print(f"Current {base_coin} spot price: ${spot_price:,.2f}")
        print("Enter your expected price range where you think the asset will likely end up at expiration.")
        print("(Press Enter to skip and use default ±30% range)")
        
        min_price = input(f"Expected minimum price (default ${spot_price*0.7:.0f}): ").strip()
        if not min_price:
            return None
        
        max_price = input(f"Expected maximum price (default ${spot_price*1.3:.0f}): ").strip()
        if not max_price:
            return None
        
        min_val = float(min_price.replace('$', '').replace(',', ''))
        max_val = float(max_price.replace('$', '').replace(',', ''))
        
        if min_val >= max_val:
            print("Invalid range: minimum must be less than maximum. Using default range.")
            return None
        
        print(f"Using expected range: ${min_val:,.0f} - ${max_val:,.0f}")
        return (min_val, max_val)
        
    except (ValueError, EOFError):
        return None

def display_strategy_analysis(strategy: OptionsStrategy, spot_price: float, base_coin: str, user_price_range: tuple = None):
    """Display comprehensive analysis of a strategy"""
    
    # Use user's expected range for primary analysis, fallback to default
    if user_price_range:
        analysis_range = user_price_range
        breakevens = strategy.get_breakeven_points((spot_price * 0.5, spot_price * 1.5))  # Wider range for breakevens
        max_profit, max_loss = strategy.get_max_profit_loss(analysis_range)
    else:
        analysis_range = (spot_price * 0.7, spot_price * 1.3)
        breakevens = strategy.get_breakeven_points(analysis_range)
        max_profit, max_loss = strategy.get_max_profit_loss(analysis_range)
    
    current_pnl = strategy.calculate_pnl(spot_price)
    
    print(f"\n{'-'*60}")
    print(f"STRATEGY: {strategy.name}")
    print(f"{'-'*60}")
    print(f"Net Premium: ${strategy.net_premium():.2f} {'(Credit)' if strategy.net_premium() < 0 else '(Debit)'}")
    print(f"Trading Fees: ${strategy.total_fees:.2f}")
    print(f"Current P&L: ${current_pnl:.2f}")
    
    if user_price_range:
        print(f"Max Profit in YOUR range: ${max_profit:.2f}")
        print(f"Max Loss in YOUR range: ${max_loss:.2f}")
        # Check if strategy is profitable in user's expected range
        min_price, max_price = user_price_range
        is_profitable_in_range = check_profitability_in_range(strategy, user_price_range)
        print(f"Profitable in your expected range (${min_price:,.0f}-${max_price:,.0f}): {'✅ YES' if is_profitable_in_range else '❌ NO'}")
    else:
        print(f"Max Profit: ${max_profit:.2f}")
        print(f"Max Loss: ${max_loss:.2f}")
    
    if breakevens:
        be_text = ', '.join([f'${be:.0f}' for be in breakevens])
        print(f"Breakeven Points: {be_text}")
    
    print(f"\nStrategy Legs:")
    for i, leg in enumerate(strategy.legs):
        action = "Long" if leg.quantity > 0 else "Short"
        print(f"  {i+1}. {action} {abs(leg.quantity)}x {leg.contract.option_type.title()} ${leg.contract.strike:.0f} @ ${leg.contract.mid_price:.2f}")
    
    # Show focused analysis for user's expected range
    if user_price_range:
        analyze_strategy_in_user_range(strategy, user_price_range, spot_price, base_coin)
    
    # Ask if user wants to see the P&L graph
    try:
        show_graph = input(f"\nShow P&L graph for {strategy.name}? (y/n): ").strip().lower()
        if show_graph in ['y', 'yes', '']:
            plot_strategy_pnl(strategy, spot_price, base_coin, user_price_range)
    except EOFError:
        pass

def check_profitability_in_range(strategy: OptionsStrategy, price_range: tuple) -> bool:
    """Check if strategy is profitable throughout the user's expected price range"""
    min_price, max_price = price_range
    
    # Check P&L at range boundaries and midpoint
    min_pnl = strategy.calculate_pnl(min_price)
    max_pnl = strategy.calculate_pnl(max_price)
    mid_pnl = strategy.calculate_pnl((min_price + max_price) / 2)
    
    # Strategy is profitable if all key points in the range are profitable
    return min_pnl > 0 and max_pnl > 0 and mid_pnl > 0

def analyze_strategy_in_user_range(strategy: OptionsStrategy, price_range: tuple, spot_price: float, base_coin: str):
    """Detailed analysis focused on user's expected price range"""
    min_price, max_price = price_range
    mid_price = (min_price + max_price) / 2
    
    # Calculate P&L at key points in user's range
    min_pnl = strategy.calculate_pnl(min_price)
    max_pnl = strategy.calculate_pnl(max_price)
    mid_pnl = strategy.calculate_pnl(mid_price)
    
    print(f"\n🎯 ANALYSIS FOR YOUR EXPECTED RANGE (${min_price:,.0f} - ${max_price:,.0f})")
    print(f"{'='*65}")
    
    print(f"📊 P&L at Key Levels:")
    print(f"   At ${min_price:,.0f} (your low):  ${min_pnl:,.2f}")
    print(f"   At ${mid_price:,.0f} (midpoint):  ${mid_pnl:,.2f}")
    print(f"   At ${max_price:,.0f} (your high): ${max_pnl:,.2f}")
    
    # Simple recommendation based on whether strategy makes money in user's range
    all_profitable = min_pnl > 0 and max_pnl > 0 and mid_pnl > 0
    all_losses = min_pnl < 0 and max_pnl < 0 and mid_pnl < 0
    
    if all_profitable:
        print(f"\n✅ RESULT: Strategy is PROFITABLE across your entire expected range!")
    elif all_losses:
        print(f"\n❌ RESULT: Strategy shows LOSSES across your entire expected range!")
    else:
        print(f"\n⚠️  RESULT: Mixed results - profitable at some prices, losses at others in your range")
        
        # Show which specific prices are profitable vs loss
        profitable_levels = []
        loss_levels = []
        
        if min_pnl > 0:
            profitable_levels.append(f"${min_price:,.0f}")
        else:
            loss_levels.append(f"${min_price:,.0f}")
            
        if mid_pnl > 0:
            profitable_levels.append(f"${mid_price:,.0f}")
        else:
            loss_levels.append(f"${mid_price:,.0f}")
            
        if max_pnl > 0:
            profitable_levels.append(f"${max_price:,.0f}")
        else:
            loss_levels.append(f"${max_price:,.0f}")
        
        if profitable_levels:
            print(f"   Profitable at: {', '.join(profitable_levels)}")
        if loss_levels:
            print(f"   Losses at: {', '.join(loss_levels)}")

def analyze_expected_pnl(strategy: OptionsStrategy, price_range: tuple, spot_price: float, base_coin: str):
    """Analyze P&L within user's expected price range"""
    min_price, max_price = price_range
    
    # Calculate P&L at range boundaries and midpoint
    min_pnl = strategy.calculate_pnl(min_price)
    max_pnl = strategy.calculate_pnl(max_price)
    mid_price = (min_price + max_price) / 2
    mid_pnl = strategy.calculate_pnl(mid_price)
    
    # Find best and worst case within the range
    prices = np.linspace(min_price, max_price, 100)
    pnls = [strategy.calculate_pnl(p) for p in prices]
    best_pnl = max(pnls)
    worst_pnl = min(pnls)
    
    print(f"\n--- Expected Range Analysis (${min_price:,.0f} - ${max_price:,.0f}) ---")
    print(f"P&L at ${min_price:,.0f}: ${min_pnl:,.2f}")
    print(f"P&L at ${mid_price:,.0f} (midpoint): ${mid_pnl:,.2f}") 
    print(f"P&L at ${max_price:,.0f}: ${max_pnl:,.2f}")
    print(f"Best case in range: ${best_pnl:,.2f}")
    print(f"Worst case in range: ${worst_pnl:,.2f}")
    
    # Probability of profit (assuming uniform distribution)
    profitable_count = sum(1 for pnl in pnls if pnl > 0)
    prob_profit = profitable_count / len(pnls) * 100
    print(f"Probability of profit in expected range: {prob_profit:.1f}%")

def compare_strategies(call_contracts: Dict[float, OptionContract], 
                     put_contracts: Dict[float, OptionContract], spot_price: float, base_coin: str, user_price_range: tuple = None):
    """Compare multiple strategies side by side"""
    print(f"\n=== Strategy Comparison ===")
    
    strikes = sorted(call_contracts.keys())
    atm_strike = min(strikes, key=lambda x: abs(x - spot_price))
    
    strategies = []
    
    # Build common strategies for comparison
    try:
        # Iron Condor
        put_strikes = [s for s in strikes if s <= atm_strike][-2:]
        call_strikes = [s for s in strikes if s >= atm_strike][:2]
        if len(put_strikes) >= 2 and len(call_strikes) >= 2:
            ic = StrategyBuilder.iron_condor(call_contracts, put_contracts, put_strikes[0], put_strikes[1], call_strikes[0], call_strikes[1])
            strategies.append(ic)
        
        # Straddles
        if atm_strike in call_contracts and atm_strike in put_contracts:
            long_straddle = StrategyBuilder.straddle(call_contracts, put_contracts, atm_strike, True)
            short_straddle = StrategyBuilder.straddle(call_contracts, put_contracts, atm_strike, False)
            strategies.extend([long_straddle, short_straddle])
        
        # Butterfly
        idx = strikes.index(atm_strike)
        if idx > 0 and idx < len(strikes) - 1:
            call_butterfly = StrategyBuilder.butterfly(call_contracts, "call", strikes[idx-1], strikes[idx], strikes[idx+1])
            strategies.append(call_butterfly)
        
    except Exception as e:
        print(f"Error building strategies: {e}")
        return
    
    if not strategies:
        print("No strategies available for comparison")
        return
    
    # Display comparison table
    print(f"\n{'Strategy':<20} {'Net Premium':<12} {'Fees':<8} {'Max Profit':<12} {'Max Loss':<12} {'Current P&L':<12}")
    print("-" * 80)
    
    price_range = (spot_price * 0.7, spot_price * 1.3)
    
    for strategy in strategies:
        max_profit, max_loss = strategy.get_max_profit_loss(price_range)
        current_pnl = strategy.calculate_pnl(spot_price)
        
        print(f"{strategy.name:<20} ${strategy.net_premium():<11.2f} ${strategy.total_fees:<7.2f} ${max_profit:<11.2f} ${max_loss:<11.2f} ${current_pnl:<11.2f}")
    
    # Plot comparison
    try:
        show_graph = input(f"\nShow comparison graph? (y/n): ").strip().lower()
        if show_graph in ['y', 'yes', '']:
            plot_strategy_comparison(strategies, spot_price, base_coin, user_price_range)
            
            # Show comparison within expected range
            if user_price_range:
                compare_strategies_in_range(strategies, user_price_range, spot_price, base_coin)
    except EOFError:
        pass

def plot_strategy_comparison(strategies: List[OptionsStrategy], spot_price: float, base_coin: str, user_price_range: tuple = None):
    """Plot multiple strategies for comparison using Plotly"""
    # Always show ±10% from current spot price for full view
    chart_range = (spot_price * 0.9, spot_price * 1.1)
    
    # If user has a specific range, make sure chart covers it too
    if user_price_range:
        min_chart = min(chart_range[0], user_price_range[0] * 0.95)
        max_chart = max(chart_range[1], user_price_range[1] * 1.05)
        chart_range = (min_chart, max_chart)
    
    fig = go.Figure()
    
    colors = ['blue', 'red', 'green', 'purple', 'orange', 'brown', 'pink', 'cyan']
    
    # Add each strategy line
    for i, strategy in enumerate(strategies):
        prices, pnls = strategy.get_pnl_range(chart_range)
        color = colors[i % len(colors)]
        
        fig.add_trace(go.Scatter(
            x=prices, y=pnls,
            mode='lines',
            name=strategy.name,
            line=dict(color=color, width=3),
            hovertemplate=f'<b>{strategy.name}</b><br>' +
                         f'<b>{base_coin} Price:</b> $%{{x:,.0f}}<br>' +
                         '<b>P&L:</b> $%{y:,.2f}<extra></extra>'
        ))
    
    # Zero line
    fig.add_hline(y=0, line_dash="dash", line_color="black", opacity=0.5,
                  annotation_text="Breakeven Line")
    
    # Current spot price line
    fig.add_vline(x=spot_price, line_dash="dot", line_color="green", opacity=0.8,
                  annotation_text=f"Current Spot: ${spot_price:,.0f}")
    
    # Add user's expected price range if provided (highlighted zone)
    if user_price_range:
        fig.add_vrect(
            x0=user_price_range[0], x1=user_price_range[1],
            fillcolor="gold", opacity=0.25,
            line_width=2,
            line_color="orange",
            annotation_text=f"Your Expected Range<br>${user_price_range[0]:,.0f} - ${user_price_range[1]:,.0f}",
            annotation_position="top left"
        )
        
        # Add range boundary lines
        fig.add_vline(x=user_price_range[0], line_dash="dash", line_color="orange", opacity=0.7,
                      annotation_text=f"Expected Low: ${user_price_range[0]:,.0f}")
        fig.add_vline(x=user_price_range[1], line_dash="dash", line_color="orange", opacity=0.7,
                      annotation_text=f"Expected High: ${user_price_range[1]:,.0f}")
    
    # Add current P&L points for each strategy
    for i, strategy in enumerate(strategies):
        current_pnl = strategy.calculate_pnl(spot_price)
        color = colors[i % len(colors)]
        
        fig.add_trace(go.Scatter(
            x=[spot_price], y=[current_pnl],
            mode='markers',
            name=f'{strategy.name} Current',
            marker=dict(color=color, size=8, symbol='circle'),
            showlegend=False,
            hovertemplate=f'<b>{strategy.name}</b><br>' +
                         f'<b>Current P&L:</b> ${current_pnl:,.2f}<extra></extra>'
        ))
    
    # Update layout
    fig.update_layout(
        title=f'Strategy Comparison - P&L at Expiration<br>' +
              f'<sub>Chart Range: ±10% from Spot | Current {base_coin}: ${spot_price:,.2f}</sub>',
        xaxis_title=f'{base_coin} Price ($)',
        yaxis_title='Profit/Loss ($)',
        width=1200,
        height=700,
        hovermode='x unified',
        legend=dict(
            yanchor="top", y=0.99,
            xanchor="right", x=0.99,
            bgcolor='rgba(255, 255, 255, 0.8)',
            bordercolor='black',
            borderwidth=1
        ),
        template='plotly_white'
    )
    
    # Add strategy summary table as annotation
    summary_text = "Strategy Summary:<br>"
    for strategy in strategies:
        price_range_calc = (spot_price * 0.7, spot_price * 1.3)
        max_profit, max_loss = strategy.get_max_profit_loss(price_range_calc)
        current_pnl = strategy.calculate_pnl(spot_price)
        summary_text += f"{strategy.name}: P&L ${current_pnl:.0f}, Max P: ${max_profit:.0f}, Max L: ${max_loss:.0f}<br>"
    
    fig.add_annotation(
        x=0.02, y=0.02,
        xref='paper', yref='paper',
        text=summary_text,
        showarrow=False,
        bgcolor='rgba(255, 255, 255, 0.9)',
        bordercolor='black',
        borderwidth=1,
        font=dict(size=10),
        align='left'
    )
    
    fig.show()

def compare_strategies_in_range(strategies: List[OptionsStrategy], price_range: tuple, spot_price: float, base_coin: str):
    """Compare strategies within user's expected price range"""
    min_price, max_price = price_range
    mid_price = (min_price + max_price) / 2
    
    print(f"\n--- Strategy Performance in Expected Range (${min_price:,.0f} - ${max_price:,.0f}) ---")
    print(f"{'Strategy':<20} {'Min P&L':<12} {'Mid P&L':<12} {'Max P&L':<12} {'Prob Profit':<12} {'Best Case':<12}")
    print("-" * 85)
    
    for strategy in strategies:
        # Calculate P&L at boundaries and midpoint
        min_pnl = strategy.calculate_pnl(min_price)
        max_pnl = strategy.calculate_pnl(max_price)
        mid_pnl = strategy.calculate_pnl(mid_price)
        
        # Calculate best case and probability of profit in range
        prices = np.linspace(min_price, max_price, 100)
        pnls = [strategy.calculate_pnl(p) for p in prices]
        best_case = max(pnls)
        prob_profit = sum(1 for pnl in pnls if pnl > 0) / len(pnls) * 100
        
        print(f"{strategy.name:<20} ${min_pnl:<11.0f} ${mid_pnl:<11.0f} ${max_pnl:<11.0f} {prob_profit:<11.1f}% ${best_case:<11.0f}")
    
    # Recommend best strategy for the expected range
    print(f"\n--- Strategy Rankings for Expected Range ---")
    
    # Rank by average P&L in range
    strategy_scores = []
    for strategy in strategies:
        prices = np.linspace(min_price, max_price, 50)
        avg_pnl = np.mean([strategy.calculate_pnl(p) for p in prices])
        prob_profit = sum(1 for p in prices if strategy.calculate_pnl(p) > 0) / len(prices) * 100
        strategy_scores.append((strategy.name, avg_pnl, prob_profit))
    
    # Sort by average P&L
    strategy_scores.sort(key=lambda x: x[1], reverse=True)
    
    print("Ranked by Expected Average P&L:")
    for i, (name, avg_pnl, prob) in enumerate(strategy_scores, 1):
        print(f"{i}. {name}: ${avg_pnl:.0f} avg P&L, {prob:.0f}% profit probability")

def display_options_for_date(date: str, options: Dict, spot_price: float, base_coin: str):
    """Display options chain for a specific expiration date"""
    print(f"\n{'='*95}")
    print(f"{base_coin} Options Chain - Expiration: {date}")
    print(f"Spot Price: ${spot_price:,.2f}")
    print(f"{'='*95}")
    
    # Sort by strike price
    calls = sorted(options["calls"], key=lambda x: x["strike"])
    puts = sorted(options["puts"], key=lambda x: x["strike"])
    
    # Get all unique strikes
    all_strikes = set()
    for call in calls:
        all_strikes.add(call["strike"])
    for put in puts:
        all_strikes.add(put["strike"])
    
    sorted_strikes = sorted(all_strikes)
    
    # Create lookup dictionaries
    calls_dict = {c["strike"]: c for c in calls}
    puts_dict = {p["strike"]: p for p in puts}
    
    # Header
    print(f"\n{'CALLS':<50} {'STRIKE':<12} {'PUTS':<50}")
    print(f"{'Bid':<8} {'Ask':<8} {'Last':<8} {'Vol':<8} {'Delta':<8} {'Price':<12} {'Bid':<8} {'Ask':<8} {'Last':<8} {'Vol':<8} {'Delta':<8}")
    print("-" * 115)
    
    # Display options chain
    for strike in sorted_strikes:
        call_data = calls_dict.get(strike)
        put_data = puts_dict.get(strike)
        
        # Call side
        if call_data:
            call_bid = f"{call_data['bid']:.4f}" if call_data['bid'] > 0 else "-"
            call_ask = f"{call_data['ask']:.4f}" if call_data['ask'] > 0 else "-"
            call_last = f"{call_data['last']:.4f}" if call_data['last'] > 0 else "-"
            call_vol = f"{call_data['volume']:.0f}" if call_data['volume'] > 0 else "-"
            call_delta = f"{call_data['delta']:.3f}" if call_data['delta'] != 0 else "-"
        else:
            call_bid = call_ask = call_last = call_vol = call_delta = "-"
        
        # Put side
        if put_data:
            put_bid = f"{put_data['bid']:.4f}" if put_data['bid'] > 0 else "-"
            put_ask = f"{put_data['ask']:.4f}" if put_data['ask'] > 0 else "-"
            put_last = f"{put_data['last']:.4f}" if put_data['last'] > 0 else "-"
            put_vol = f"{put_data['volume']:.0f}" if put_data['volume'] > 0 else "-"
            put_delta = f"{put_data['delta']:.3f}" if put_data['delta'] != 0 else "-"
        else:
            put_bid = put_ask = put_last = put_vol = put_delta = "-"
        
        print(f"{call_bid:<8} {call_ask:<8} {call_last:<8} {call_vol:<8} {call_delta:<8} ${strike:<11.0f} {put_bid:<8} {put_ask:<8} {put_last:<8} {put_vol:<8} {put_delta:<8}")
    
    print(f"\n* ITM Calls: Strike < ${spot_price:,.0f} | ITM Puts: Strike > ${spot_price:,.0f}")
    
    # Find best strike prices based on delta-to-ask ratio
    display_best_delta_ask_ratios(options, spot_price, base_coin)

def display_best_delta_ask_ratios(options: Dict, spot_price: float, base_coin: str):
    """Display best strike prices based on delta-to-ask ratio for buying options (includes fees)"""
    print(f"\n{'='*80}")
    print(f"BEST DELTA-TO-COST RATIOS (For Buying Options - Including Fees)")
    print(f"{'='*80}")
    
    calls = options["calls"]
    puts = options["puts"]
    
    # Calculate delta-to-cost ratios for calls (including fees)
    call_ratios = []
    for call in calls:
        ask = call.get("ask", 0)
        delta = abs(call.get("delta", 0))  # Use absolute delta
        if ask > 0 and delta > 0:
            fee = calculate_bybit_options_fee(ask, spot_price)
            total_cost = ask + fee
            ratio = delta / total_cost
            call_ratios.append({
                "strike": call["strike"],
                "ask": ask,
                "fee": fee,
                "total_cost": total_cost,
                "delta": call["delta"],
                "ratio": ratio,
                "volume": call.get("volume", 0)
            })
    
    # Calculate delta-to-cost ratios for puts (including fees)
    put_ratios = []
    for put in puts:
        ask = put.get("ask", 0)
        delta = abs(put.get("delta", 0))  # Use absolute delta for puts
        if ask > 0 and delta > 0:
            fee = calculate_bybit_options_fee(ask, spot_price)
            total_cost = ask + fee
            ratio = delta / total_cost
            put_ratios.append({
                "strike": put["strike"],
                "ask": ask,
                "fee": fee,
                "total_cost": total_cost,
                "delta": put["delta"],
                "ratio": ratio,
                "volume": put.get("volume", 0)
            })
    
    # Sort by ratio (highest first - best value)
    call_ratios.sort(key=lambda x: x["ratio"], reverse=True)
    put_ratios.sort(key=lambda x: x["ratio"], reverse=True)
    
    # Display best calls
    print(f"\n📈 BEST CALLS (Delta/Cost Ratio - Including Fees):")
    print(f"{'Rank':<4} {'Strike':<10} {'Ask Price':<12} {'Fee':<8} {'Total Cost':<12} {'Delta':<8} {'Ratio':<10} {'Volume':<8}")
    print("-" * 80)
    
    for i, call in enumerate(call_ratios[:10], 1):  # Top 10
        print(f"{i:<4} ${call['strike']:<9.0f} ${call['ask']:<11.5f} ${call['fee']:<7.5f} ${call['total_cost']:<11.5f} {call['delta']:<7.5f} {call['ratio']:<9.5f} {call['volume']:<8.0f}")
    
    # Display best puts
    print(f"\n📉 BEST PUTS (Delta/Cost Ratio - Including Fees):")
    print(f"{'Rank':<4} {'Strike':<10} {'Ask Price':<12} {'Fee':<8} {'Total Cost':<12} {'Delta':<8} {'Ratio':<10} {'Volume':<8}")
    print("-" * 80)
    
    for i, put in enumerate(put_ratios[:10], 1):  # Top 10
        print(f"{i:<4} ${put['strike']:<9.0f} ${put['ask']:<11.5f} ${put['fee']:<7.5f} ${put['total_cost']:<11.5f} {put['delta']:<7.5f} {put['ratio']:<9.5f} {put['volume']:<8.0f}")
    
    # Highlight the top 3 best options
    if call_ratios and put_ratios:
        print(f"\n🏆 TOP 3 CALL RECOMMENDATIONS (Including Fees):")
        for i, call in enumerate(call_ratios[:3], 1):
            call_distance = ((call['strike'] - spot_price) / spot_price) * 100
            print(f"{i}. ${call['strike']:.0f} strike @ ${call['total_cost']:.5f} total (Ask: ${call['ask']:.5f} + Fee: ${call['fee']:.5f}) (Delta: {call['delta']:.5f}, Ratio: {call['ratio']:.5f}) - {call_distance:+.1f}% {'OTM' if call['strike'] > spot_price else 'ITM'}")
        
        print(f"\n🏆 TOP 3 PUT RECOMMENDATIONS (Including Fees):")
        for i, put in enumerate(put_ratios[:3], 1):
            put_distance = ((spot_price - put['strike']) / spot_price) * 100
            print(f"{i}. ${put['strike']:.0f} strike @ ${put['total_cost']:.5f} total (Ask: ${put['ask']:.5f} + Fee: ${put['fee']:.5f}) (Delta: {put['delta']:.5f}, Ratio: {put['ratio']:.5f}) - {put_distance:+.1f}% {'OTM' if put['strike'] < spot_price else 'ITM'}")

def main():
    """Main function to fetch and display options market data"""
    api = BybitOptionsAPI()
    
    print("=== Bybit Options Market Data ===")
    print("Select cryptocurrency:")
    print("1. BTC")
    print("2. ETH")
    
    try:
        choice = input("Enter choice (1 or 2, default=1): ").strip()
    except EOFError:
        choice = "1"
    
    base_coin = "ETH" if choice == "2" else "BTC"
    
    print(f"\nFetching {base_coin} options data...")
    display_options_by_date(api, base_coin)

if __name__ == "__main__":
    main()