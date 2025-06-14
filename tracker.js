const http = require('http');
const { Connection, PublicKey, LAMPORTS_PER_SOL } = require('@solana/web3.js');
const axios = require('axios');

// Configuration
const RPC_URL = process.env.RPC_URL || 'https://api.mainnet-beta.solana.com';
const WALLETS = process.env.WALLETS ? process.env.WALLETS.split(',') : [];
const TG_TOKEN = process.env.TG_TOKEN;
const TG_CHAT_ID = process.env.TG_CHAT_ID;
const TEST_TOKEN = process.env.TEST_TOKEN || "default-secret";
const CHECK_INTERVAL = process.env.CHECK_INTERVAL ? parseInt(process.env.CHECK_INTERVAL) : 5 * 60 * 1000; // 5 minutes

// Thresholds
const LARGE_PURCHASE_THRESHOLD = 1000; // $1000
const SOL_THRESHOLD = 10; // 10 SOL
const MIN_WALLETS_SAME_TOKEN = 3; // Alert when 3+ wallets buy same token

// Token addresses
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const SOL_MINT = 'So11111111111111111111111111111111111111112';

// Initialize Solana connection
const connection = new Connection(RPC_URL, 'confirmed');

// Trackers
const tokenPurchases = {};
const processedTxs = new Set();
let tokenPrices = {
  [USDC_MINT]: 1,
  [SOL_MINT]: null
};

// Helper functions
async function fetchSOLPrice() {
  try {
    const response = await axios.get('https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd');
    tokenPrices[SOL_MINT] = response.data.solana.usd;
  } catch (error) {
    console.error("Error fetching SOL price:", error.message);
  }
}

async function sendTelegramAlert(message) {
  if (!TG_TOKEN || !TG_CHAT_ID) return;
  
  try {
    await axios.post(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      chat_id: TG_CHAT_ID,
      text: message,
      parse_mode: 'Markdown'
    });
  } catch (error) {
    console.error("Telegram alert failed:", error.message);
  }
}

async function getTokenInfo(mintAddress) {
  try {
    const response = await axios.get(`https://token-api.solana.fm/v1/tokens/${mintAddress}`);
    return {
      symbol: response.data.symbol || mintAddress.slice(0, 4) + '...' + mintAddress.slice(-4),
      decimals: response.data.decimals || 9
    };
  } catch {
    return {
      symbol: mintAddress.slice(0, 4) + '...' + mintAddress.slice(-4),
      decimals: 9
    };
  }
}

// Transaction analysis
async function checkWalletTransactions(wallet) {
  try {
    const pubkey = new PublicKey(wallet);
    const signatures = await connection.getSignaturesForAddress(pubkey, {
      limit: 15
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

  for (const ix of tx.transaction.message.instructions) {
    // Token transfers
    if (ix.parsed?.type === 'transfer' || ix.parsed?.type === 'transferChecked') {
      await handleTokenTransfer(ix.parsed, wallet);
    }
    // Swap detection (Raydium, Orca, etc.)
    else if (ix.programId?.toString() === '9W959DqEETiGZocYWCQPaJ6sBmUzgfxXfqGeTEdp3aQP' || // Raydium
             ix.programId?.toString() === '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin') { // Serum
      await handleSwap(tx, wallet);
    }
  }
}

async function handleTokenTransfer(parsedIx, wallet) {
  const { mint, tokenAmount } = parsedIx.info;
  const amount = tokenAmount.uiAmount;
  const { symbol, decimals } = await getTokenInfo(mint);
  
  // Calculate USD value
  let usdValue = 0;
  if (tokenPrices[mint]) {
    usdValue = amount * tokenPrices[mint];
  } else if (mint === USDC_MINT) {
    usdValue = amount;
  }

  // Check thresholds
  if ((mint === SOL_MINT && amount >= SOL_THRESHOLD) ||
      (mint === USDC_MINT && amount >= LARGE_PURCHASE_THRESHOLD) ||
      (usdValue >= LARGE_PURCHASE_THRESHOLD)) {
    const msg = `🚨 Large ${symbol} ${parsedIx.type}!\n` +
                `Wallet: ${shortAddress(wallet)}\n` +
                `Amount: ${amount.toFixed(decimals)} ${symbol}\n` +
                `Value: $${usdValue.toFixed(2)}`;
    await sendTelegramAlert(msg);
  }

  // Track token purchases
  if (!tokenPurchases[mint]) {
    tokenPurchases[mint] = { symbol, wallets: new Set(), count: 0 };
  }
  
  tokenPurchases[mint].wallets.add(wallet);
  tokenPurchases[mint].count++;
  
  if (tokenPurchases[mint].wallets.size >= MIN_WALLETS_SAME_TOKEN) {
    const msg = `🚨 ${MIN_WALLETS_SAME_TOKEN}+ Wallets Buying ${symbol}!\n` +
                `Wallets: ${tokenPurchases[mint].wallets.size}\n` +
                `Transactions: ${tokenPurchases[mint].count}`;
    await sendTelegramAlert(msg);
    tokenPurchases[mint] = { symbol, wallets: new Set(), count: 0 };
  }
}

async function handleSwap(tx, wallet) {
  try {
    // Extract swap details from transaction
    const preTokenBalances = tx.meta.preTokenBalances;
    const postTokenBalances = tx.meta.postTokenBalances;
    
    if (!preTokenBalances || !postTokenBalances) return;

    // Compare balances to find swapped tokens
    const changes = {};
    for (let i = 0; i < postTokenBalances.length; i++) {
      const pre = preTokenBalances[i]?.uiTokenAmount.uiAmount || 0;
      const post = postTokenBalances[i]?.uiTokenAmount.uiAmount || 0;
      const diff = post - pre;
      
      if (Math.abs(diff) > 0) {
        const mint = postTokenBalances[i].mint;
        const { symbol } = await getTokenInfo(mint);
        changes[mint] = {
          symbol,
          change: diff,
          decimals: postTokenBalances[i]?.uiTokenAmount.decimals || 9
        };
      }
    }

    // Check if significant swap occurred
    const tokens = Object.keys(changes);
    if (tokens.length >= 2) {
      const tokenA = changes[tokens[0]];
      const tokenB = changes[tokens[1]];
      
      // Check if either side of swap meets threshold
      const usdValueA = tokenPrices[tokens[0]] ? 
        Math.abs(tokenA.change) * tokenPrices[tokens[0]] : 0;
      const usdValueB = tokenPrices[tokens[1]] ? 
        Math.abs(tokenB.change) * tokenPrices[tokens[1]] : 0;
      
      if (usdValueA >= LARGE_PURCHASE_THRESHOLD || usdValueB >= LARGE_PURCHASE_THRESHOLD) {
        const msg = `🔀 Large Swap Detected!\n` +
                   `Wallet: ${shortAddress(wallet)}\n` +
                   `Sold: ${Math.abs(tokenA.change).toFixed(tokenA.decimals)} ${tokenA.symbol}\n` +
                   `Bought: ${Math.abs(tokenB.change).toFixed(tokenB.decimals)} ${tokenB.symbol}\n` +
                   `Value: ~$${Math.max(usdValueA, usdValueB).toFixed(2)}`;
        await sendTelegramAlert(msg);
      }
    }
  } catch (error) {
    console.error("Error analyzing swap:", error);
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
