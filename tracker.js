const http = require('http');
const { Connection, PublicKey } = require('@solana/web3.js');
const axios = require('axios');

// Config
const RPC_URL = process.env.RPC_URL;
const WALLETS = process.env.WALLETS.split(',');
const TG_TOKEN = process.env.TG_TOKEN;
const TG_CHAT_ID = process.env.TG_CHAT_ID;
const MIN_SOL_AMOUNT = 10; // Filtre les TX > 10 SOL
const MIN_WALLETS = 3; // Nombre minimal de wallets pour alerter
const connection = new Connection(RPC_URL, {
  commitment: 'confirmed',
  httpHeaders: { 'maxSupportedTransactionVersion': 0 }
});

// Dictionnaire pour tracker les tokens
const tokenTracker = {};
const processedTxs = new Set(); // Évite les doublons

// Fonction pour récupérer le nom des tokens
async function fetchTokenName(mintAddress) {
  try {
    const response = await axios.get('https://token-list-api.solana.com/token/' + mintAddress);
    return response.data.name || mintAddress.substring(0, 6) + '...';
  } catch {
    return mintAddress.substring(0, 6) + '...';
  }
}

// Analyse détaillée des transactions
async function analyzeTransaction(signature, wallet) {
  if (processedTxs.has(signature)) return null;
  processedTxs.add(signature);

  try {
    const tx = await connection.getParsedTransaction(signature);
    if (!tx) return null;

    const transferInstruction = tx.transaction.message.instructions.find(ix => 
      ix.programId?.equals(new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA")) &&
      ix.parsed?.type === 'transfer' &&
      ix.parsed?.info?.destination === wallet
    );

    if (!transferInstruction) return null;

    const amount = transferInstruction.parsed.info.amount / 1e9; // Conversion en SOL
    if (amount < MIN_SOL_AMOUNT) return null;

    return {
      mint: transferInstruction.parsed.info.mint,
      amount: amount,
      signature: signature
    };
  } catch (error) {
    console.error(`❌ Erreur analyse TX ${signature.substring(0, 8)}: ${error.message}`);
    return null;
  }
}

// Fonction d'alerte Telegram améliorée
async function sendTelegramAlert(mint, data) {
  const tokenName = await fetchTokenName(mint);
  const msg = `🚨 *Achat groupé détecté!* (${data.count} wallets)\n\n` +
             `🪙 Token: ${tokenName}\n` +
             `📍 Contrat: \`${mint.substring(0, 6)}...\`\n` +
             `💰 Montant moyen: ${(data.amount/data.count).toFixed(2)} SOL\n` +
             `🔗 [Voir token](https://solscan.io/token/${mint})`;

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

// Vérification des wallets
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

// Serveur HTTP minimal
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    status: 'running',
    tracked_wallets: WALLETS.length,
    last_scan: new Date().toISOString()
  }));
}).listen(process.env.PORT || 3000, () => {
  console.log(`🌐 Server running on port ${process.env.PORT || 3000}`);
  console.log(`⏳ Starting initial scan...`);
  
  // Premier scan immédiat puis toutes les 30 min
  checkWallets();
  setInterval(checkWallets, 30 * 60 * 1000);
});
