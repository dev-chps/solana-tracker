const http = require('http');
const axios = require('axios');
const { Connection, PublicKey } = require('@solana/web3.js');

// 1. PRICE SERVICE CLASS
class PriceService {
  constructor() {
    this.cache = new Map();
    this.cacheDuration = 300000;
  }

  async getPrice(mintAddress) {
    if (mintAddress === 'So11111111111111111111111111111111111111112') {
      mintAddress = 'SOL';
    }

    const cached = this.cache.get(mintAddress);
    if (cached && Date.now() - cached.timestamp < this.cacheDuration) {
      return cached.price;
    }

    const sources = [
      this._tryJupiterPrice.bind(this),
      this._tryBirdeyePrice.bind(this),
      this._tryCoingeckoPrice.bind(this),
      this._tryBinancePrice.bind(this)
    ];

    for (const source of sources) {
      try {
        const price = await source(mintAddress);
        if (price) {
          this.cache.set(mintAddress, { price, timestamp: Date.now() });
          return price;
        }
      } catch (error) {
        console.warn(`Price API failed:`, error.message);
      }
    }

    return cached?.price || 0;
  }

  async _tryJupiterPrice(mintAddress) {
    const response = await axios.get(`https://price.jup.ag/v4/price?ids=${mintAddress}`, { timeout: 2000 });
    return response.data.data[mintAddress]?.price;
  }

  async _tryBirdeyePrice(mintAddress) {
    const response = await axios.get(`https://public-api.birdeye.so/public/price?address=${mintAddress}`, { timeout: 2000 });
    return response.data.data?.value;
  }

  async _tryCoingeckoPrice() {
    const response = await axios.get('https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd', { timeout: 2000 });
    return response.data.solana?.usd;
  }

  async _tryBinancePrice() {
    const response = await axios.get('https://api.binance.com/api/v3/ticker/price?symbol=SOLUSDT', { timeout: 2000 });
    return parseFloat(response.data.price);
  }
}

const priceService = new PriceService();

// 2. CONFIGURATION
const RPC_URL = process.env.RPC_URL || 'https://api.mainnet-beta.solana.com';
const WALLETS = process.env.WALLETS ? process.env.WALLETS.split(',') : [];
const TG_TOKEN = process.env.TG_TOKEN;
const TG_CHAT_ID = process.env.TG_CHAT_ID;
const CHECK_INTERVAL = process.env.CHECK_INTERVAL || 5 * 60 * 1000;

const connection = new Connection(RPC_URL, 'confirmed');
const tokenPurchases = {};
const processedTxs = new Set();
const dailyTokenStats = {};
const alertedTokens = new Set();

// 3. HELPER FUNCTIONS
function shortAddress(address, chars = 4) {
  return `${address.slice(0, chars)}...${address.slice(-chars)}`;
}

async function getTokenDetails(mintAddress) {
  if (mintAddress === 'So11111111111111111111111111111111111111112') {
    return {
      address: mintAddress,
      symbol: 'SOL',
      name: 'Solana',
      decimals: 9,
      logoURI: 'https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/So11111111111111111111111111111111111111112/logo.png',
      verified: true
    };
  }

  try {
    const response = await axios.get(`https://token.jup.ag/strict/${mintAddress}`, { timeout: 2000 });
    return {
      address: mintAddress,
      symbol: response.data.symbol,
      name: response.data.name,
      decimals: response.data.decimals,
      logoURI: response.data.logoURI,
      verified: true
    };
  } catch {
    try {
      const accountInfo = await connection.getParsedAccountInfo(new PublicKey(mintAddress));
      const details = accountInfo.value?.data?.parsed?.info;
      return {
        address: mintAddress,
        symbol: details?.symbol || 'TOKEN',
        name: details?.name || 'Unknown Token',
        decimals: details?.decimals || 9,
        logoURI: '',
        verified: false
      };
    } catch {
      return {
        address: mintAddress,
        symbol: 'TOKEN',
        name: 'Unknown Token',
        decimals: 9,
        logoURI: '',
        verified: false
      };
    }
  }
}

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
    });
  } catch (error) {
    console.error("Telegram alert failed:", error.message);
  }
}

