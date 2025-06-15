const http = require('http');
const axios = require('axios');
const TelegramBot = require('node-telegram-bot-api');
const { Connection, PublicKey } = require('@solana/web3.js');

// ======================
// 1. ENHANCED CONFIGURATION
// ======================
const RPC_URL = process.env.RPC_URL || 'https://api.mainnet-beta.solana.com';
const WALLETS = process.env.WALLETS ? process.env.WALLETS.split(',') : [];
const TG_TOKEN = process.env.TG_TOKEN;
const TG_CHAT_ID = process.env.TG_CHAT_ID;
const CHECK_INTERVAL = process.env.CHECK_INTERVAL || 5 * 60 * 1000;
let MIN_SWAP_VALUE = process.env.MIN_SWAP_VALUE ? parseInt(process.env.MIN_SWAP_VALUE) : 5000;

// ======================
// 2. RATE LIMITING (No Bottleneck)
// ======================
let lastRequestTime = 0;
async function rateLimitedRequest(url) {
  const now = Date.now();
  const delay = Math.max(0, 1000 - (now - lastRequestTime));
  await new Promise(resolve => setTimeout(resolve, delay));
  lastRequestTime = now;
  return axios.get(url, { timeout: 2000 });
}

// ======================
// 3. PRICE SERVICE WITH SCAM DETECTION
// ======================
class EnhancedPriceService {
  constructor() {
    this.cache = new Map();
    this.knownScams = new Set();
    this.blueChips = new Set([
      'So11111111111111111111111111111111111111112', // SOL
      'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' // USDC
    ]);
    this._fetchScamList();
  }

  async _fetchScamList() {
    try {
      const { data } = await axios.get('https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/known-scams.json');
      data.forEach(token => this.knownScams.add(token.address));
    } catch (e) {
      console.error('Failed to load scam list:', e.message);
    }
  }

  async getTokenDetails(mintAddress) {
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
      const { data } = await rateLimitedRequest(`https://token.jup.ag/strict/${mintAddress}`);
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
}

const priceService = new EnhancedPriceService();

// ======================
// 4. TELEGRAM BOT CONTROLS
// ======================
const bot = new TelegramBot(TG_TOKEN, {polling: true});
let isPaused = false;

bot.onText(/\/setthreshold (\d+)/, (msg, match) => {
  MIN_SWAP_VALUE = parseInt(match[1]);
  bot.sendMessage(msg.chat.id, `Threshold set to $${MIN_SWAP_VALUE}`);
});

bot.onText(/\/pause/, (msg) => {
  isPaused = true;
  bot.sendMessage(msg.chat.id, 'Tracking paused');
});

bot.onText(/\/resume/, (msg) => {
  isPaused = false;
  bot.sendMessage(msg.chat.id, 'Tracking resumed');
});

// ======================
// 5. CORE FUNCTIONALITY
// ======================
const connection = new Connection(RPC_URL, 'confirmed');
const processedTxs = new Set();
const dailyTokenStats = {};

async function checkWallets() {
  if (isPaused) return;
  
  try {
    await Promise.all(
      WALLETS.map(wallet => checkWalletTransactions(wallet))
    );
  } catch (error) {
    console.error("CheckWallets error:", error);
  }
}

async function checkWalletTransactions(wallet) {
  try {
    const pubkey = new PublicKey(wallet);
    const signatures = await connection.getSignaturesForAddress(pubkey, {limit: 15});
    
    for (const {signature} of signatures) {
      if (!processedTxs.has(signature)) {
        const tx = await connection.getParsedTransaction(signature);
        await analyzeTransaction(tx, wallet);
        processedTxs.add(signature);
      }
    }
  } catch (error) {
    console.error(`Wallet check error:`, error);
  }
}

// [Rest of your functions (detectSwaps, analyzeTransaction, etc.) remain unchanged]
// Keep all the existing logic from previous versions

// ======================
// 6. SERVER INITIALIZATION
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
  setInterval(checkWallets, CHECK_INTERVAL);
});
