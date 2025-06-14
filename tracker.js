const http = require('http');
const { Connection, PublicKey } = require('@solana/web3.js');
const axios = require('axios');

// Configuration
const RPC_URL = process.env.RPC_URL || 'https://api.mainnet-beta.solana.com';
const WALLETS = process.env.WALLETS ? process.env.WALLETS.split(',') : [];
const TG_TOKEN = process.env.TG_TOKEN;
const TG_CHAT_ID = process.env.TG_CHAT_ID;
const TEST_TOKEN = process.env.TEST_TOKEN || "default-secret";
const CHECK_INTERVAL = process.env.CHECK_INTERVAL ? parseInt(process.env.CHECK_INTERVAL) : 5 * 60 * 1000; // 5 minutes

// Token addresses
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const SOL_MINT = 'So11111111111111111111111111111111111111112';

// Initialize Solana connection
const connection = new Connection(RPC_URL, 'confirmed');

// Trackers
const tokenPurchases = {};
const processedTxs = new Set();
let solPrice = 0;

// Helper functions
async function fetchSOLPrice() {
  try {
    const response = await axios.get('https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd');
    solPrice = response.data.solana.usd;
    console.log(`Current SOL price: $${solPrice}`);
  } catch (error) {
    console.error("Error fetching SOL price:", error.message);
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
      parse_mode: 'Markdown'
    });
  } catch (error) {
    console.error("Failed to send Telegram alert:", error.message);
  }
}

async function getTokenDetails(mintAddress) {
  try {
    // Try Jupiter API first
    const jupResponse = await axios.get(`https://token.jup.ag/strict/${mintAddress}`);
    if (jupResponse.data) {
      return {
        symbol: jupResponse.data.symbol,
        name: jupResponse.data.name,
        decimals: jupResponse.data.decimals,
        logoURI: jupResponse.data.logoURI
      };
    }
  } catch (jupError) {
    // Fallback to Solana FM
    try {
      const fmResponse = await axios.get(`https://api.solana.fm/v1/tokens/${mintAddress}`);
      return {
        symbol: fmResponse.data.symbol || `UNKNOWN (${mintAddress.slice(0, 4)}..${mintAddress.slice(-4)})`,
        name: fmResponse.data.name || 'Unknown Token',
        decimals: fmResponse.data.decimals || 9,
        logoURI: fmResponse.data.image || ''
      };
    } catch (fmError) {
      return {
        symbol: `UNKNOWN (${mintAddress.slice(0, 4)}..${mintAddress.slice(-4)})`,
        name: 'Unknown Token',
        decimals: 9,
        logoURI: ''
      };
    }
  }
}

async function checkWalletTransactions(wallet) {
  try {
    const pubkey = new PublicKey(wallet);
    const signatures = await connection.getSignaturesForAddress(pubkey, {
      limit: 10
    });

    for (const { signature } of signatures) {
      if (processedTxs.has(signature)) continue;
      
      const tx = await connection.getParsedTransaction(signature, {
        maxSupportedTransactionVersion: 0
      });
      
      await analyzeTransaction(tx, wallet);
      processedTxs.add(signature);
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
  const { mint, tokenAmount, destination } = parsedIx.info;
  const amount = tokenAmount.uiAmount;
  const { symbol, name, decimals, logoURI } = await getTokenDetails(mint);

  // Calculate USD value
  let usdValue = 0;
  if (mint === USDC_MINT) {
    usdValue = amount;
  } else if (mint === SOL_MINT) {
    usdValue = amount * solPrice;
  } else {
    // For other tokens, we'd need a price API - you can add this later
    usdValue = 0;
  }

  // Check if this is an incoming transfer (purchase)
  if (destination === wallet) {
    const message = `🛒 Token Purchase Detected!\n` +
                   `Wallet: ${shortAddress(wallet)}\n` +
                   `Token: ${symbol} (${name})\n` +
                   `Amount: ${amount.toFixed(decimals)} ${symbol}\n` +
                   `Value: ${usdValue > 0 ? '$' + usdValue.toFixed(2) : 'Unknown'}\n` +
                   `${logoURI ? `[Token Logo](${logoURI})` : ''}\n` +
                   `[View Transaction](https://solscan.io/tx/${tx.transaction.signatures[0]})`;
    
    await sendTelegramAlert(message);

    // Track token purchases across wallets
    if (!tokenPurchases[mint]) {
      tokenPurchases[mint] = {
        symbol,
        wallets: new Set(),
        count: 0
      };
    }

    tokenPurchases[mint].wallets.add(wallet);
    tokenPurchases[mint].count++;

    // Alert if multiple wallets buying same token
    if (tokenPurchases[mint].wallets.size >= 3) {
      const coordMessage = `🚨 Coordinated Buying Detected!\n` +
                          `Token: ${symbol} (${name})\n` +
                          `Wallets: ${tokenPurchases[mint].wallets.size}\n` +
                          `Total Purchases: ${tokenPurchases[mint].count}\n` +
                          `${logoURI ? `[Token Logo](${logoURI})` : ''}`;
      await sendTelegramAlert(coordMessage);
      tokenPurchases[mint].wallets.clear();
      tokenPurchases[mint].count = 0;
    }
  }
}

async function detectSwaps(tx, wallet) {
  const preBalances = tx.meta.preTokenBalances;
  const postBalances = tx.meta.postTokenBalances;

  // Find token balance changes
  const changes = {};
  for (const balance of postBalances) {
    const pre = preBalances.find(b => b.mint === balance.mint && b.owner === balance.owner);
    const preAmount = pre?.uiTokenAmount.uiAmount || 0;
    const postAmount = balance.uiTokenAmount.uiAmount;
    const diff = postAmount - preAmount;

    if (Math.abs(diff) > 0) {
      const { symbol, name, decimals, logoURI } = await getTokenDetails(balance.mint);
      changes[balance.mint] = {
        symbol,
        name,
        change: diff,
        decimals,
        logoURI
      };
    }
  }

  // Check if this was a swap (one token in, another out)
  const changedTokens = Object.keys(changes);
  if (changedTokens.length === 2) {
    const [tokenIn, tokenOut] = Object.values(changes);
    
    // Only alert if significant swap
    if (Math.abs(tokenIn.change) > 10 || Math.abs(tokenOut.change) > 10) {
      const message = `🔀 Swap Detected!\n` +
                     `Wallet: ${shortAddress(wallet)}\n` +
                     `Sold: ${Math.abs(tokenIn.change).toFixed(tokenIn.decimals)} ${tokenIn.symbol}\n` +
                     `Bought: ${Math.abs(tokenOut.change).toFixed(tokenOut.decimals)} ${tokenOut.symbol}\n` +
                     `${tokenOut.logoURI ? `[Token Logo](${tokenOut.logoURI})` : ''}\n` +
                     `[View Transaction](https://solscan.io/tx/${tx.transaction.signatures[0]})`;
      
      await sendTelegramAlert(message);
    }
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
