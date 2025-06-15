const http = require('http');
const axios = require('axios');
const { Connection, PublicKey } = require('@solana/web3.js');

// ======================
// 1. CONFIGURATION
// ======================
const RPC_URL = process.env.RPC_URL || 'https://api.mainnet-beta.solana.com';
const WALLETS = process.env.WALLETS ? process.env.WALLETS.split(',') : [];
const TG_TOKEN = process.env.TG_TOKEN;
const TG_CHAT_ID = process.env.TG_CHAT_ID;
const CHECK_INTERVAL = process.env.CHECK_INTERVAL || 5 * 60 * 1000; // 5 minutes
let MIN_SWAP_VALUE = process.env.MIN_SWAP_VALUE ? parseInt(process.env.MIN_SWAP_VALUE) : 5000; // $5000 default

// ======================
// 2. RATE LIMITING SYSTEM
// ======================
const requestQueue = [];
let isProcessing = false;

async function processQueue() {
  if (isProcessing || requestQueue.length === 0) return;
  isProcessing = true;

  const { url, resolve, reject } = requestQueue.shift();
  try {
    const response = await axios.get(url, { timeout: 2000 });
    resolve(response);
  } catch (error) {
    reject(error);
  }

  setTimeout(() => {
    isProcessing = false;
    processQueue();
  }, 1000); // 1 request/second
}

function rateLimitedRequest(url) {
  return new Promise((resolve, reject) => {
    requestQueue.push({ url, resolve, reject });
    processQueue();
  });
}

// ======================
// 3. ENHANCED PRICE SERVICE
// ======================
class PriceService {
  constructor() {
    this.cache = new Map();
    this.knownScams = new Set();
    this.blueChips = new Set([
      'So11111111111111111111111111111111111111112', // SOL
      'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' // USDC
    ]);
    this.loadScamList();
  }

  async loadScamList() {
    try {
      const response = await rateLimitedRequest('https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/known-scams.json');
      response.data.forEach(token => this.knownScams.add(token.address));
    } catch (error) {
      console.error('Failed to load scam list:', error.message);
    }
  }

  async getTokenDetails(mintAddress) {
    // Handle blue-chip tokens
    if (this.blueChips.has(mintAddress)) {
      return {
        address: mintAddress,
        symbol: mintAddress === 'So11111111111111111111111111111111111111111112' ? 'SOL' : 'USDC',
        name: mintAddress === 'So11111111111111111111111111111111111111111112' ? 'Solana' : 'USD Coin',
        decimals: 9,
        isBlueChip: true,
        isScam: false,
        logoURI: mintAddress === 'So11111111111111111111111111111111111111111112' 
          ? 'https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/So11111111111111111111111111111111111111112/logo.png'
          : 'https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v/logo.png'
      };
    }

    // Check scam list
    if (this.knownScams.has(mintAddress)) {
      return {
        address: mintAddress,
        symbol: 'SCAM',
        name: 'Scam Token',
        decimals: 9,
        isScam: true,
        logoURI: ''
      };
    }

    // Fetch token details
    try {
      const response = await rateLimitedRequest(`https://token.jup.ag/strict/${mintAddress}`);
      return {
        address: mintAddress,
        symbol: response.data.symbol,
        name: response.data.name,
        decimals: response.data.decimals,
        logoURI: response.data.logoURI || '',
        isScam: false,
        isBlueChip: false
      };
    } catch (error) {
      console.error(`Failed to fetch token ${mintAddress}:`, error.message);
      return {
        address: mintAddress,
        symbol: 'UNKNOWN',
        name: 'Unknown Token',
        decimals: 9,
        isScam: false,
        isBlueChip: false,
        logoURI: ''
      };
    }
  }

  async getPrice(mintAddress) {
    const cacheKey = mintAddress === 'So11111111111111111111111111111111111111112' ? 'SOL' : mintAddress;
    const cached = this.cache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < 300000) { // 5 minute cache
      return cached.price;
    }

    const sources = [
      `https://price.jup.ag/v4/price?ids=${cacheKey}`,
      `https://public-api.birdeye.so/public/price?address=${mintAddress}`,
      cacheKey === 'SOL' ? 'https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd' : null,
      cacheKey === 'SOL' ? 'https://api.binance.com/api/v3/ticker/price?symbol=SOLUSDT' : null
    ].filter(Boolean);

