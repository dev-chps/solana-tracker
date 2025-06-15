const dailyTokenPurchases = {};
const http = require('http');
const axios = require('axios');
const { Connection, PublicKey } = require('@solana/web3.js');
// Enhanced rate limiting
let lastSolPriceCheck = 0;
async function safeFetchSOLPrice() {
  const now = Date.now();
  const minDelay = 30000; // 30 seconds between price checks
  
  if (now - lastSolPriceCheck < minDelay) {
    return solPrice; // Return cached value
  }

  lastSolPriceCheck = now;
  await fetchSOLPrice();
  return solPrice;
}
// 1. Rate Limiting Setup
let lastRequestTime = 0;
axios.interceptors.request.use(async (config) => {
  const now = Date.now();
  const delay = Math.max(0, 1000 - (now - lastRequestTime));
  await new Promise(resolve => setTimeout(resolve, delay));
  lastRequestTime = now;
  return config;
});

// 2. Configuration
const RPC_URL = process.env.RPC_URL || 'https://api.mainnet-beta.solana.com';
const WALLETS = process.env.WALLETS ? process.env.WALLETS.split(',') : [];
const TG_TOKEN = process.env.TG_TOKEN;
const TG_CHAT_ID = process.env.TG_CHAT_ID;
const CHECK_INTERVAL = process.env.CHECK_INTERVAL || 5 * 60 * 1000; // 5 minutes
const SOL_PRICE_API = 'https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd';

// 3. Initialize Connection
const connection = new Connection(RPC_URL, 'confirmed');
let solPrice = 0;

// 4. Helper Functions
async function fetchSOLPrice() {
  try {
    // Try multiple price sources with fallbacks
    const sources = [
      'https://price.jup.ag/v4/price?ids=SOL',
      'https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd',
      'https://api.binance.com/api/v3/ticker/price?symbol=SOLUSDT'
    ];

    for (const url of sources) {
      try {
        const response = await axios.get(url, { timeout: 2000 });
        
        if (url.includes('jup.ag')) {
          solPrice = response.data.data.SOL.price;
        } 
        else if (url.includes('coingecko')) {
          solPrice = response.data.solana.usd;
        }
        else if (url.includes('binance')) {
          solPrice = parseFloat(response.data.price);
        }

        if (solPrice) {
          console.log(`SOL price: $${solPrice} (from ${new URL(url).hostname})`);
          return;
        }
      } catch (error) {
        console.log(`Failed ${url}: ${error.message}`);
      }
    }

    throw new Error('All price APIs failed');
    
  } catch (error) {
    console.error("Price fetch error:", error.message);
    solPrice = 20; // Fallback value
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
    console.error("Failed to send Telegram alert:", error.message);
  }
}

async function getTokenDetails(mintAddress) {
  try {
    const response = await axios.get(`https://token.jup.ag/strict/${mintAddress}`);
    return {
      address: mintAddress,
      symbol: response.data.symbol,
      name: response.data.name,
      decimals: response.data.decimals,
      logoURI: response.data.logoURI,
      verified: true
    };
  } catch (error) {
    try {
      const accountInfo = await connection.getParsedAccountInfo(new PublicKey(mintAddress));
      const details = accountInfo.value?.data?.parsed?.info;
      
      return {
        address: mintAddress,
        symbol: details?.symbol || `UNKNOWN (${shortAddress(mintAddress)})`,
        name: details?.name || 'Unknown Token',
        decimals: details?.decimals || 9,
        logoURI: '',
        verified: false
      };
    } catch (e) {
      return {
        address: mintAddress,
        symbol: `UNKNOWN (${shortAddress(mintAddress)})`,
        name: 'Unknown Token',
        decimals: 9,
        logoURI: '',
        verified: false
      };
    }
  }
}

