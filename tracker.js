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

// Price thresholds (in USD)
const LARGE_PURCHASE_THRESHOLD = 1000; // $1000
const SOL_THRESHOLD = 10; // 10 SOL

// Token addresses
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const SOL_MINT = 'So11111111111111111111111111111111111111112';

// Price cache
let tokenPrices = {
  [USDC_MINT]: 1, // USDC is pegged to $1
  [SOL_MINT]: null // Will fetch SOL price
};

// Initialize Solana connection
const connection = new Connection(RPC_URL, {
  commitment: 'confirmed',
  httpHeaders: { 'maxSupportedTransactionVersion': 0 }
});

// Trackers
const tokenPurchases = {}; // Tracks token buys across wallets
const processedTxs = new Set(); // Prevents duplicate processing

/**
 * Fetches current SOL price in USD
 */
async function fetchSOLPrice() {
  try {
    const response = await axios.get('https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd');
    tokenPrices[SOL_MINT] = response.data.solana.usd;
    console.log(`SOL price updated: $${tokenPrices[SOL_MINT]}`);
  } catch (error) {
    console.error("Error fetching SOL price:", error.message);
  }
}

/**
 * Sends alert to Telegram
 */
async function sendTelegramAlert(message) {
  if (!TG_TOKEN || !TG_CHAT_ID) {
    console.warn("Telegram not configured. Alert would be:", message);
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

/**
 * Gets token symbol from mint address
 */
async function getTokenSymbol(mintAddress) {
  const tokenMap = {
    [USDC_MINT]: 'USDC',
    [SOL_MINT]: 'SOL'
  };
  
  if (tokenMap[mintAddress]) return tokenMap[mintAddress];
  
  try {
    const response = await axios.get(`https://api.solscan.io/token/${mintAddress}`);
    return response.data.data.tokenSymbol || mintAddress.slice(0, 4) + '...' + mintAddress.slice(-4);
  } catch {
    return mintAddress.slice(0, 4) + '...' + mintAddress.slice(-4);
  }
}

/**
 * Checks wallet transactions for significant purchases
 */
async function checkWalletTransactions(wallet) {
  try {
    const publicKey = new PublicKey(wallet);
    const transactions = await connection.getConfirmedSignaturesForAddress2(publicKey, {
      limit: 10
    });

    for (const tx of transactions) {
      if (processedTxs.has(tx.signature)) continue;

      const txDetails = await connection.getParsedTransaction(tx.signature);
      await analyzeTransaction(txDetails, wallet);
      processedTxs.add(tx.signature);
    }
  } catch (error) {
    console.error(`Error checking transactions for ${wallet}:`, error.message);
  }
}

/**
 * Analyzes transaction for significant token purchases
 */
async function analyzeTransaction(transaction, wallet) {
  if (!transaction || !transaction.message || !transaction.message.instructions) return;

  for (const instruction of transaction.message.instructions) {
    if (instruction.parsed && instruction.parsed.type === 'transfer') {
      const tokenMint = instruction.parsed.info.mint;
      const amount = instruction.parsed.info.tokenAmount.uiAmount;
      const decimals = instruction.parsed.info.tokenAmount.decimals;
      const rawAmount = instruction.parsed.info.tokenAmount.amount;

      // Get token symbol
      const symbol = await getTokenSymbol(tokenMint);

      // Calculate USD value
      let usdValue = 0;
      if (tokenPrices[tokenMint]) {
        usdValue = amount * tokenPrices[tokenMint];
      }

      // Check for large purchases
      if (tokenMint === SOL_MINT && amount >= SOL_THRESHOLD) {
        const message = `🚨 Large SOL Purchase!\n` +
                       `Wallet: ${wallet.slice(0, 4)}...${wallet.slice(-4)}\n` +
                       `Amount: ${amount} SOL\n` +
                       `Value: ~$${usdValue.toFixed(2)}`;
        await sendTelegramAlert(message);
      }
      else if (tokenMint === USDC_MINT && amount >= LARGE_PURCHASE_THRESHOLD) {
        const message = `🚨 Large USDC Purchase!\n` +
                       `Wallet: ${wallet.slice(0, 4)}...${wallet.slice(-4)}\n` +
                       `Amount: ${amount} USDC`;
        await sendTelegramAlert(message);
      }
      else if (usdValue >= LARGE_PURCHASE_THRESHOLD) {
        const message = `🚨 Large Token Purchase!\n` +
                       `Wallet: ${wallet.slice(0, 4)}...${wallet.slice(-4)}\n` +
                       `Token: ${symbol}\n` +
                       `Amount: ${amount}\n` +
                       `Value: ~$${usdValue.toFixed(2)}`;
        await sendTelegramAlert(message);
      }

      // Track token purchases across wallets
      if (!tokenPurchases[tokenMint]) {
        tokenPurchases[tokenMint] = {
          symbol,
          wallets: new Set(),
          count: 0,
          totalAmount: 0
        };
      }

      tokenPurchases[tokenMint].wallets.add(wallet);
      tokenPurchases[tokenMint].count++;
      tokenPurchases[tokenMint].totalAmount += amount;

      // Check if 3+ wallets bought the same token
      if (tokenPurchases[tokenMint].wallets.size >= 3) {
        const message = `🚨 Multiple Wallets Buying Same Token!\n` +
                       `Token: ${symbol}\n` +
                       `Wallets: ${tokenPurchases[tokenMint].wallets.size}\n` +
                       `Total Transactions: ${tokenPurchases[tokenMint].count}\n` +
                       `Total Amount: ${tokenPurchases[tokenMint].totalAmount}`;
        await sendTelegramAlert(message);
        
        // Reset after alert
        tokenPurchases[tokenMint].wallets.clear();
        tokenPurchases[tokenMint].count = 0;
        tokenPurchases[tokenMint].totalAmount = 0;
      }
    }
  }
}

/**
 * Main checking function
 */
async function checkWallets() {
  try {
    console.log("🔄 Checking wallets...");
    await fetchSOLPrice(); // Update SOL price first

    for (const wallet of WALLETS) {
      await checkWalletTransactions(wallet);
    }
  } catch (error) {
    console.error("Error in checkWallets:", error);
    await sendTelegramAlert(`🛑 Error in wallet checks: ${error.message}`);
  }
}

// HTTP Server
const server = http.createServer(async (req, res) => {
  if (req.method === 'POST' && req.url === '/trigger-test') {
    if (req.headers['x-test-token'] !== TEST_TOKEN) {
      res.writeHead(403);
      return res.end("Access denied");
    }

    try {
      await sendTelegramAlert("🔔 Test alert: System is working normally");
      res.writeHead(200);
      res.end("Test alert sent!");
    } catch (error) {
      res.writeHead(500);
      res.end("Error: " + error.message);
    }
    return;
  }

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ 
    status: 'online',
    wallets: WALLETS.length,
    thresholds: {
      sol: SOL_THRESHOLD,
      usd: LARGE_PURCHASE_THRESHOLD
    }
  }));
}).listen(process.env.PORT || 3000, () => {
  console.log(`🚀 Server running on port ${process.env.PORT || 3000}`);
  checkWallets();
  setInterval(checkWallets, CHECK_INTERVAL);
});

process.on('SIGTERM', () => {
  server.close(() => {
    console.log('Server shutdown');
    process.exit(0);
  });
});
