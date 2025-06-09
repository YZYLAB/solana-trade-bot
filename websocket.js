require("dotenv").config();
const { SolanaTracker } = require("solana-swap");
const { Keypair, PublicKey, Connection } = require("@solana/web3.js");
const { Client, Datastream } = require("@solana-tracker/data-api");
const bs58 = require("bs58");
const winston = require("winston");
const chalk = require("chalk");
const fs = require("fs").promises;

// Utility functions
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const formatUSD = (value) => {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 6
  }).format(value);
};

const formatPercentage = (value) => {
  return `${value >= 0 ? '+' : ''}${value.toFixed(2)}%`;
};

// Logger configuration
const logger = winston.createLogger({
  level: "info",
  format: winston.format.combine(
    winston.format.timestamp({ format: "YYYY-MM-DD HH:mm:ss" }),
    winston.format.errors({ stack: true })
  ),
  transports: [
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.printf(
          (info) => {
            // Only show timestamp for error level
            if (info.level.includes('error')) {
              return `${info.timestamp} ${info.level}: ${info.message}`;
            }
            // For other levels, just show the message
            return info.message;
          }
        )
      )
    }),
    new winston.transports.File({ 
      filename: "trading-bot.log",
      format: winston.format.combine(
        winston.format.timestamp({ format: "YYYY-MM-DD HH:mm:ss" }),
        winston.format.printf(
          (info) => `${info.timestamp} ${info.level}: ${info.message}`
        )
      )
    }),
    new winston.transports.File({ 
      filename: "trading-bot-error.log", 
      level: "error",
      format: winston.format.combine(
        winston.format.timestamp({ format: "YYYY-MM-DD HH:mm:ss" }),
        winston.format.printf(
          (info) => `${info.timestamp} ${info.level}: ${info.message}`
        )
      )
    }),
  ],
});

class TradingBot {
  constructor() {
    // Load and validate configuration
    this.config = this.loadConfig();
    this.validateConfig();
    
    // Core properties
    this.privateKey = process.env.PRIVATE_KEY;
    this.SOL_ADDRESS = "So11111111111111111111111111111111111111112";
    
    // State management
    this.positions = new Map();
    this.soldPositions = [];
    this.seenTokens = new Set();
    this.buyingTokens = new Set();
    this.sellingPositions = new Set();
    
    // File paths
    this.positionsFile = "positions.json";
    this.soldPositionsFile = "sold_positions.json";
    
    // API clients
    this.connection = new Connection(this.config.rpcUrl, {
      commitment: 'confirmed',
      confirmTransactionInitialTimeout: 60000
    });
    
    this.dataClient = new Client({
      apiKey: process.env.SOLANA_TRACKER_API_KEY
    });
    
    // Initialize Datastream for real-time data
    this.dataStream = new Datastream({
      wsUrl: process.env.WS_URL,
      autoReconnect: true,
      reconnectDelay: 2500,
      reconnectDelayMax: 10000
    });
    
    // Subscriptions storage
    this.subscriptions = {
      latest: null,
      positions: new Map() // tokenAddress -> subscription
    };
    
    // Performance tracking
    this.stats = {
      totalBuys: 0,
      totalSells: 0,
      successfulBuys: 0,
      successfulSells: 0,
      totalPnL: 0,
      tokensAnalyzed: 0,
      startTime: Date.now()
    };
  }