async function checkWalletTransactions(wallet) {
  try {
    const pubkey = new PublicKey(wallet);
    const signatures = await connection.getSignaturesForAddress(pubkey, {
      limit: 15
    });

    for (const { signature } of signatures) {
      if (processedTxs.has(signature)) continue;
      
      try {
        const tx = await connection.getParsedTransaction(signature, {
          maxSupportedTransactionVersion: 0
        });
        
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
//begin new change 

// Modified handleTokenTransfer function
async function handleTokenTransfer(parsedIx, wallet, tx) {
  try {
    const { mint, tokenAmount, destination } = parsedIx.info;
    if (destination !== wallet || !tokenAmount?.uiAmount) return;

    const amount = tokenAmount.uiAmount;
    const { address, symbol, name, decimals, logoURI, verified } = await getTokenDetails(mint);
    const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD

    // Initialize daily tracking for this token
    if (!dailyTokenPurchases[today]) dailyTokenPurchases[today] = {};
    if (!dailyTokenPurchases[today][mint]) {
      dailyTokenPurchases[today][mint] = {
        symbol,
        name,
        address,
        wallets: new Set(),
        totalAmount: 0,
        firstPrice: null,
        lastPrice: null,
        transactions: []
      };
    }

    const tokenData = dailyTokenPurchases[today][mint];
    
    // Record transaction
    tokenData.wallets.add(wallet);
    tokenData.totalAmount += amount;
    tokenData.transactions.push({
      wallet: shortAddress(wallet),
      amount,
      timestamp: new Date().toISOString()
    });

    // Get token price (you'll need to implement this)
    const currentPrice = await getTokenPrice(mint); 
    if (!tokenData.firstPrice) tokenData.firstPrice = currentPrice;
    tokenData.lastPrice = currentPrice;

    // Check if we should alert (3+ unique wallets)
    if (tokenData.wallets.size >= 3) {
      const priceChange = tokenData.firstPrice 
        ? ((tokenData.lastPrice - tokenData.firstPrice) / tokenData.firstPrice * 100).toFixed(2)
        : 0;

      const message = `🚨 *Potential Gem Alert!* 🚨\n` +
                     `▸ Token: [${symbol} (${name})](${logoURI || `https://solscan.io/token/${address}`})\n` +
                     `▸ Address: \`${address}\`\n` +
                     `▸ Wallets: ${tokenData.wallets.size} (24h)\n` +
                     `▸ Total Volume: ${tokenData.totalAmount.toFixed(decimals)} ${symbol}\n` +
                     `▸ Price Change: ${priceChange}%\n` +
                     `▸ [View Token](${`https://dexscreener.com/solana/${address}`})\n` +
                     `${!verified ? '\n⚠️ *Unverified Token* - DYOR!' : ''}`;

      await sendTelegramAlert(message);
      
      // Reset after alert to avoid duplicates
      delete dailyTokenPurchases[today][mint];
    }
  } catch (error) {
    console.error('Error in handleTokenTransfer:', error);
  }
}

// Add this helper function
async function getTokenPrice(mintAddress) {
  try {
    // Use Jupiter API for price
    const response = await axios.get(`https://price.jup.ag/v4/price?ids=${mintAddress}`);
    return response.data.data[mintAddress]?.price || 0;
  } catch (error) {
    console.error(`Error getting price for ${mintAddress}:`, error.message);
    return 0;
  }
}  
          //end new change
async function detectSwaps(tx, wallet) {
  try {
    const preBalances = tx.meta.preTokenBalances;
    const postBalances = tx.meta.postTokenBalances;
    const changes = {};
    
    for (const balance of postBalances) {
      if (balance.owner !== wallet) continue;
      
      const pre = preBalances.find(b => b.mint === balance.mint && b.owner === balance.owner);
      const preAmount = pre?.uiTokenAmount?.uiAmount || 0;
      const postAmount = balance.uiTokenAmount?.uiAmount || 0;
      const diff = postAmount - preAmount;

      if (Math.abs(diff) > 0) {
        const { address, symbol, name, decimals, logoURI, verified } = await getTokenDetails(balance.mint);
        changes[balance.mint] = {
          address,
          symbol,
          name,
          change: diff,
          decimals,
          logoURI,
          verified
        };
      }
    }

    const changedTokens = Object.keys(changes);
    if (changedTokens.length === 2) {
      const [tokenA, tokenB] = Object.values(changes);
      let tokenIn, tokenOut;
      
      if (tokenA.change > 0 && tokenB.change < 0) {
        tokenOut = tokenA;
        tokenIn = tokenB;
      } else if (tokenA.change < 0 && tokenB.change > 0) {
        tokenOut = tokenB;
        tokenIn = tokenA;
      } else {
        return;
      }

      const message = `🔀 *Swap Detected!*\n` +
                     `▸ Wallet: \`${shortAddress(wallet)}\`\n` +
                     `▸ Sold: ${Math.abs(tokenIn.change).toFixed(tokenIn.decimals)} ${tokenIn.symbol}\n` +
                     `▸ Bought: ${Math.abs(tokenOut.change).toFixed(tokenOut.decimals)} ${tokenOut.symbol}\n` +
                     `▸ Token Address: \`${tokenOut.address}\`\n` +
                     `▸ Token: [${tokenOut.symbol} (${tokenOut.name})](${tokenOut.logoURI || `https://solscan.io/token/${tokenOut.address}`})\n` +
                     `▸ [View Transaction](https://solscan.io/tx/${tx.transaction.signatures[0]})` +
                     `${!tokenOut.verified ? '\n⚠️ *Unverified Token* - Research before trading!' : ''}`;
      
      await sendTelegramAlert(message);
    }
  } catch (error) {
    console.error('Error in detectSwaps:', error);
  }
}

function shortAddress(address, chars = 4) {
  return `${address.slice(0, chars)}...${address.slice(-chars)}`;
}

// Trackers
const tokenPurchases = {};
const processedTxs = new Set();

// Main function
async function checkWallets() {
  try {
    await fetchSOLPrice();
    for (const wallet of WALLETS) {
      await checkWalletTransactions(wallet);
    }
  } catch (error) {
    console.error("CheckWallets error:", error);
  }
}

// HTTP Server
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    status: 'online',
    wallets: WALLETS.length,
    lastChecked: new Date().toISOString()
  }));
}).listen(process.env.PORT || 3000, () => {
  console.log(`Server running on port ${process.env.PORT || 3000}`);
  checkWallets();
  setInterval(checkWallets, CHECK_INTERVAL);
});
