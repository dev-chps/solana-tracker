const http = require('http');
const { Connection, PublicKey } = require('@solana/web3.js');
const axios = require('axios');

// ======================
// CONFIGURATION
// ======================
const RPC_URL = process.env.RPC_URL;
const WALLETS = process.env.WALLETS.split(',');
const TG_TOKEN = process.env.TG_TOKEN;
const TG_CHAT_ID = process.env.TG_CHAT_ID;
const MIN_SOL_AMOUNT = 10;
const MIN_WALLETS = 3;

const connection = new Connection(RPC_URL, {
  commitment: 'confirmed',
  httpHeaders: {
    'Content-Type': 'application/json',
    'maxSupportedTransactionVersion': 0
  }
});

const tokenTracker = {};
const processedTxs = new Set(); // Déclaration UNIQUE ici

// ======================
// FONCTIONS PRINCIPALES
// ======================

async function fetchTokenName(mintAddress) {
  try {
    const response = await axios.get(`https://token-list-api.solana.com/token/${mintAddress}`);
    return response.data.name || mintAddress.substring(0, 6) + '...';
  } catch {
    return mintAddress.substring(0, 6) + '...';
  }
}

async function analyzeTransaction(signature, wallet) {
  if (processedTxs.has(signature)) return null;
  processedTxs.add(signature);

  try {
    const tx = await connection.getParsedTransaction(signature, {
      maxSupportedTransactionVersion: 0
    });

    if (!tx) return null;

    const transfer = tx.transaction.message.instructions.find(ix => 
      ix.programId?.equals(new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA")) &&
      ix.parsed?.type === 'transfer' &&
      ix.parsed?.info?.destination === wallet
    );

    if (!transfer?.parsed?.info?.amount) return null;

    const amountSol = transfer.parsed.info.amount / 1e9;
    return amountSol >= MIN_SOL_AMOUNT ? {
      mint: transfer.parsed.info.mint,
      amount: amountSol,
      signature: signature
    } : null;

  } catch (error) {
    console.error(`❌ TX ${signature.substring(0, 8)}: ${error.message}`);
    return null;
  }
}

async function sendTelegramAlert(mint, data) {
  const tokenName = await fetchTokenName(mint);
  const msg = `🚨 *Achat groupé détecté!*\n\n` +
             `🪙 Token: ${tokenName}\n` +
             `👛 Wallets: ${data.count} (${data.wallets.slice(0, 3).map(w => w.substring(0, 6)).join(', ')}...)\n` +
             `💰 Montant moyen: ${(data.amount/data.count).toFixed(2)} SOL\n` +
             `🔍 [Voir token](https://solscan.io/token/${mint})`;

  try {
    await axios.post(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      chat_id: TG_CHAT_ID,
      text: msg,
      parse_mode: 'Markdown',
      disable_web_page_preview: true
    });
    console.log(`📤 Alert sent for ${tokenName}`);
  } catch (error) {
    console.error('❌ Erreur Telegram:', error.message);
  }
}

async function checkWallets() {
  console.log(`\n🔍 Scanning ${WALLETS.length} wallets...`);
  
  for (const wallet of WALLETS) {
    try {
      console.log(`  Checking ${wallet.substring(0, 6)}...`);
      const txs = await connection.getSignaturesForAddress(new PublicKey(wallet), { limit: 5 });
      
      for (const tx of txs) {
        const transfer = await analyzeTransaction(tx.signature, wallet);
        if (!transfer) continue;

        console.log(`    ✅ TX ${tx.signature.substring(0, 8)}: ${transfer.amount} SOL`);

        if (!tokenTracker[transfer.mint]) {
          tokenTracker[transfer.mint] = {
            count: 1,
            wallets: [wallet],
            amount: transfer.amount
          };
        } else {
          tokenTracker[transfer.mint].count += 1;
          tokenTracker[transfer.mint].wallets.push(wallet);
          tokenTracker[transfer.mint].amount += transfer.amount;

          if (tokenTracker[transfer.mint].count === MIN_WALLETS) {
            await sendTelegramAlert(transfer.mint, tokenTracker[transfer.mint]);
          }
        }
      }
    } catch (error) {
      console.error(`❌ Error on ${wallet.substring(0, 6)}: ${error.message}`);
    }
  }
}

// ======================
// SERVEUR HTTP
// ======================
const server = http.createServer(async (req, res) => {
  // Nouvelle route pour les tests manuels
  if (req.method === 'POST' && req.url === '/trigger-alert') {
    try {
      const testMint = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"; // USDC exemple
      await sendTelegramAlert(testMint, {
        count: 3,
        wallets: ["7o1UnD...", "HSQEzV...", "GDKVNs..."],
        amount: 45.67
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: "Test alert sent" }));
    } catch (error) {
      res.writeHead(500);
      res.end("Error sending test alert");
    }
    return;
  }

  // Route existante (keep this)
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    status: 'running',
    tracked_wallets: WALLETS.length,
    last_scan: new Date().toISOString()
  }));
}).listen(process.env.PORT || 3000, () => {
  console.log(`🌐 Server running on port ${process.env.PORT || 3000}`);
  // ... (votre code existant)
});
