require("dotenv").config();
const { SolanaTracker } = require("solana-swap");
const { Keypair, PublicKey, Connection } = require("@solana/web3.js");
const bs58 = require("bs58");
const winston = require("winston");
const chalk = require("chalk");
const fs = require("fs").promises;
const WebSocketService = require("./services/ws");

const logger = winston.createLogger({
  level: "info",
  format: winston.format.combine(
    winston.format.timestamp({
      format: "YYYY-MM-DD HH:mm:ss",
    }),
    winston.format.printf(
      (info) => `${info.timestamp} ${info.level}: ${info.message}`
    )
  ),
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({ filename: "trading-bot.log" }),
  ],
});

class TradingBot {
  constructor() {
    this.config = {
      amount: parseFloat(process.env.AMOUNT),
      slippage: parseInt(process.env.SLIPPAGE),
      priorityFee: parseFloat(process.env.PRIORITY_FEE),
      useJito: process.env.JITO === "true",
      rpcUrl: process.env.RPC_URL,
      minLiquidity: parseFloat(process.env.MIN_LIQUIDITY) || 0,
      maxLiquidity: parseFloat(process.env.MAX_LIQUIDITY) || Infinity,
      minMarketCap: parseFloat(process.env.MIN_MARKET_CAP) || 0,
      maxMarketCap: parseFloat(process.env.MAX_MARKET_CAP) || Infinity,
      minRiskScore: parseInt(process.env.MIN_RISK_SCORE) || 0,
      maxRiskScore: parseInt(process.env.MAX_RISK_SCORE) || 10,
      requireSocialData: process.env.REQUIRE_SOCIAL_DATA === "true",
      maxNegativePnL: parseFloat(process.env.MAX_NEGATIVE_PNL) || -Infinity,
      maxPositivePnL: parseFloat(process.env.MAX_POSITIVE_PNL) || Infinity,
      markets: process.env.MARKETS?.split(",").map((m) => m.trim()) || ['raydium', 'orca', 'pumpfun', 'moonshot', 'raydium-cpmm'],
    };


    this.privateKey = process.env.PRIVATE_KEY;
    this.SOL_ADDRESS = "So11111111111111111111111111111111111111112";
    this.positions = new Map();
    this.positionsFile = "positions.json";
    this.soldPositionsFile = "sold_positions.json";
    this.soldPositions = [];
    this.seenTokens = new Set();
    this.buyingTokens = new Set();
    this.sellingPositions = new Set();

    this.connection = new Connection(this.config.rpcUrl);
    this.wsService = new WebSocketService(process.env.WS_URL);
  }

  async initialize() {
    this.keypair = Keypair.fromSecretKey(bs58.decode(this.privateKey));
    this.solanaTracker = new SolanaTracker(this.keypair, this.config.rpcUrl);
    await this.loadPositions();
    await this.loadSoldPositions();
    this.setupWebSocketListeners();
  }

  setupWebSocketListeners() {
    logger.info("Monitoring for new tokens");
    this.wsService.joinRoom('latest');
    this.wsService.on('latest', (data) => this.handleNewToken(data));

    // Setup listeners for existing positions
    for (const [tokenMint, position] of this.positions) {
      this.setupPriceListener(tokenMint, position.poolId);
    }
  }

  setupPriceListener(tokenMint, poolId) {
    this.wsService.joinRoom(`pool:${poolId}`);
    this.wsService.on(`pool:${poolId}`, (data) => this.handlePriceUpdate(tokenMint, data));
  }

  handleNewToken(token) {
    if (this.filterToken(token)) {
      this.seenTokens.add(token.token.mint);
      this.performSwap(token, true).catch((error) => {
        logger.error(`Error buying new token: ${error.message}`, { error });
      });
    }
  }

  handlePriceUpdate(tokenMint, data) {
    const position = this.positions.get(tokenMint);
    if (position && !this.sellingPositions.has(tokenMint)) {
      const currentPrice = data.price.quote;
      const pnlPercentage = ((currentPrice - position.entryPrice) / position.entryPrice) * 100;
  
      logger.info(
        `PnL for position [${position.symbol}] [${chalk[
          pnlPercentage > 0 ? "green" : "red"
        ](pnlPercentage.toFixed(2))}%]`
      );
  
      if (
        pnlPercentage <= this.config.maxNegativePnL ||
        pnlPercentage >= this.config.maxPositivePnL
      ) {
        this.sellingPositions.add(tokenMint);
        const token = {
          token: { mint: tokenMint, symbol: position.symbol },
          pools: [{ poolId: position.poolId, price: { quote: currentPrice } }]
        };
        this.performSwap(token, false).catch((error) => {
          logger.error(`Error selling position: ${error.message}`, { error });
          this.sellingPositions.delete(tokenMint);
        });
      }
    }
  }

  filterToken(token) {
    const pool = token.pools[0];
    const liquidity = pool.liquidity.usd;
    const marketCap = pool.marketCap.usd;
    const riskScore = token.risk.score;
    const hasSocialData = !!(
      token.token.twitter ||
      token.token.telegram ||
      token.token.website
    );
    const isInAllowedMarket = this.config.markets.includes(pool.market);

    return (
      liquidity >= this.config.minLiquidity &&
      liquidity <= this.config.maxLiquidity &&
      marketCap >= this.config.minMarketCap &&
      marketCap <= this.config.maxMarketCap &&
      riskScore >= this.config.minRiskScore &&
      riskScore <= this.config.maxRiskScore &&
      (!this.config.requireSocialData || hasSocialData) &&
      isInAllowedMarket &&
      !this.seenTokens.has(token.token.mint) &&
      !this.buyingTokens.has(token.token.mint)
    );
  }

