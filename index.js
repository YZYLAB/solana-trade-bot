require("dotenv").config();
const { SolanaTracker } = require("solana-swap");
const { Keypair, PublicKey, Connection } = require("@solana/web3.js");
const { Client, RateLimitError } = require("@solana-tracker/data-api");
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
    
    // Performance tracking
    this.stats = {
      totalBuys: 0,
      totalSells: 0,
      successfulBuys: 0,
      successfulSells: 0,
      totalPnL: 0,
      startTime: Date.now()
    };
  }

  loadConfig() {
    return {
      // Trading parameters
      amount: parseFloat(process.env.AMOUNT) || 0.01,
      delay: parseInt(process.env.DELAY) || 5000,
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
      minHolders: parseInt(process.env.MIN_HOLDERS) || 10,
      maxRetries: parseInt(process.env.MAX_RETRIES) || 3,
      debug: process.env.DEBUG === "true" || false,
    };
  }

  validateConfig() {
    const required = ['PRIVATE_KEY', 'SOLANA_TRACKER_API_KEY'];
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
      logger.info("🚀 Initializing Trading Bot...");
      
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
      
      logger.info("✅ Bot initialized successfully");
    } catch (error) {
      logger.error(`❌ Failed to initialize bot: ${error.message}`);
      throw error;
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

  async fetchTokens() {
    try {
      const tokens = await this.dataClient.getLatestTokens(1);
      return tokens;
    } catch (error) {
      if (error instanceof RateLimitError) {
        logger.warn(`Rate limit hit. Waiting ${error.retryAfter || 60} seconds...`);
        await sleep((error.retryAfter || 60) * 1000);
        return [];
      }
      logger.error(`Error fetching tokens: ${error.message}`);
      return [];
    }
  }

  async fetchTokenData(tokenId) {
    try {
      const tokenData = await this.dataClient.getTokenInfo(tokenId);
      return tokenData;
    } catch (error) {
      if (error instanceof RateLimitError) {
        logger.warn(`Rate limit hit for token ${tokenId}`);
      } else {
        logger.error(`Error fetching token data for ${tokenId}: ${error.message}`);
      }
      return null;
    }
  }

  filterTokens(tokens) {
    // Check if we've reached max positions
    if (this.positions.size >= this.config.maxPositions) {
      return [];
    }

    return tokens.filter((token) => {
      try {
        // Basic validation
        if (!token.pools || token.pools.length === 0) return false;
        
        const pool = token.pools[0];
        if (!pool) return false;
        
        // Extract metrics
        const liquidity = pool.liquidity?.usd || 0;
        const marketCap = pool.marketCap?.usd || 0;
        const riskScore = token.risk?.score || 10;
        const holders = token.holders || 0;
        
        // Check social requirements
        const hasSocialData = !!(
          token.token?.twitter ||
          token.token?.telegram ||
          token.token?.website
        );
        
        // Market validation
        const isInAllowedMarket = this.config.markets.includes(pool.market);
        
        // Token validation
        const isAlreadySeen = this.seenTokens.has(token.token.mint);
        const isBeingBought = this.buyingTokens.has(token.token.mint);
        const hasPosition = this.positions.has(token.token.mint);
        
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
        
        if (passesFilters && this.config.debug) {
          logger.debug(`✅ Token ${token.token.symbol} passed filters:
            Liquidity: ${formatUSD(liquidity)}
            Market Cap: ${formatUSD(marketCap)}
            Risk Score: ${riskScore}
            Holders: ${holders}`);
        } else if (!passesFilters && this.config.debug) {
          logger.debug(`❌ Token ${token.token.symbol} failed filters:
            Liquidity: ${formatUSD(liquidity)} (need ${formatUSD(this.config.minLiquidity)}-${formatUSD(this.config.maxLiquidity)})
            Market Cap: ${formatUSD(marketCap)} (need ${formatUSD(this.config.minMarketCap)}-${formatUSD(this.config.maxMarketCap)})
            Risk Score: ${riskScore} (need ${this.config.minRiskScore}-${this.config.maxRiskScore})
            Holders: ${holders} (need >= ${this.config.minHolders})
            Market: ${pool.market} (allowed: ${this.config.markets.join(', ')})`);
        }
        
        return passesFilters;
      } catch (error) {
        logger.error(`Error filtering token ${token.token.mint}: ${error.message}`);
        return false;
      }
    });
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
          await sleep(2000 * (attempt + 1)); // Exponential backoff
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
    // Wait for confirmation and get balance
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
    
    this.positions.delete(token.token.mint);
    this.sellingPositions.delete(token.token.mint);

    await this.savePositions();
    await this.saveSoldPositions();
  }

  async checkAndSellPosition(tokenMint) {
    if (this.sellingPositions.has(tokenMint)) {
      return;
    }

    const position = this.positions.get(tokenMint);
    if (!position) return;

    try {
      const tokenData = await this.fetchTokenData(tokenMint);
      if (!tokenData || !tokenData.pools || tokenData.pools.length === 0) {
        logger.warn(`No data available for ${position.symbol}, checking balance...`);
        
        // Check if we still hold tokens
        const balance = await this.getWalletTokenBalance(
          this.keypair.publicKey.toBase58(),
          tokenMint
        );
        
        if (!balance || balance === 0) {
          logger.warn(`No balance found for ${position.symbol}, removing position`);
          this.positions.delete(tokenMint);
          await this.savePositions();
        }
        return;
      }

      const currentPrice = tokenData.pools[0].price.usd;
      const pnlPercentage = ((currentPrice - position.entryPrice) / position.entryPrice) * 100;
      const currentValue = position.amount * currentPrice;
      const pnl = currentValue - (position.investment || this.config.amount);

      // Log position status
      const statusEmoji = pnlPercentage >= 0 ? "📈" : "📉";
      logger.debug(`${statusEmoji} ${position.symbol}: ${formatPercentage(pnlPercentage)} | Value: ${formatUSD(currentValue)}`);

      // Check exit conditions
      const shouldSell = pnlPercentage <= this.config.maxNegativePnL || 
                        pnlPercentage >= this.config.maxPositivePnL;

      if (shouldSell) {
        logger.info(`\n🎯 Exit trigger for ${position.symbol} at ${formatPercentage(pnlPercentage)}`);
        
        // Verify balance before selling
        const currentBalance = await this.getWalletTokenBalance(
          this.keypair.publicKey.toBase58(),
          tokenMint
        );
        
        if (currentBalance && currentBalance > 0) {
          this.sellingPositions.add(tokenMint);
          await this.performSwap(tokenData, false);
        } else {
          logger.warn(`No balance to sell for ${position.symbol}`);
          this.positions.delete(tokenMint);
          await this.savePositions();
        }
      }
    } catch (error) {
      logger.error(`Error checking position ${tokenMint}: ${error.message}`);
    }
  }

  async buyMonitor() {
    logger.info("👀 Starting buy monitor...");
    let scanCount = 0;
    let lastStatusUpdate = Date.now();
    
    while (true) {
      try {
        scanCount++;
        
        // Show status every 30 seconds
        if (Date.now() - lastStatusUpdate > 10000) {
          logger.info(`🔍 Scanning for tokens... (${scanCount} scans completed)`);
          lastStatusUpdate = Date.now();
        }
        
        if (this.positions.size >= this.config.maxPositions) {
          logger.debug(`Max positions reached (${this.positions.size}/${this.config.maxPositions})`);
          await sleep(this.config.delay);
          continue;
        }

        const tokens = await this.fetchTokens();
        
        if (tokens.length === 0) {
          logger.debug(`No tokens received from API`);
        } else {
          logger.debug(`Received ${tokens.length} tokens from API`);
        }

        
        const filteredTokens = this.filterTokens(tokens);

        if (filteredTokens.length > 0) {
          logger.info(`✨ Found ${filteredTokens.length} tokens matching criteria`);
          
          for (const token of filteredTokens) {
            if (this.positions.size >= this.config.maxPositions) break;
            
            if (!this.positions.has(token.token.mint) && !this.buyingTokens.has(token.token.mint)) {
              this.buyingTokens.add(token.token.mint);
              
              // Don't await to allow parallel buys
              this.performSwap(token, true).catch((error) => {
                logger.error(`Buy failed for ${token.token.symbol}: ${error.message}`);
                this.buyingTokens.delete(token.token.mint);
              });
              
              // Small delay between buy attempts
              await sleep(1000);
            }
          }
        } else if (tokens.length > 0) {
          logger.debug(`No tokens passed filters (${tokens.length} evaluated)`);
        }
      } catch (error) {
        logger.error(`Error in buy monitor: ${error.message}`);
      }

      await sleep(this.config.delay);
    }
  }

  async positionMonitor() {
    logger.info("📊 Starting position monitor...");
    let monitorCount = 0;
    
    while (true) {
      try {
        monitorCount++;
        
        if (this.positions.size > 0) {
          logger.info(`\n📋 Monitoring ${this.positions.size} positions... (Check #${monitorCount})`);
          
          const positionPromises = Array.from(this.positions.keys()).map(
            (tokenMint) => this.checkAndSellPosition(tokenMint)
          );
          
          await Promise.allSettled(positionPromises);
          
          // Display stats
          this.displayStats();
        } else if (monitorCount % 6 === 0) { // Every 3 minutes if no positions
          logger.info(`💤 No active positions to monitor (Check #${monitorCount})`);
          this.displayStats();
        }
      } catch (error) {
        logger.error(`Error in position monitor: ${error.message}`);
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
    logger.info(`   Buys: ${this.stats.successfulBuys}/${this.stats.totalBuys}`);
    logger.info(`   Sells: ${this.stats.successfulSells}/${this.stats.totalSells}`);
    logger.info(`   Win Rate: ${winRate}%`);
    logger.info(`   Active Positions: ${this.positions.size}/${this.config.maxPositions}`);
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
      logger.info(chalk.cyan("🤖 Solana Trading Bot v2.0"));
      logger.info(chalk.cyan("═══════════════════════════════════════\n"));
      
      await this.initialize();
      
      logger.info("\n🎯 Starting trading loops...\n");

      // Run monitoring loops concurrently
      await Promise.allSettled([
        this.buyMonitor(),
        this.positionMonitor()
      ]);
    } catch (error) {
      logger.error(`💥 Critical error: ${error.message}`);
      process.exit(1);
    }
  }

  // Graceful shutdown
  async shutdown() {
    logger.info("\n🛑 Shutting down bot...");
    
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