# Solana Trading Bot (PoC)

A PoC of an automated trading bot for Solana tokens using the official [Solana Tracker Data API SDK](https://github.com/solanatracker/data-api-sdk) and Swap API. 

It supports Raydium V4, Raydium CPMM, Raydium CLMM, Raydium Launchpad, Meteora Curve, Meteora Dynamic (v1 and v2), Meteora DLMM, Pumpfun, Pumpfun AMM, Moonshot, Orca, Boop and Jupiter.

Includes two powerful trading modes:
- **HTTP Mode**: Traditional polling-based approach using the Data API
- **WebSocket Mode**: Real-time trading using Solana Tracker's Datastream for instant token discovery and price monitoring

![Screenshot of the Trading Bot](https://i.gyazo.com/afb12f6c358385f133fa4b95dba3c095.png)

## 🚀 Features

- **Real-time Trading**: Instant token discovery and price monitoring via WebSocket
- **Automated Trading**: Hands-free buying and selling based on configurable criteria
- **Multi-DEX Support**: Trade on Raydium, Orca, Pumpfun, Moonshot, and more
- **Advanced Filtering**: Filter tokens by liquidity, market cap, risk score, and social presence
- **Position Management**: Real-time PnL tracking with automatic stop-loss and take-profit
- **Parallel Execution**: Handle multiple trades simultaneously
- **Comprehensive Logging**: Color-coded console output with detailed trade information
- **Persistent Storage**: Maintains position history across restarts
- **Rate Limit Handling**: Built-in rate limit management and retry logic

## 📋 Prerequisites

- Node.js (v14 or later) or Bun JS (Preferred)
- npm or yarn
- A Solana wallet with SOL
- Solana Tracker API Key from [solanatracker.io](https://www.solanatracker.io/data-api)
- WebSocket URL (for real-time mode) - Available with Premium plans or higher

## 📦 Installation

1. Clone the repository:
```bash
git clone https://github.com/YZYLAB/solana-trade-bot.git
cd solana-trade-bot
```

2. Install dependencies:
```bash
npm install
```

Or using the official SDK directly:
```bash
npm install @solana-tracker/data-api
```

3. Configure your environment:
```bash
cp .env.example .env
# Edit .env with your configuration
```

## 🎮 Usage

### HTTP Mode (Traditional Polling)
```bash
node index.js
```

### WebSocket Mode (Real-time) - Recommended
```bash
node websocket.js
```

## ⚙️ Configuration

Configure the bot by editing your `.env` file:

### Required Settings
```env
# API Credentials
SOLANA_TRACKER_API_KEY=your_api_key_here
SOLANA_TRACKER_WS_URL=your_websocket_url_here  # For WebSocket mode

# Wallet
PRIVATE_KEY=your_wallet_private_key
```

### Trading Parameters
```env
# Trading Settings
AMOUNT=0.01                    # Amount of SOL per trade
SLIPPAGE=15                   # Maximum slippage percentage
PRIORITY_FEE=0.00001          # Priority fee in SOL
JITO=false                    # Enable Jito bundles

# Position Management
MAX_POSITIONS=10              # Maximum concurrent positions
MAX_NEGATIVE_PNL=-50         # Stop loss percentage
MAX_POSITIVE_PNL=100         # Take profit percentage
```

### Filter Settings
```env
# Token Filters
MIN_LIQUIDITY=1000           # Minimum liquidity in USD
MAX_LIQUIDITY=100000         # Maximum liquidity in USD
MIN_MARKET_CAP=10000         # Minimum market cap in USD
MAX_MARKET_CAP=1000000       # Maximum market cap in USD
MIN_RISK_SCORE=0             # Minimum risk score (0-10)
MAX_RISK_SCORE=7             # Maximum risk score (0-10)
MIN_HOLDERS=10               # Minimum number of holders
REQUIRE_SOCIAL_DATA=false    # Require social media presence

# Markets to trade on (comma-separated)
MARKETS=raydium,orca,pumpfun,moonshot,raydium-cpmm
```

### Advanced Settings
```env
# Monitoring Intervals
DELAY=5000                   # Delay between scans (HTTP mode)
MONITOR_INTERVAL=30000       # Position monitoring interval

# Debugging
DEBUG=true                   # Enable detailed logging

# RPC Configuration
RPC_URL=https://rpc-mainnet.solanatracker.io/?api_key=xxxx
```

## 📊 API Integration

This bot uses the official [@solana-tracker/data-api](https://www.npmjs.com/package/@solana-tracker/data-api) SDK, providing:

- Type-safe API calls with full TypeScript support
- Built-in error handling and rate limit management
- Automatic retries with exponential backoff
- WebSocket support for real-time data streaming
- Comprehensive token and wallet data access

### SDK Features Used

- **Real-time Datastream**: WebSocket connections for instant updates
- **Token Discovery**: Latest tokens, trending tokens, and custom searches
- **Price Monitoring**: Real-time price feeds and historical data
- **Risk Analysis**: Built-in risk scoring and holder analytics
- **Multi-token Support**: Batch operations for efficiency

## 💡 Trading Modes Comparison

| Feature | HTTP Mode | WebSocket Mode |
|---------|-----------|----------------|
| Token Discovery | 1-second polling | Real-time (instant) |
| Price Updates | On-demand | Live streaming |
| API Usage | Higher | Minimal |
| Response Time | Seconds | Milliseconds |
| Best For | Testing/Low-volume | Production trading |

## 🔒 Security Considerations

- Never share your private key or API credentials
- Use a dedicated trading wallet with limited funds
- Test with small amounts first
- Monitor the bot regularly
- Keep your dependencies updated

## 📈 Performance Tips

1. **Use WebSocket mode** for production trading
2. **Adjust filters** based on market conditions
3. **Monitor API usage** to stay within limits
4. **Enable debug mode** to understand filtering decisions
5. **Use multiple RPC endpoints** for redundancy

## 🛠️ Troubleshooting

### Common Issues

**"No tokens found"**
- Filters may be too restrictive
- Enable `DEBUG=true` to see why tokens are filtered

**"Rate limit exceeded"**
- Upgrade your Solana Tracker plan
- Increase delay between requests

**"Transaction failed"**
- Check wallet balance
- Increase slippage
- Try different RPC endpoint

## 📚 Resources

- [Solana Tracker Documentation](https://docs.solanatracker.io)
- [Data API SDK GitHub](https://github.com/solanatracker/data-api-sdk)
- [API Plans & Pricing](https://www.solanatracker.io/data-api)
- [Support Discord](https://discord.gg/y38ZdJmBdT)

## ⚠️ Disclaimer

This bot is for educational purposes only. Cryptocurrency trading carries significant risk. Always:
- Understand the code before running it
- Start with small amounts
- Never invest more than you can afford to lose
- Do your own research

## 📄 License

[MIT License](LICENSE)

## 🤝 Contributing

Contributions are welcome! Please:
1. Fork the repository
2. Create a feature branch
3. Commit your changes
4. Push to the branch
5. Open a Pull Request

## ⭐ Support

If you find this project helpful:
- Give it a star on GitHub
- Share it with others
- Report issues and suggest features
- Consider supporting the developers

## 🔄 Recent Updates

- **v2.0**: Migrated to official Solana Tracker Data API SDK 
- **v1.0**: Initial release with HTTP polling and Datastream

---

Built using the [Solana Tracker Data API](https://www.solanatracker.io/data-api)