  async performSwap(token, isBuy) {
    logger.info(
      `${
        isBuy ? chalk.white("[BUYING]") : chalk.white("[SELLING]")
      } [${this.keypair.publicKey.toBase58()}] [${token.token.symbol}] [${
        token.token.mint
      }]`
    );
    const { amount, slippage, priorityFee } = this.config;
    const [fromToken, toToken] = isBuy
      ? [this.SOL_ADDRESS, token.token.mint]
      : [token.token.mint, this.SOL_ADDRESS];

    try {
      let swapAmount;
      if (isBuy) {
        swapAmount = amount;
      } else {
        const position = this.positions.get(token.token.mint);
        if (!position) {
          logger.error(
            `No position found for ${token.token.symbol} when trying to sell`
          );
          return false;
        }
        swapAmount = position.amount;
      }

      const swapResponse = await this.solanaTracker.getSwapInstructions(
        fromToken,
        toToken,
        swapAmount,
        slippage,
        this.keypair.publicKey.toBase58(),
        priorityFee
      );

      const swapOptions = this.buildSwapOptions();
      const txid = await this.solanaTracker.performSwap(
        swapResponse,
        swapOptions
      );
      this.logTransaction(txid, isBuy, token);

      if (isBuy) {
        const tokenAmount = await this.getWalletAmount(
          this.keypair.publicKey.toBase58(),
          token.token.mint
        );
        if (!tokenAmount) {
          logger.error(
            `Swap failed ${token.token.mint}`
          );
          return false;
        }
        this.positions.set(token.token.mint, {
          txid,
          poolId: token.pools[0].poolId,
          symbol: token.token.symbol,
          entryPrice: token.pools[0].price.quote,
          amount: tokenAmount,
          openTime: Date.now(),
        });
        this.buyingTokens.delete(token.token.mint);
        this.setupPriceListener(token.token.mint, token.pools[0].poolId);
      } else {
        const position = this.positions.get(token.token.mint);
        if (position) {
          const exitPrice = token.pools[0].price.quote;
          const pnl = (exitPrice - position.entryPrice) * position.amount;
          const pnlPercentage =
            (pnl / (position.entryPrice * position.amount)) * 100;

          const soldPosition = {
            ...position,
            exitPrice,
            pnl,
            pnlPercentage,
            closeTime: Date.now(),
            closeTxid: txid,
          };

          this.soldPositions.push(soldPosition);

          logger.info(
            `Closed position for ${token.token.symbol}. PnL: (${pnlPercentage.toFixed(2)}%)`
          );
          this.positions.delete(token.token.mint);
          this.sellingPositions.delete(token.token.mint);
          this.wsService.leaveRoom(`pool:${position.poolId}`);

          await this.saveSoldPositions();
        }
      }

      await this.savePositions();
      return txid;
    } catch (error) {
      logger.error(
        `Error performing ${isBuy ? "buy" : "sell"}: ${error.message}`,
        { error }
      );
      if (isBuy) {
        this.buyingTokens.delete(token.token.mint);
      } else {
        this.sellingPositions.delete(token.token.mint);
      }
      return false;
    }
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

  logTransaction(txid, isBuy, token) {
    logger.info(
      `${isBuy ? chalk.green("[BOUGHT]") : chalk.red("[SOLD]")} ${
        token.token.symbol
      } [${txid}]`
    );
  }

  async getWalletAmount(wallet, mint, retries = 3) {
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const tokenAccountInfo =
          await this.connection.getParsedTokenAccountsByOwner(
            new PublicKey(wallet),
            {
              mint: new PublicKey(mint),
            }
          );

        if (tokenAccountInfo.value) {
          const balance =
            tokenAccountInfo.value[0].account.data.parsed.info.tokenAmount
              .uiAmount;

          if (balance > 0) {
            return balance;
          }
        }

        if (attempt < retries) {
          await new Promise(resolve => setTimeout(resolve, 10000));
        }
      } catch (error) {
        if (attempt < retries) {
          await new Promise(resolve => setTimeout(resolve, 10000));
        } else {
          logger.error(
            `All attempts failed. Error getting wallet amount for token ${mint}:`,
            error
          );
        }
      }
    }

    logger.warn(
      `Failed to get wallet amount for token ${mint} after ${retries} retries.`
    );
    return null;
  }

  async loadSoldPositions() {
    try {
      const data = await fs.readFile(this.soldPositionsFile, "utf8");
      this.soldPositions = JSON.parse(data);
      logger.info(
        `Loaded ${this.soldPositions.length} sold positions from file`
      );
    } catch (error) {
      if (error.code !== "ENOENT") {
        logger.error("Error loading sold positions", { error });
      }
    }
  }

  async saveSoldPositions() {
    try {
      await fs.writeFile(
        this.soldPositionsFile,
        JSON.stringify(this.soldPositions, null, 2)
      );
      logger.info(`Saved ${this.soldPositions.length} sold positions to file`);
    } catch (error) {
      logger.error("Error saving sold positions", { error });
    }
  }
  
  async loadPositions() {
    try {
      const data = await fs.readFile(this.positionsFile, "utf8");
      const loadedPositions = JSON.parse(data);
      this.positions = new Map(Object.entries(loadedPositions));
      this.seenTokens = new Set(this.positions.keys());
      logger.info(`Loaded ${this.positions.size} positions from file`);
    } catch (error) {
      if (error.code !== "ENOENT") {
        logger.error("Error loading positions", { error });
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
      logger.info(`Saved ${this.positions.size} positions to file`);
    } catch (error) {
      logger.error("Error saving positions", { error });
    }
  }

  async start() {
    logger.info("Starting Trading Bot");
    await this.initialize();
  }
}

const bot = new TradingBot();
bot.start().catch((error) => logger.error("Error in bot execution", { error }));