    for (const url of sources) {
      try {
        const response = await rateLimitedRequest(url);
        let price;
        
        if (url.includes('jup.ag')) price = response.data.data[cacheKey]?.price;
        else if (url.includes('birdeye')) price = response.data.data?.value;
        else if (url.includes('coingecko')) price = response.data.solana?.usd;
        else if (url.includes('binance')) price = parseFloat(response.data.price);

        if (price) {
          this.cache.set(cacheKey, { price, timestamp: Date.now() });
          return price;
        }
      } catch (error) {
        console.error(`Price API ${url} failed:`, error.message);
      }
    }

    return cached?.price || 0;
  }
}

const priceService = new PriceService();

// ======================
// 4. TELEGRAM INTEGRATION
// ======================
async function sendTelegramAlert(message) {
  if (!TG_TOKEN || !TG_CHAT_ID) {
    console.log("Telegram alert would be:", message);
    return;
  }

  try {
    await axios.post(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      chat_id: TG_CHAT_ID,
      text: message,
      parse_mode: 'Markdown',
      disable_web_page_preview: false
    }, { timeout: 2000 });
  } catch (error) {
    console.error("Telegram alert failed:", error.message);
  }
}

// ======================
// 5. CORE TRACKING LOGIC
// ======================
const connection = new Connection(RPC_URL, 'confirmed');
const processedTxs = new Set();
const dailyTokenStats = {};
const alertedTokens = new Set();

function shortAddress(address, chars = 4) {
  return `${address.slice(0, chars)}...${address.slice(-chars)}`;
}

async function checkLiquidity(mintAddress) {
  try {
    const response = await rateLimitedRequest(`https://api.dexscreener.com/latest/dex/tokens/${mintAddress}`);
    return response.data.pairs.reduce((sum, pair) => sum + (pair.liquidity?.usd || 0), 0);
  } catch (error) {
    console.error("Liquidity check failed:", error.message);
    return 0;
  }
}

async function detectSwaps(tx, wallet) {
  try {
    const preBalances = tx.meta.preTokenBalances || [];
    const postBalances = tx.meta.postTokenBalances || [];
    const changes = {};

    // Analyze balance changes
    for (const balance of postBalances) {
      if (balance.owner !== wallet) continue;
      
      const pre = preBalances.find(b => b.mint === balance.mint && b.owner === balance.owner);
      const preAmount = pre?.uiTokenAmount?.uiAmount || 0;
      const postAmount = balance.uiTokenAmount?.uiAmount || 0;
      const diff = postAmount - preAmount;

      if (Math.abs(diff) > 0) {
        changes[balance.mint] = {
          ...await priceService.getTokenDetails(balance.mint),
          change: diff
        };
      }
    }

    // Validate swap pair
    const changedTokens = Object.keys(changes);
    if (changedTokens.length !== 2) return;

    // Get prices
    const [tokenA, tokenB] = await Promise.all([
      { ...changes[changedTokens[0]], price: await priceService.getPrice(changedTokens[0]) },
      { ...changes[changedTokens[1]], price: await priceService.getPrice(changedTokens[1]) }
    ]);

    // Determine swap direction
    let tokenIn, tokenOut, usdValue;
    if (tokenA.change > 0 && tokenB.change < 0) {
      tokenOut = tokenA;
      tokenIn = tokenB;
      usdValue = Math.abs(tokenB.change) * tokenB.price;
    } else if (tokenA.change < 0 && tokenB.change > 0) {
      tokenOut = tokenB;
      tokenIn = tokenA;
      usdValue = Math.abs(tokenA.change) * tokenA.price;
    } else {
      return;
    }

    // Apply threshold
    if (usdValue < MIN_SWAP_VALUE) return;

    // Check liquidity
    const liquidity = await checkLiquidity(tokenOut.address);
    const liquidityWarning = liquidity < usdValue * 10 ? `\n⚠️ LOW LIQUIDITY ($${liquidity.toFixed(2)})` : '';

    // Prepare alert
    const message = `💎 *Large Swap Detected* ($${usdValue.toFixed(2)})${liquidityWarning}\n` +
                   `▸ Wallet: \`${shortAddress(wallet)}\`\n` +
                   `▸ Sold: ${Math.abs(tokenIn.change).toFixed(tokenIn.decimals)} ${tokenIn.symbol}\n` +
                   `▸ Bought: ${Math.abs(tokenOut.change).toFixed(tokenOut.decimals)} ${tokenOut.symbol}\n` +
                   `▸ [Chart](https://dexscreener.com/solana/${tokenOut.address})\n` +
                   `▸ [Transaction](https://solscan.io/tx/${tx.transaction.signatures[0]})` +
                   `${tokenOut.isScam ? '\n🚨 SCAM TOKEN DETECTED' : ''}`;

    await sendTelegramAlert(message);
  } catch (error) {
    console.error('Swap detection error:', error.message);
  }
}