  loadConfig() {
    return {
      // Trading parameters
      amount: parseFloat(process.env.AMOUNT) || 0.01,
      monitorInterval: parseInt(process.env.MONITOR_INTERVAL) || 30000,
      slippage: parseInt(process.env.SLIPPAGE) || 15,
      priorityFee: parseFloat(process.env.PRIORITY_FEE) || 0.00001,
      useJito: process.env.JITO === "true",
      rpcUrl: process.env.RPC_URL || "https://api.mainnet-beta.solana.com",
      
      // Filter parameters
      minLiquidity: parseFloat(process.env.MIN_LIQUIDITY) || 1000,
      maxLiquidity: parseFloat(process.env.MAX_LIQUIDITY) || 100000,
      minMarketCap: parseFloat(process.env.MIN_MARKET_CAP) || 10000,
      maxMarketCap: parseFloat(process.env.MAX_MARKET_CAP) || 1000000,
      minRiskScore: parseInt(process.env.MIN_RISK_SCORE) || 0,
      maxRiskScore: parseInt(process.env.MAX_RISK_SCORE) || 7,
      requireSocialData: process.env.REQUIRE_SOCIAL_DATA === "true",
      
      // PnL parameters
      maxNegativePnL: parseFloat(process.env.MAX_NEGATIVE_PNL) || -50,
      maxPositivePnL: parseFloat(process.env.MAX_POSITIVE_PNL) || 100,
      
      // Markets
      markets: process.env.MARKETS?.split(",").map((m) => m.trim()) || 
        ['raydium', 'orca', 'pumpfun', 'moonshot', 'raydium-cpmm'],
      
      // Advanced settings
      maxPositions: parseInt(process.env.MAX_POSITIONS) || 10,
      minHolders: parseInt(process.env.MIN_HOLDERS) || 0,
      maxRetries: parseInt(process.env.MAX_RETRIES) || 3,
      debug: process.env.DEBUG === "true" || false,
      
      // Datastream specific
      subscribeToPriceUpdates: process.env.SUBSCRIBE_PRICE_UPDATES !== "false",
      subscribeToTransactions: process.env.SUBSCRIBE_TRANSACTIONS === "true",
    };
  }

  validateConfig() {
    const required = ['PRIVATE_KEY', 'SOLANA_TRACKER_API_KEY', 'WS_URL'];
    const missing = required.filter(key => !process.env[key]);
    
    if (missing.length > 0) {
      throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
    }
    
    if (this.config.amount <= 0) {
      throw new Error('AMOUNT must be greater than 0');
    }
    
    if (this.config.maxNegativePnL > 0) {
      throw new Error('MAX_NEGATIVE_PNL must be negative or zero');
    }
    
    if (this.config.maxPositivePnL < 0) {
      throw new Error('MAX_POSITIVE_PNL must be positive or zero');
    }
  }

  async initialize() {
    try {
      logger.info("🚀 Initializing Trading Bot with Datastream...");
      
      // Initialize keypair
      this.keypair = Keypair.fromSecretKey(
        bs58.decode ? bs58.decode(this.privateKey) : bs58.default.decode(this.privateKey)
      );
      logger.info(`📱 Wallet: ${this.keypair.publicKey.toBase58()}`);
      
      // Initialize Solana swap tracker
      this.solanaTracker = new SolanaTracker(this.keypair, this.config.rpcUrl);
      
      // Load saved positions
      await this.loadPositions();
      await this.loadSoldPositions();
      
      // Display configuration
      this.displayConfig();
      
      // Check wallet balance
      await this.checkWalletBalance();
      
      // Connect to WebSocket
      await this.connectDatastream();
      
      logger.info("✅ Bot initialized successfully");
    } catch (error) {
      logger.error(`❌ Failed to initialize bot: ${error.message}`);
      throw error;
    }
  }

  async connectDatastream() {
    logger.info("📡 Connecting to Datastream WebSocket...");
    
    // Set up event handlers
    this.dataStream.on('connected', () => {
      logger.info("✅ Connected to Datastream");
      this.setupSubscriptions();
    });
    
    this.dataStream.on('disconnected', () => {
      logger.warn("⚠️  Disconnected from Datastream");
    });
    
    this.dataStream.on('reconnecting', (attempt) => {
      logger.info(`🔄 Reconnecting to Datastream (attempt ${attempt})...`);
    });
    
    this.dataStream.on('error', (error) => {
      logger.error(`❌ Datastream error: ${error.message}`);
    });
    
    // Connect to the WebSocket
    await this.dataStream.connect();
  }

  setupSubscriptions() {
    // Subscribe to latest tokens
    this.subscriptions.latest = this.dataStream.subscribe.latest().on((tokenData) => {
      this.handleNewToken(tokenData);
    });
    
    logger.info("📍 Subscribed to latest tokens feed");
    
    // If we have existing positions, subscribe to their price updates
    for (const [tokenMint, position] of this.positions) {
      this.subscribeToTokenUpdates(tokenMint);
    }
  }

