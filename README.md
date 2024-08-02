# Solana Trading Bot

A high-performance, automated trading bot for Solana tokens using the Solana Tracker API.
Supports Raydium (V4/CPMM), Pumpfun, Moonshot, Orca and Jupiter.

Includes two examples, one using HTTP requests and one using the Data Streams (Websockets) from Solana Tracker.

[![Screenshot of the Trading Bot](https://i.gyazo.com/afb12f6c358385f133fa4b95dba3c095.png)]

## Features

- Automated buying and selling of Solana tokens
- Multi-token support
- Configurable trading parameters (liquidity, market cap, risk score)
- Real-time position monitoring and management
- Parallel execution of buying and selling operations
- Detailed logging with timestamps and color-coded actions
- Persistent storage of positions and transaction history

## Prerequisites

- Node.js (v14 or later recommended)
- npm (comes with Node.js)
- A Solana wallet with SOL
- API Key (Billing Token) from [Solana Tracker Data API](https://docs.solanatracker.io)

## Installation

1. Clone the repository:
   git clone https://github.com/YZYLAB/solana-trading-bot.git
   cd solana-trading-bot

2. Install dependencies:
   npm install

3. Rename the .env.example and configure the bot.

## Usage

Run the bot with:

node index.js

## Configuration

Adjust the settings in your `.env` file to customize the bot's behavior:

- AMOUNT: The amount of SOL to swap in each transaction
- DELAY: Delay between buying cycles (in milliseconds)
- MONITOR_INTERVAL: Interval for monitoring positions (in milliseconds)
- SLIPPAGE: Maximum allowed slippage (in percentage)
- PRIORITY_FEE: Priority fee for transactions
- JITO: Set to "true" to use Jito for transaction processing
- RPC_URL: Your Solana RPC URL
- BILLING_TOKEN: Your Solana Tracker API billing token
- PRIVATE_KEY: Your wallet's private key
- MIN_LIQUIDITY / MAX_LIQUIDITY: Liquidity range for token selection
- MIN_MARKET_CAP / MAX_MARKET_CAP: Market cap range for token selection
- MIN_RISK_SCORE / MAX_RISK_SCORE: Risk score range for token selection
- REQUIRE_SOCIAL_DATA: Set to "true" to only trade tokens with social data
- MAX_NEGATIVE_PNL / MAX_POSITIVE_PNL: PnL thresholds for selling positions
- MARKETS: Comma-separated list of markets to trade on

## API Usage and Fees

This bot uses the Solana Tracker API. Please refer to [Solana Tracker's documentation](https://docs.solanatracker.io) for information about API usage and associated fees.

## Disclaimer

This bot is for educational purposes only. Use at your own risk. Always understand the code you're running and the potential financial implications of automated trading.

The goal of this project is to show the potential ways of using the Solana Tracker API.

## License

[MIT License](LICENSE)

## Contributing

Contributions, issues, and feature requests are welcome! Feel free to check the [issues page](https://github.com/YZYLAB/solana-trading-bot/issues).

## Support

If you find this project helpful, please consider giving it a ⭐️ on GitHub!