async function handleTokenTransfer(parsedIx, wallet, tx) {
  try {
    const { mint, tokenAmount, destination } = parsedIx.info;
    if (destination !== wallet || !tokenAmount?.uiAmount) return;

    const today = new Date().toISOString().split('T')[0];
    if (!dailyTokenStats[today]) dailyTokenStats[today] = {};

    const tokenData = dailyTokenStats[today][mint] || {
      ...await priceService.getTokenDetails(mint),
      wallets: new Set(),
      totalAmount: 0,
      firstPrice: null,
      lastPrice: null
    };

    // Update stats
    tokenData.wallets.add(wallet);
    tokenData.totalAmount += tokenAmount.uiAmount;
    const currentPrice = await priceService.getPrice(mint);
    tokenData.lastPrice = currentPrice;
    tokenData.firstPrice = tokenData.firstPrice || currentPrice;
    dailyTokenStats[today][mint] = tokenData;

    // Check for coordinated buying
    if (tokenData.wallets.size >= 3 && !alertedTokens.has(mint)) {
      const priceChange = tokenData.firstPrice 
        ? ((tokenData.lastPrice - tokenData.firstPrice) / tokenData.firstPrice * 100).toFixed(2)
        : '0.00';

      const message = `🚨 *Coordinated Buying* (${tokenData.wallets.size} wallets)\n` +
                     `▸ Token: ${tokenData.symbol} (${tokenData.name})\n` +
                     `▸ Volume: ${tokenData.totalAmount.toFixed(tokenData.decimals)} ${tokenData.symbol}\n` +
                     `▸ Price Change: ${priceChange}%\n` +
                     `▸ [DexScreener](https://dexscreener.com/solana/${mint})` +
                     `${tokenData.isScam ? '\n🚨 SCAM TOKEN DETECTED' : ''}`;

      await sendTelegramAlert(message);
      alertedTokens.add(mint);
    }
  } catch (error) {
    console.error('Transfer handling error:', error.message);
  }
}

// ======================
// 6. TRANSACTION PROCESSING
// ======================
async function analyzeTransaction(tx, wallet) {
  if (!tx?.transaction?.message?.instructions) return;

  // Check transfers
  for (const ix of tx.transaction.message.instructions) {
    if (ix.parsed?.type === 'transfer' || ix.parsed?.type === 'transferChecked') {
      await handleTokenTransfer(ix.parsed, wallet, tx);
    }
  }

  // Check swaps
  if (tx.meta?.preTokenBalances && tx.meta?.postTokenBalances) {
    await detectSwaps(tx, wallet);
  }
}

async function checkWalletTransactions(wallet) {
  try {
    const pubkey = new PublicKey(wallet);
    const signatures = await connection.getSignaturesForAddress(pubkey, { limit: 15 });

    for (const { signature } of signatures) {
      if (!processedTxs.has(signature)) {
        const tx = await connection.getParsedTransaction(signature);
        await analyzeTransaction(tx, wallet);
        processedTxs.add(signature);
      }
    }
  } catch (error) {
    console.error(`Wallet check error (${wallet}):`, error.message);
  }
}

async function checkWallets() {
  try {
    await Promise.all(WALLETS.map(checkWalletTransactions));
  } catch (error) {
    console.error("CheckWallets error:", error.message);
  }
}

// ======================
// 7. CLEANUP & MAINTENANCE
// ======================
function getYesterdayDate() {
  const date = new Date();
  date.setDate(date.getDate() - 1);
  return date.toISOString().split('T')[0];
}

setInterval(() => {
  const today = new Date().toISOString().split('T')[0];
  Object.keys(dailyTokenStats).forEach(date => {
    if (date !== today && date !== getYesterdayDate()) {
      delete dailyTokenStats[date];
    }
  });
  alertedTokens.clear();
}, 6 * 60 * 60 * 1000); // Clean every 6 hours

// ======================
// 8. SERVER INITIALIZATION
// ======================
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ 
    status: 'online',
    wallets: WALLETS.length,
    threshold: MIN_SWAP_VALUE,
    lastChecked: new Date().toISOString() 
  }));
}).listen(process.env.PORT || 10000, () => {
  console.log(`Server running on port ${process.env.PORT || 10000}`);
  setInterval(checkWallets, CHECK_INTERVAL);
  checkWallets(); // Initial run
});
