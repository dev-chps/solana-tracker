const http = require('http');
const axios = require('axios');
const { Connection, PublicKey } = require('@solana/web3.js');

// Simple but effective rate limiting
let lastCallTime = 0;
axios.interceptors.request.use(async (config) => {
  const now = Date.now();
  const delay = Math.max(0, 1000 - (now - lastCallTime)); // 1 second between requests
  await new Promise(resolve => setTimeout(resolve, delay));
  lastCallTime = now;
  return config;
});

// Rest of your existing tracker code below...
// (Keep all your wallet tracking logic here)


// Configuration
const RPC_URL = process.env.RPC_URL || 'https://api.mainnet-beta.solana.com';
const WALLETS = process.env.WALLETS ? process.env.WALLETS.split(',') : [];
const TG_TOKEN = process.env.TG_TOKEN;
const TG_CHAT_ID = process.env.TG_CHAT_ID;
const CHECK_INTERVAL = process.env.CHECK_INTERVAL ? parseInt(process.env.CHECK_INTERVAL) : 5 * 60 * 1000; // 5 minutes
const SOL_PRICE_API = 'https://price.jup.ag/v4/price?ids=SOL';

// Initialize Solana connection
const connection = new Connection(RPC_URL, 'confirmed');

// Trackers
const tokenPurchases = {};
const processedTxs = new Set();
let solPrice = 0;

// Helper functions
async function fetchSOLPrice() {
  try {
    const response = await httpClient.get(SOL_PRICE_API);
    solPrice = response.data.data.SOL.price;
    console.log(`Current SOL price: $${solPrice}`);
  } catch (error) {
    console.error("Error fetching SOL price:", error.message);
    // Fallback price if API fails
    solPrice = 20;
  }
}

async function sendTelegramAlert(message) {
  if (!TG_TOKEN || !TG_CHAT_ID) {
    console.log("Telegram alert would be:", message);
    return;
  }

  try {
    await httpClient.post(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
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
    // Try Jupiter API first
    const response = await httpClient.get(`https://token.jup.ag/strict/${mintAddress}`);
    return {
      address: mintAddress,
      symbol: response.data.symbol,
      name: response.data.name,
      decimals: response.data.decimals,
      logoURI: response.data.logoURI,
      verified: true
    };
  } catch (error) {
    // Fallback to on-chain data if Jupiter fails
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

  // Check for token transfers
  for (const ix of tx.transaction.message.instructions) {
    if (ix.parsed?.type === 'transfer' || ix.parsed?.type === 'transferChecked') {
      await handleTokenTransfer(ix.parsed, wallet, tx);
    }
  }

  // Check for swaps
  if (tx.meta?.preTokenBalances && tx.meta?.postTokenBalances) {
    await detectSwaps(tx, wallet);
  }
}

async function handleTokenTransfer(parsedIx, wallet, tx) {
  try {
    const { mint, tokenAmount, destination } = parsedIx.info;
    
    // Skip if no token amount data
    if (!tokenAmount || tokenAmount.uiAmount === undefined) return;
    
    const amount = tokenAmount.uiAmount;
    const { address, symbol, name, decimals, logoURI, verified } = await getTokenDetails(mint);

    // Check if this is an incoming transfer (purchase)
    if (destination === wallet) {
      const message = `🛒 *Token Purchase Detected!*\n` +
                     `▸ Wallet: \`${shortAddress(wallet)}\`\n` +
                     `▸ Token: [${symbol} (${name})](${logoURI || `https://solscan.io/token/${address}`})\n` +
                     `▸ Token Address: \`${address}\`\n` +
                     `▸ Amount: ${amount.toFixed(decimals)} ${symbol}\n` +
                     `▸ [View Transaction](https://solscan.io/tx/${tx.transaction.signatures[0]})` +
                     `${!verified ? '\n⚠️ *Unverified Token* - Do your research!' : ''}`;
      
      await sendTelegramAlert(message);

      // Track token purchases across wallets
      if (!tokenPurchases[mint]) {
        tokenPurchases[mint] = {
          symbol,
          name,
          address,
          wallets: new Set(),
          count: 0
        };
      }

      tokenPurchases[mint].wallets.add(wallet);
      tokenPurchases[mint].count++;

      // Alert if multiple wallets buying same token
      if (tokenPurchases[mint].wallets.size >= 3) {
        const coordMessage = `🚨 *Coordinated Buying Detected!*\n` +
                            `▸ Token: [${symbol} (${name})](${logoURI || `https://solscan.io/token/${address}`})\n` +
                            `▸ Token Address: \`${address}\`\n` +
                            `▸ Wallets: ${tokenPurchases[mint].wallets.size}\n` +
                            `▸ Total Purchases: ${tokenPurchases[mint].count}\n` +
                            `▸ [View Token](https://solscan.io/token/${address})` +
                            `${!verified ? '\n⚠️ *Unverified Token* - Exercise caution!' : ''}`;
        await sendTelegramAlert(coordMessage);
        tokenPurchases[mint].wallets.clear();
        tokenPurchases[mint].count = 0;
      }
    }
  } catch (error) {
    console.error('Error in handleTokenTransfer:', error);
  }
}

async function detectSwaps(tx, wallet) {
  try {
    const preBalances = tx.meta.preTokenBalances;
    const postBalances = tx.meta.postTokenBalances;

    // Find token balance changes
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

    // Check if this was a swap (one token in, another out)
    const changedTokens = Object.keys(changes);
    if (changedTokens.length === 2) {
      const [tokenA, tokenB] = Object.values(changes);
      let tokenIn, tokenOut;
      
      // Determine which token was bought vs sold
      if (tokenA.change > 0 && tokenB.change < 0) {
        tokenOut = tokenA;
        tokenIn = tokenB;
      } else if (tokenA.change < 0 && tokenB.change > 0) {
        tokenOut = tokenB;
        tokenIn = tokenA;
      } else {
        return; // Not a clean swap
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