  subscribeToTokenUpdates(tokenAddress) {
    // Subscribe to price updates for the token
    const priceSubscription = this.dataStream.subscribe.price.token(tokenAddress).on((priceData) => {
      this.handlePriceUpdate(tokenAddress, priceData);
    });
    
    // Store subscription reference
    this.subscriptions.positions.set(tokenAddress, {
      price: priceSubscription
    });
    
    logger.debug(`📊 Subscribed to price updates for ${tokenAddress}`);
  }

  unsubscribeFromToken(tokenAddress) {
    const subs = this.subscriptions.positions.get(tokenAddress);
    if (subs) {
      if (subs.price) subs.price.unsubscribe();
      this.subscriptions.positions.delete(tokenAddress);
      logger.debug(`📴 Unsubscribed from ${tokenAddress}`);
    }
  }

  async handleNewToken(tokenData) {
    this.stats.tokensAnalyzed++;
    
    // Check if token passes filters
    if (this.filterToken(tokenData)) {
      logger.info(`\n✨ New token found: ${tokenData.token.symbol}`);
      logger.info(`   Name: ${tokenData.token.name}`);
      logger.info(`   Market Cap: ${formatUSD(tokenData.pools[0].marketCap.usd)}`);
      logger.info(`   Liquidity: ${formatUSD(tokenData.pools[0].liquidity.usd)}`);
      logger.info(`   Risk Score: ${tokenData.risk.score}`);
      
      // Attempt to buy
      if (!this.positions.has(tokenData.token?.mint) && 
          !this.buyingTokens.has(tokenData.token?.mint) &&
          this.positions.size < this.config.maxPositions) {
        
        this.buyingTokens.add(tokenData.token.mint);
        await this.performSwap(tokenData, true);
      }
    }
  }

  async handlePriceUpdate(tokenAddress, priceData) {
    const position = this.positions.get(tokenAddress);
    if (!position || this.sellingPositions.has(tokenAddress)) return;
    
    const currentPrice = priceData.price;
    const pnlPercentage = ((currentPrice - position.entryPrice) / position.entryPrice) * 100;
    
    // Log real-time PnL
    if (this.config.debug) {
      const emoji = pnlPercentage >= 0 ? "📈" : "📉";
      logger.debug(`${emoji} ${position.symbol}: ${formatPercentage(pnlPercentage)} @ ${formatUSD(currentPrice)}`);
    }
    
    // Check exit conditions
    if (pnlPercentage <= this.config.maxNegativePnL || pnlPercentage >= this.config.maxPositivePnL) {
      logger.info(`\n🎯 Exit trigger for ${position.symbol} at ${formatPercentage(pnlPercentage)}`);
      
      // Fetch full token data for selling
      try {
        const tokenData = await this.dataClient.getTokenInfo(tokenAddress);
        if (tokenData) {
          this.sellingPositions.add(tokenAddress);
          await this.performSwap(tokenData, false);
        }
      } catch (error) {
        logger.error(`Failed to fetch token data for sell: ${error.message}`);
        this.sellingPositions.delete(tokenAddress);
      }
    }
  }

  filterToken(tokenData) {
    try {
      // Basic validation
      if (!tokenData.pools || tokenData.pools.length === 0) return false;
      
      const pool = tokenData.pools[0];
      if (!pool) return false;
      
      // Extract metrics
      const liquidity = pool.liquidity?.usd || 0;
      const marketCap = pool.marketCap?.usd || 0;
      const riskScore = tokenData.risk?.score || 10;
      const holders = tokenData.holders || 0;
      
      // Check social requirements
      const hasSocialData = !!(
        tokenData?.token?.twitter ||
        tokenData?.token?.telegram ||
        tokenData?.token?.website
      );
      
      // Market validation
      const isInAllowedMarket = this.config.markets.includes(pool.market);
      
      // Token validation
      const isAlreadySeen = this.seenTokens.has(tokenData.token.mint);
      const isBeingBought = this.buyingTokens.has(tokenData.token.mint);
      const hasPosition = this.positions.has(tokenData.token.mint);
      
      // Apply all filters
      const passesFilters = 
        liquidity >= this.config.minLiquidity &&
        liquidity <= this.config.maxLiquidity &&
        marketCap >= this.config.minMarketCap &&
        marketCap <= this.config.maxMarketCap &&
        riskScore >= this.config.minRiskScore &&
        riskScore <= this.config.maxRiskScore &&
        holders >= this.config.minHolders &&
        (!this.config.requireSocialData || hasSocialData) &&
        isInAllowedMarket &&
        !isAlreadySeen &&
        !isBeingBought &&
        !hasPosition;

      
      if (!passesFilters && this.config.debug) {
        logger.debug(`❌ Token ${tokenData.token.symbol} filtered out`);
      }
      
      return passesFilters;
    } catch (error) {
      logger.error(`Error filtering token: ${error.message}`);
      return false;
    }
  }