// 4. TRANSACTION PROCESSING
async function handleTokenTransfer(parsedIx, wallet, tx) {
  try {
    const { mint, tokenAmount, destination } = parsedIx.info;
    if (destination !== wallet || !tokenAmount?.uiAmount) return;

    const today = new Date().toISOString().split('T')[0];
    
    if (!dailyTokenStats[today]) dailyTokenStats[today] = {};
    if (!dailyTokenStats[today][mint]) {
      const tokenInfo = await getTokenDetails(mint);
      dailyTokenStats[today][mint] = {
        ...tokenInfo,
        wallets: new Set(),
        totalAmount: 0,
        firstPrice: null,
        lastPrice: null
      };
    }

    const tokenData = dailyTokenStats[today][mint];
    tokenData.wallets.add(wallet);
    tokenData.totalAmount += tokenAmount.uiAmount;
    
    const currentPrice = await priceService.getPrice(mint);
    tokenData.lastPrice = currentPrice;
    if (!tokenData.firstPrice) tokenData.firstPrice = currentPrice;

    if (tokenData.wallets.size >= 3 && !alertedTokens.has(mint)) {
      const priceChange = tokenData.firstPrice 
        ? ((tokenData.lastPrice - tokenData.firstPrice) / tokenData.firstPrice * 100).toFixed(2)
        : 0;

      const message = `🚨 *Coordinated Buying!* (${tokenData.wallets.size} wallets)\n` +
                     `▸ Token: ${tokenData.symbol} (${tokenData.name})\n` +
                     `▸ Address: \`${shortAddress(mint)}\`\n` +
                     `▸ Volume: ${tokenData.totalAmount.toFixed(tokenData.decimals)} ${tokenData.symbol}\n` +
                     `▸ Price Change: ${priceChange}%\n` +
                     `▸ [DexScreener](https://dexscreener.com/solana/${mint})\n` +
                     `${!tokenData.verified ? '⚠️ *Unverified* - DYOR!' : ''}`;

      await sendTelegramAlert(message);
      alertedTokens.add(mint);
    }

  } catch (error) {
    console.error('Transfer handling error:', error);
  }
}

async function detectSwaps(tx, wallet) {
  try {
    const preBalances = tx.meta.preTokenBalances || [];
    const postBalances = tx.meta.postTokenBalances || [];

    const changes = {};
    for (const balance of postBalances) {
      if (balance.owner !== wallet) continue;
      
      const pre = preBalances.find(b => b.mint === balance.mint && b.owner === balance.owner);
      const preAmount = pre?.uiTokenAmount?.uiAmount || 0;
      const postAmount = balance.uiTokenAmount?.uiAmount || 0;
      const diff = postAmount - preAmount;

      if (Math.abs(diff) > 0) {
        changes[balance.mint] = {
          ...await getTokenDetails(balance.mint),
          change: diff
        };
      }
    }

    const changedTokens = Object.keys(changes);
    if (changedTokens.length !== 2) return;

    const [tokenA, tokenB] = await Promise.all([
      { ...changes[changedTokens[0]], price: await priceService.getPrice(changedTokens[0]) },
      { ...changes[changedTokens[1]], price: await priceService.getPrice(changedTokens[1]) }
    ]);

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

    if (usdValue < 5000) return;

    const message = `💎 *Large Swap Detected* ($${usdValue.toFixed(2)})\n` +
                   `▸ Wallet: \`${shortAddress(wallet)}\`\n` +
                   `▸ Sold: ${Math.abs(tokenIn.change).toFixed(tokenIn.decimals)} ${tokenIn.symbol} ($${(Math.abs(tokenIn.change)*tokenIn.price).toFixed(2)})\n` +
                   `▸ Bought: ${Math.abs(tokenOut.change).toFixed(tokenOut.decimals)} ${tokenOut.symbol}\n` +
                   `▸ [Chart](https://dexscreener.com/solana/${tokenOut.address})\n` +
                   `▸ [Transaction](https://solscan.io/tx/${tx.transaction.signatures[0]})`;

    await sendTelegramAlert(message);

  } catch (error) {
    console.error('Swap detection error:', error);
  }
}

// 5. WALLET MONITORING
async function checkWalletTransactions(wallet) {
  try {
    const pubkey = new PublicKey(wallet);
    const signatures = await connection.getSignaturesForAddress(pubkey, { limit: 15 });

    for (const { signature } of signatures) {
      if (processedTxs.has(signature)) continue;
      
      try {
        const tx = await connection.getParsedTransaction(signature, { maxSupportedTransactionVersion: 0 });
        await analyzeTransaction(tx, wallet);
        processedTxs.add(signature);
      } catch (error) {
        console.error(`Error processing tx ${signature}:`, error.message);
      }
    }
  } catch (error) {
    console.error(`Error checking ${wallet}:`, error.message);
  }
}

async function analyzeTransaction(tx, wallet) {
  if (!tx?.transaction?.message?.instructions) return;

  for (const ix of tx.transaction.message.instructions) {
    if (ix.parsed?.type === 'transfer' || ix.parsed?.type === 'transferChecked') {
      await handleTokenTransfer(ix.parsed, wallet, tx);
    }
  }

  if (tx.meta?.preTokenBalances && tx.meta?.postTokenBalances) {
    await detectSwaps(tx, wallet);
  }
}

// 6. CLEANUP
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
}, 6 * 60 * 60 * 1000);

// 7. MAIN SERVER
async function checkWallets() {
  try {
    for (const wallet of WALLETS) {
      await checkWalletTransactions(wallet);
    }
  } catch (error) {
    console.error("CheckWallets error:", error);
  }
}

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    status: 'online',
    wallets: WALLETS.length,
    lastChecked: new Date().toISOString()
  }));
}).listen(process.env.PORT || 10000, () => {
  console.log(`Server running on port ${process.env.PORT || 10000}`);
  checkWallets();
  setInterval(checkWallets, CHECK_INTERVAL);
});
