# Bybit Options Trading Interface

A modern web-based interface for viewing and analyzing Bybit cryptocurrency options, similar to the official Bybit platform.

## Features

- **Real-time Options Data**: Live options chains for BTC, ETH, and SOL
- **Professional Interface**: Clean, modern UI similar to Bybit's official platform
- **Multiple Expiration Dates**: Easy switching between different expiration dates
- **Options Chain View**: Side-by-side calls and puts with bid/ask spreads, volume, and Greeks
- **Strategy Recommendations**: Built-in strategy suggestions based on market conditions
- **Market Analytics**: Put/call ratios, implied volatility, and other key metrics

## Architecture

- **Frontend**: Next.js 14 with TypeScript and Tailwind CSS
- **Backend**: Node.js/Express API serving live data from Bybit
- **Data Source**: Bybit V5 REST API

## Quick Start

### Prerequisites

- Node.js 18+
- npm or yarn

### 1. Start the Backend

```bash
./start_backend.sh
```

This will:
- Install Node.js dependencies 
- Create environment configuration
- Start the Express server on http://localhost:8000

### 2. Start the Frontend

```bash
./start_frontend.sh
```

This will:
- Install Node.js dependencies
- Start the Next.js dev server on http://localhost:3000

### 3. Open the Application

Navigate to http://localhost:3000 in your browser.

## Manual Setup

### Backend Setup

```bash
cd backend
npm install
cp .env.example .env  # Configure environment variables
npm run dev
```

### Frontend Setup

```bash
cd frontend
npm install
npm run dev
```

## API Endpoints

- `GET /api/options/{crypto}` - Get full options data for BTC, ETH, or SOL
- `GET /api/options/{crypto}/{expiration}` - Get options chain for specific expiration
- `GET /api/spot/{symbol}` - Get current spot price
- `GET /api/spots` - Get multiple spot prices (BTC, ETH, SOL)
- `GET /api/market-stats/{crypto}` - Get market statistics and analytics
- `GET /api/health` - Health check

## Project Structure

```
├── bybit_options.py          # Original Python script with strategy analysis
├── backend/
│   ├── server.js            # Express API server
│   ├── lib/
│   │   ├── bybit-api.js     # Bybit API client
│   │   └── utils.js         # Utility functions
│   ├── package.json         # Node.js dependencies
│   └── .env.example         # Environment configuration template
├── frontend/
│   ├── app/                 # Next.js app directory
│   ├── components/          # React components
│   ├── types/              # TypeScript type definitions
│   └── package.json        # Node.js dependencies
├── start_backend.sh        # Backend startup script
├── start_frontend.sh       # Frontend startup script
└── README.md
```

## Components

### Frontend Components

- **Header**: Navigation and branding
- **CryptocurrencyTabs**: Switch between BTC, ETH, SOL
- **ExpirationTabs**: Select expiration dates
- **OptionsChain**: Main options chain table
- **TradingPanel**: Strategy suggestions and market analytics

### Backend API

- **Express Server**: RESTful API serving options data from Bybit
- **Real-time Data**: Live bid/ask/volume/Greeks data
- **Advanced Endpoints**: Market statistics, specific expiration data
- **Error Handling**: Robust error handling and logging
- **Utility Functions**: Greeks calculations, time to expiration, data sanitization

## Features in Detail

### Options Chain

- Side-by-side calls and puts display
- Real-time bid/ask spreads
- Volume and open interest
- Greeks (Delta, Gamma, Theta, Vega)
- ITM/OTM indicators
- Strike highlighting for ATM options

### Trading Panel

- **Strategies Tab**: Pre-built strategy recommendations
- **Positions Tab**: Portfolio management (coming soon)
- **Analytics Tab**: Market metrics and analysis

### Market Data

- Live spot prices with 24h change
- Implied volatility calculations
- Put/call ratios
- Max pain analysis

## Customization

The interface can be easily customized by:

1. **Colors**: Modify `tailwind.config.js` for custom color schemes
2. **Strategies**: Add new strategies in `TradingPanel.tsx`
3. **Data Sources**: Extend backend to support additional exchanges
4. **Components**: Create new React components in `/components`

## Development

### Adding New Features

1. **Backend**: Add new endpoints in `backend/server.js`
2. **API Client**: Extend functionality in `backend/lib/bybit-api.js`
3. **Frontend**: Create new components in `frontend/components/`
4. **Types**: Update TypeScript types in `frontend/types/`

### Environment Variables

Create `.env.local` in the frontend directory for configuration:

```
NEXT_PUBLIC_API_URL=http://localhost:8000
```

## Troubleshooting

### Common Issues

1. **Port conflicts**: Change ports in startup scripts if 3000/8000 are in use
2. **API errors**: Check that Bybit API is accessible
3. **Missing data**: Some options may not have complete Greeks data

### Logs

- Backend logs: Check terminal running Express server
- Frontend logs: Check browser console and terminal running Next.js

## License

This project is for educational purposes. Please respect Bybit's API terms of service.

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Submit a pull request

## Roadmap

- [ ] Real-time WebSocket data
- [ ] Strategy backtesting
- [ ] Portfolio tracking
- [ ] Mobile responsive design
- [ ] Additional cryptocurrencies
- [ ] Export functionality
- [ ] Paper trading simulation