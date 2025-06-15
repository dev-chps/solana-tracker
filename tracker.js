const http = require('http');
const axios = require('axios');
const Bottleneck = require('bottleneck');
const { Connection, PublicKey } = require('@solana/web3.js');

// ======================
// 1. ENHANCED CONFIGURATION
// ======================
const RPC_URL = process.env.RPC_URL || 'https://api.mainnet-beta.solana.com';
const WALLETS = process.env.WALLETS ? process.env.WALLETS.split(',') : [];
const TG_TOKEN = process.env.TG_TOKEN;
const TG_CHAT_ID = process.env.TG_CHAT_ID;
const CHECK_INTERVAL = process.env.CHECK_INTERVAL || 5 * 60 * 1000;
const MIN_SWAP_VALUE = process.env.MIN_SWAP_VALUE || 5000; // $5000 default

// ======================
// 2. ADVANCED RATE LIMITING
// ======================
const limiter = new Bottleneck({
  minTime: 1000, // 1 request/sec
  reservoir: 30,
  reservoirRefreshInterval: 60 * 1000
});

const limitedAxios = limiter.wrap(axios);

// ======================
// 3. PRICE SERVICE WITH SCAM DETECTION
// ======================
class EnhancedPriceService {
  constructor() {
    this.cache = new Map();
    this.cacheDuration = 300000;
    this.knownScams = new Set();
    this.blueChips = new Set([
      'So11111111111111111111111111111111111111112', // SOL
      'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' // USDC
    ]);
  }

  async _fetchScamList() {
    try {
      const { data } = await limitedAxios.get('https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/known-scams.json');
      this.knownScams = new Set(data.map(t => t.address));
    } catch (e) {
      console.error('Failed to load scam list:', e.message);
    }
  }

  async getTokenDetails(mintAddress) {
    // Handle SOL/USDC specially
    if (this.blueChips.has(mintAddress)) {
      return {
        address: mintAddress,
        symbol: mintAddress === 'So11111111111111111111111111111111111111112' ? 'SOL' : 'USDC',
        name: mintAddress === 'So11111111111111111111111111111111111111112' ? 'Solana' : 'USD Coin',
        decimals: 9,
        isBlueChip: true,
        isScam: false
      };
    }

    // Check scam list
    if (this.knownScams.has(mintAddress)) {
      return {
        address: mintAddress,
        symbol: 'SCAM',
        name: 'Scam Token',
        decimals: 9,
        isScam: true
      };
    }

    try {
      const { data } = await limitedAxios.get(`https://token.jup.ag/strict/${mintAddress}`, { timeout: 2000 });
      return {
        address: mintAddress,
        symbol: data.symbol,
        name: data.name,
        decimals: data.decimals,
        logoURI: data.logoURI,
        isScam: false
      };
    } catch {
      return {
        address: mintAddress,
        symbol: 'UNKNOWN',
        name: 'Unknown Token',
        decimals: 9,
        isScam: false
      };
    }
  }

  // ... (rest of PriceService methods from previous version)
}

const priceService = new EnhancedPriceService();
priceService._fetchScamList();

// ======================
// 4. LIQUIDITY CHECKER
// ======================
async function checkLiquidity(mintAddress) {
  try {
    const { data } = await limitedAxios.get(`https://api.dexscreener.com/latest/dex/tokens/${mintAddress}`);
    return data.pairs.reduce((sum, pair) => sum + (pair.liquidity?.usd || 0), 0);
  } catch {
    return 0;
  }
}

// ======================
// 5. ENHANCED SWAP DETECTION
// ======================
async function detectSwaps(tx, wallet) {
  try {
    // ... (previous balance change detection code)

    // Add liquidity check
    const liquidity = await checkLiquidity(tokenOut.address);
    const liquidityWarning = liquidity < usdValue * 10 ? 
      `\n⚠️ LOW LIQUIDITY ($${liquidity.toFixed(2)})` : '';

    const message = `💎 *Large Swap* ($${usdValue.toFixed(2)})${liquidityWarning}\n` +
                   `▸ Wallet: \`${shortAddress(wallet)}\`\n` +
                   `▸ Sold: ${Math.abs(tokenIn.change).toFixed(tokenIn.decimals)} ${tokenIn.symbol}\n` +
                   `▸ Bought: ${Math.abs(tokenOut.change).toFixed(tokenOut.decimals)} ${tokenOut.symbol}\n` +
                   `▸ [Chart](https://dexscreener.com/solana/${tokenOut.address})` +
                   `${tokenOut.isScam ? '\n🚨 SCAM TOKEN DETECTED' : ''}`;

    await sendTelegramAlert(message);

  } catch (error) {
    console.error('Swap detection error:', error);
  }
}

// ======================
// 6. TELEGRAM BOT CONTROLS
// ======================
const TelegramBot = require('node-telegram-bot-api');
const bot = new TelegramBot(TG_TOKEN, {polling: true});

// Dynamic threshold adjustment
bot.onText(/\/setthreshold (\d+)/, (msg) => {
  MIN_SWAP_VALUE = parseInt(msg.match[1]);
  bot.sendMessage(msg.chat.id, `🛠 Threshold set to $${MIN_SWAP_VALUE}`);
});

// Pause/resume commands
let isPaused = false;
bot.onText(/\/pause/, (msg) => {
  isPaused = true;
  bot.sendMessage(msg.chat.id, '⏸ Tracking paused');
});

bot.onText(/\/resume/, (msg) => {
  isPaused = false; 
  bot.sendMessage(msg.chat.id, '▶️ Tracking resumed');
});

// ======================
// 7. OPTIMIZED WALLET CHECKING
// ======================
async function checkWalletTransactions(wallet) {
  if (isPaused) return;

  try {
    const pubkey = new PublicKey(wallet);
    // Batch request for efficiency
    const [signatures, balance] = await Promise.all([
      connection.getSignaturesForAddress(pubkey, {limit: 15}),
      connection.getBalance(pubkey)
    ]);

    // Process transactions
    await Promise.all(
      signatures.map(async ({signature}) => {
        if (!processedTxs.has(signature)) {
          const tx = await connection.getParsedTransaction(signature);
          await analyzeTransaction(tx, wallet);
          processedTxs.add(signature);
        }
      })
    );
  } catch (error) {
    console.error(`Wallet check error:`, error);
  }
}

// ======================
// 8. MAIN SERVER (same as before)
// ======================
const server = http.createServer((req, res) => {
  res.writeHead(200, {'Content-Type': 'application/json'});
  res.end(JSON.stringify({
    status: isPaused ? 'paused' : 'online',
    threshold: MIN_SWAP_VALUE,
    wallets: WALLETS.length
  }));
}).listen(process.env.PORT || 10000, () => {
  console.log(`Server running on port ${process.env.PORT || 10000}`);
  setInterval(() => !isPaused && checkWallets(), CHECK_INTERVAL);
});