  displayConfig() {
    logger.info("📋 Configuration:");
    logger.info(`  - Trade Amount: ${this.config.amount} SOL`);
    logger.info(`  - Markets: ${this.config.markets.join(', ')}`);
    logger.info(`  - Liquidity Range: ${formatUSD(this.config.minLiquidity)} - ${formatUSD(this.config.maxLiquidity)}`);
    logger.info(`  - Market Cap Range: ${formatUSD(this.config.minMarketCap)} - ${formatUSD(this.config.maxMarketCap)}`);
    logger.info(`  - Risk Score Range: ${this.config.minRiskScore} - ${this.config.maxRiskScore}`);
    logger.info(`  - Stop Loss: ${this.config.maxNegativePnL}%`);
    logger.info(`  - Take Profit: ${this.config.maxPositivePnL}%`);
    logger.info(`  - Max Positions: ${this.config.maxPositions}`);
    logger.info(`  - Real-time Mode: Enabled (WebSocket)`);
  }

  async checkWalletBalance() {
    try {
      const balance = await this.connection.getBalance(this.keypair.publicKey);
      const solBalance = balance / 1e9;
      logger.info(`💰 Wallet Balance: ${solBalance.toFixed(4)} SOL`);
      
      if (solBalance < this.config.amount) {
        logger.warn(`⚠️  Insufficient balance for trading. Need at least ${this.config.amount} SOL`);
      }
    } catch (error) {
      logger.error(`Failed to check wallet balance: ${error.message}`);
    }
  }

