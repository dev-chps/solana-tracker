const http = require('http');
const { Connection, PublicKey } = require('@solana/web3.js');
const axios = require('axios');

// Configuration
const RPC_URL = process.env.RPC_URL || 'https://api.mainnet-beta.solana.com';
const WALLETS = process.env.WALLETS ? process.env.WALLETS.split(',') : [];
const TG_TOKEN = process.env.TG_TOKEN;
const TG_CHAT_ID = process.env.TG_CHAT_ID;
const TEST_TOKEN = process.env.TEST_TOKEN || "default-secret";
const MIN_SOL_AMOUNT = process.env.MIN_SOL_AMOUNT ? parseFloat(process.env.MIN_SOL_AMOUNT) : 10;
const MIN_WALLETS = process.env.MIN_WALLETS ? parseInt(process.env.MIN_WALLETS) : 3;
const CHECK_INTERVAL = process.env.CHECK_INTERVAL ? parseInt(process.env.CHECK_INTERVAL) : 30 * 60 * 1000; // 30 minutes

// Initialize Solana connection
const connection = new Connection(RPC_URL, {
  commitment: 'confirmed',
  httpHeaders: { 'maxSupportedTransactionVersion': 0 }
});

// Trackers
const tokenTracker = {};
const processedTxs = new Set();

/**
 * Sends alert to Telegram
 * @param {string} message - The alert message to send
 */
async function sendTelegramAlert(message) {
  if (!TG_TOKEN || !TG_CHAT_ID) {
    console.warn("Telegram credentials not configured - alert would be:", message);
    return;
  }

  try {
    await axios.post(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      chat_id: TG_CHAT_ID,
      text: message,
      parse_mode: 'Markdown'
    });
    console.log("Telegram alert sent successfully");
  } catch (error) {
    console.error("Failed to send Telegram alert:", error.message);
  }
}

/**
 * Fetches token name from mint address
 * @param {string} mintAddress - The token mint address
 * @returns {Promise<string>} - Token name or mint address if not found
 */
async function fetchTokenName(mintAddress) {
  try {
    const response = await axios.get(`https://api.solscan.io/token/${mintAddress}`);
    return response.data.data.tokenName || mintAddress;
  } catch (error) {
    console.error(`Error fetching token name for ${mintAddress}:`, error.message);
    return mintAddress;
  }
}

/**
 * Checks all configured wallets for balances and transactions
 */
async function checkWallets() {
  try {
    console.log("🚀 Starting wallet checks...");
    
    // Check if we have enough wallets configured
    if (WALLETS.length < MIN_WALLETS) {
      const warning = `⚠️ Only ${WALLETS.length} wallets configured (minimum ${MIN_WALLETS} recommended)`;
      console.warn(warning);
      await sendTelegramAlert(warning);
    }

    // Check each wallet's balance and recent activity
    for (const wallet of WALLETS) {
      try {
        const publicKey = new PublicKey(wallet);
        
        // Check SOL balance
        const balance = await connection.getBalance(publicKey);
        const solBalance = balance / 10**9; // Convert lamports to SOL
        
        console.log(`💰 Wallet ${wallet.slice(0, 4)}...${wallet.slice(-4)} balance: ${solBalance.toFixed(2)} SOL`);
        
        if (solBalance < MIN_SOL_AMOUNT) {
          const alertMsg = `⚠️ Low balance alert: Wallet ${wallet.slice(0, 4)}...${wallet.slice(-4)} has only ${solBalance.toFixed(2)} SOL (minimum ${MIN_SOL_AMOUNT} SOL recommended)`;
          await sendTelegramAlert(alertMsg);
        }

        // Check recent transactions (last 5)
        const transactions = await connection.getConfirmedSignaturesForAddress2(publicKey, { limit: 5 });
        
        for (const tx of transactions) {
          if (processedTxs.has(tx.signature)) continue;
          
          const txDetails = await connection.getParsedTransaction(tx.signature);
          await analyzeTransaction(txDetails, wallet);
          processedTxs.add(tx.signature);
        }
      } catch (error) {
        console.error(`❌ Error checking wallet ${wallet}:`, error.message);
      }
    }
  } catch (error) {
    console.error("❌ Error in checkWallets:", error);
    await sendTelegramAlert(`🛑 Critical error in wallet checks: ${error.message}`);
  }
}

/**
 * Analyzes transaction for token movements
 * @param {object} transaction - The parsed transaction
 * @param {string} walletAddress - The wallet address
 */
async function analyzeTransaction(transaction, walletAddress) {
  if (!transaction || !transaction.message || !transaction.message.instructions) return;

  for (const instruction of transaction.message.instructions) {
    if (instruction.parsed && instruction.parsed.type === 'transfer') {
      const tokenMint = instruction.parsed.info.mint;
      const amount = instruction.parsed.info.tokenAmount.uiAmount;
      const symbol = instruction.parsed.info.tokenAmount.symbol || await fetchTokenName(tokenMint);

      // Track token movements
      if (!tokenTracker[tokenMint]) {
        tokenTracker[tokenMint] = {
          count: 0,
          wallets: new Set(),
          amount: 0,
          symbol: symbol
        };
      }

      tokenTracker[tokenMint].count++;
      tokenTracker[tokenMint].wallets.add(walletAddress);
      tokenTracker[tokenMint].amount += amount;

      // Check if threshold is reached
      if (tokenTracker[tokenMint].count >= 3) {
        const alertMsg = `🚨 Token movement detected!\n` +
                        `Token: ${tokenTracker[tokenMint].symbol}\n` +
                        `Count: ${tokenTracker[tokenMint].count} transactions\n` +
                        `Amount: ${tokenTracker[tokenMint].amount.toFixed(2)}\n` +
                        `Wallets: ${Array.from(tokenTracker[tokenMint].wallets).map(w => w.slice(0, 4) + '...' + w.slice(-4)).join(', ')}`;
        
        await sendTelegramAlert(alertMsg);
        tokenTracker[tokenMint].count = 0; // Reset after alert
      }
    }
  }
}

// HTTP Server with test endpoint
const server = http.createServer(async (req, res) => {
  // Test endpoint
  if (req.method === 'POST' && req.url === '/trigger-test') {
    if (req.headers['x-test-token'] !== TEST_TOKEN) {
      res.writeHead(403);
      return res.end("Access denied");
    }

    try {
      await sendTelegramAlert("🔔 Test alert: System is functioning normally");
      res.writeHead(200);
      res.end("Test alert sent successfully!");
    } catch (error) {
      res.writeHead(500);
      res.end("Error: " + error.message);
    }
    return;
  }

  // Health check endpoint
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      status: 'online',
      wallets: WALLETS.length,
      lastChecked: new Date().toISOString()
    }));
  }

  // Default response
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ 
    status: 'online',
    endpoints: {
      test: 'POST /trigger-test',
      health: 'GET /health'
    }
  }));
}).listen(process.env.PORT || 3000, () => {
  console.log(`🚀 Server ready on port ${process.env.PORT || 3000}`);
  checkWallets();
  setInterval(checkWallets, CHECK_INTERVAL);
});

// Handle process termination
process.on('SIGTERM', () => {
  console.log('🛑 Received SIGTERM, shutting down gracefully');
  server.close(() => {
    console.log('🔴 Server closed');
    process.exit(0);
  });
});