  async getWalletTokenBalance(wallet, mint, retries = 3) {
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const tokenAccounts = await this.connection.getParsedTokenAccountsByOwner(
          new PublicKey(wallet),
          { mint: new PublicKey(mint) }
        );

        if (tokenAccounts.value && tokenAccounts.value.length > 0) {
          const balance = tokenAccounts.value[0].account.data.parsed.info.tokenAmount.uiAmount;
          if (balance && balance > 0) {
            return balance;
          }
        }

        if (attempt < retries) {
          await sleep(2000 * (attempt + 1));
        }
      } catch (error) {
        logger.error(`Attempt ${attempt + 1} failed to get wallet balance: ${error.message}`);
        if (attempt < retries) {
          await sleep(2000 * (attempt + 1));
        }
      }
    }
    
    return null;
  }

  async performSwap(token, isBuy) {
    const operation = isBuy ? "BUY" : "SELL";
    const startTime = Date.now();
    
    logger.info(`\n🔄 [${operation}] Starting swap for ${token.token.symbol}`);
    logger.info(`   Address: ${token.token.mint}`);
    logger.info(`   Price: ${formatUSD(token.pools[0].price.usd)}`);
    
    const { amount, slippage, priorityFee } = this.config;
    const [fromToken, toToken] = isBuy
      ? [this.SOL_ADDRESS, token.token.mint]
      : [token.token.mint, this.SOL_ADDRESS];

    try {
      // Determine swap amount
      let swapAmount;
      if (isBuy) {
        swapAmount = amount;
        this.stats.totalBuys++;
      } else {
        const position = this.positions.get(token.token.mint);
        if (!position) {
          logger.error(`No position found for ${token.token.symbol}`);
          return false;
        }
        swapAmount = position.amount;
        this.stats.totalSells++;
      }

      // Get swap instructions
      const swapResponse = await this.solanaTracker.getSwapInstructions(
        fromToken,
        toToken,
        swapAmount,
        slippage,
        this.keypair.publicKey.toBase58(),
        priorityFee
      );

      // Execute swap
      const swapOptions = this.buildSwapOptions();
      const txid = await this.solanaTracker.performSwap(swapResponse, swapOptions);
      
      const executionTime = ((Date.now() - startTime) / 1000).toFixed(2);
      logger.info(`✅ [${operation}] Transaction sent: ${txid}`);
      logger.info(`   Execution time: ${executionTime}s`);

      // Handle post-swap logic
      if (isBuy) {
        await this.handleSuccessfulBuy(token, txid);
      } else {
        await this.handleSuccessfulSell(token, txid);
      }

      return txid;
    } catch (error) {
      logger.error(`❌ [${operation}] Swap failed: ${error.message}`);
      
      if (isBuy) {
        this.buyingTokens.delete(token.token.mint);
      } else {
        this.sellingPositions.delete(token.token.mint);
      }
      
      return false;
    }
  }

  async handleSuccessfulBuy(token, txid) {
    // Wait for confirmation
    await sleep(5000);
    const tokenAmount = await this.getWalletTokenBalance(
      this.keypair.publicKey.toBase58(),
      token.token.mint
    );
    
    if (!tokenAmount) {
      logger.error(`Failed to confirm token balance for ${token.token.symbol}`);
      this.buyingTokens.delete(token.token.mint);
      return;
    }

    // Record position
    const position = {
      txid,
      symbol: token.token.symbol,
      name: token.token.name,
      entryPrice: token.pools[0].price.usd,
      amount: tokenAmount,
      investment: this.config.amount,
      openTime: Date.now(),
      market: token.pools[0].market,
      riskScore: token.risk.score
    };
    
    this.positions.set(token.token.mint, position);
    this.seenTokens.add(token.token.mint);
    this.buyingTokens.delete(token.token.mint);
    this.stats.successfulBuys++;
    
    // Subscribe to real-time updates for this token
    this.subscribeToTokenUpdates(token.token.mint);
    
    logger.info(`📈 Position opened for ${token.token.symbol}`);
    logger.info(`   Amount: ${tokenAmount.toFixed(2)} tokens`);
    logger.info(`   Entry: ${formatUSD(position.entryPrice)}`);
    logger.info(`   Value: ${formatUSD(tokenAmount * position.entryPrice)}`);
    
    await this.savePositions();
  }

  async handleSuccessfulSell(token, txid) {
    const position = this.positions.get(token.token.mint);
    if (!position) return;

    const exitPrice = token.pools[0].price.usd;
    const holdTime = Date.now() - position.openTime;
    const pnl = (exitPrice - position.entryPrice) * position.amount;
    const pnlPercentage = ((exitPrice - position.entryPrice) / position.entryPrice) * 100;

    const soldPosition = {
      ...position,
      exitPrice,
      pnl,
      pnlPercentage,
      closeTime: Date.now(),
      closeTxid: txid,
      holdTime: Math.floor(holdTime / 1000 / 60) // minutes
    };

    this.soldPositions.push(soldPosition);
    this.stats.totalPnL += pnl;
    this.stats.successfulSells++;

    const profitEmoji = pnl >= 0 ? "🟢" : "🔴";
    logger.info(`${profitEmoji} Position closed for ${token.token.symbol}`);
    logger.info(`   Exit: ${formatUSD(exitPrice)}`);
    logger.info(`   PnL: ${formatUSD(pnl)} (${formatPercentage(pnlPercentage)})`);
    logger.info(`   Hold time: ${soldPosition.holdTime} minutes`);
    
    // Unsubscribe from real-time updates
    this.unsubscribeFromToken(token.token.mint);
    
    this.positions.delete(token.token.mint);
    this.sellingPositions.delete(token.token.mint);

    await this.savePositions();
    await this.saveSoldPositions();
  }

  buildSwapOptions() {
    return {
      sendOptions: { skipPreflight: true },
      confirmationRetries: 30,
      confirmationRetryTimeout: 1000,
      lastValidBlockHeightBuffer: 150,
      resendInterval: 1000,
      confirmationCheckInterval: 1000,
      commitment: "processed",
      jito: this.config.useJito ? { enabled: true, tip: 0.0001 } : undefined,
    };
  }

  async statusMonitor() {
    logger.info("📊 Starting status monitor...");
    
    while (true) {
      try {
        this.displayStats();
        
        // Check wallet balance periodically
        if (this.positions.size < this.config.maxPositions) {
          await this.checkWalletBalance();
        }
        
      } catch (error) {
        logger.error(`Error in status monitor: ${error.message}`);
      }
      
      await sleep(this.config.monitorInterval);
    }
  }

  displayStats() {
    const runtime = Math.floor((Date.now() - this.stats.startTime) / 1000 / 60);
    const winRate = this.stats.successfulSells > 0 
      ? (this.soldPositions.filter(p => p.pnl > 0).length / this.stats.successfulSells * 100).toFixed(1)
      : 0;
    
    logger.info(`\n📊 Bot Statistics (${runtime} minutes runtime):`);
    logger.info(`   Total PnL: ${formatUSD(this.stats.totalPnL)}`);
    logger.info(`   Tokens Analyzed: ${this.stats.tokensAnalyzed}`);
    logger.info(`   Buys: ${this.stats.successfulBuys}/${this.stats.totalBuys}`);
    logger.info(`   Sells: ${this.stats.successfulSells}/${this.stats.totalSells}`);
    logger.info(`   Win Rate: ${winRate}%`);
    logger.info(`   Active Positions: ${this.positions.size}/${this.config.maxPositions}`);
    
    // Show active positions
    if (this.positions.size > 0) {
      logger.info(`   Watching:`);
      for (const [mint, position] of this.positions) {
        logger.info(`     - ${position.symbol}`);
      }
    }
  }

  async loadPositions() {
    try {
      const data = await fs.readFile(this.positionsFile, "utf8");
      const loadedPositions = JSON.parse(data);
      this.positions = new Map(Object.entries(loadedPositions));
      this.seenTokens = new Set(this.positions.keys());
      logger.info(`📂 Loaded ${this.positions.size} active positions`);
    } catch (error) {
      if (error.code !== "ENOENT") {
        logger.error(`Error loading positions: ${error.message}`);
      }
    }
  }

  async savePositions() {
    try {
      const positionsObject = Object.fromEntries(this.positions);
      await fs.writeFile(
        this.positionsFile,
        JSON.stringify(positionsObject, null, 2)
      );
    } catch (error) {
      logger.error(`Error saving positions: ${error.message}`);
    }
  }

  async loadSoldPositions() {
    try {
      const data = await fs.readFile(this.soldPositionsFile, "utf8");
      this.soldPositions = JSON.parse(data);
      
      // Calculate total PnL from history
      this.stats.totalPnL = this.soldPositions.reduce((sum, pos) => sum + (pos.pnl || 0), 0);
      logger.info(`📂 Loaded ${this.soldPositions.length} trade history`);
    } catch (error) {
      if (error.code !== "ENOENT") {
        logger.error(`Error loading sold positions: ${error.message}`);
      }
    }
  }

  async saveSoldPositions() {
    try {
      await fs.writeFile(
        this.soldPositionsFile,
        JSON.stringify(this.soldPositions, null, 2)
      );
    } catch (error) {
      logger.error(`Error saving sold positions: ${error.message}`);
    }
  }

  async start() {
    try {
      logger.info(chalk.cyan("\n═══════════════════════════════════════"));
      logger.info(chalk.cyan("🤖 Solana Trading Bot v3.0 (Real-time)"));
      logger.info(chalk.cyan("═══════════════════════════════════════\n"));
      
      await this.initialize();
      
      logger.info("\n🎯 Starting real-time monitoring...\n");

      // Start status monitor (the WebSocket handles token discovery)
      await this.statusMonitor();
      
    } catch (error) {
      logger.error(`💥 Critical error: ${error.message}`);
      process.exit(1);
    }
  }

  // Graceful shutdown
  async shutdown() {
    logger.info("\n🛑 Shutting down bot...");
    
    // Disconnect from WebSocket
    this.dataStream.disconnect();
    
    // Save current state
    await this.savePositions();
    await this.saveSoldPositions();
    
    // Display final stats
    this.displayStats();
    
    logger.info("👋 Bot stopped");
    process.exit(0);
  }
}

// Handle shutdown signals
process.on('SIGINT', async () => {
  if (bot) await bot.shutdown();
});

process.on('SIGTERM', async () => {
  if (bot) await bot.shutdown();
});

// Unhandled rejection handler
process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

// Start the bot
const bot = new TradingBot();
bot.start().catch((error) => {
  logger.error("Fatal error:", error);
  process.exit(1);
});