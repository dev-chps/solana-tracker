const http = require('http');
const { Connection, PublicKey } = require('@solana/web3.js');
const axios = require('axios');

// Config
const RPC_URL = process.env.RPC_URL;
const WALLETS = process.env.WALLETS.split(',');
const TG_TOKEN = process.env.TG_TOKEN;
const TG_CHAT_ID = process.env.TG_CHAT_ID;
const MIN_SOL_AMOUNT = 10; // Filtre les TX > 10 SOL
const connection = new Connection(RPC_URL, "confirmed");

// Dictionnaire pour tracker les tokens
const tokenTracker = {};

// Fonction pour récupérer le nom des tokens
async function fetchTokenName(mintAddress) {
  try {
    const response = await axios.get('https://api.raydium.io/v2/main/token');
    const token = response.data.find(t => t.mint === mintAddress);
    return token ? token.name : mintAddress.substring(0, 6) + '...';
  } catch {
    return mintAddress.substring(0, 6) + '...';
  }
}

// Fonction d'alerte Telegram
async function sendTelegramAlert(mint, data) {
  const tokenName = await fetchTokenName(mint);
  const msg = `🚨 *Achat groupé détecté!*\n\n` +
             `🪙 Token: ${tokenName}\n` +
             `👛 Wallets: ${data.count} (${data.wallets.slice(0, 3).map(w => w.substring(0, 6)).join(', ')}...)\n` +
             `💰 Montant total: ${data.amount.toFixed(2)} SOL\n` +
             `🔍 [Voir token](https://solscan.io/token/${mint})`;

  await axios.post(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
    chat_id: TG_CHAT_ID,
    text: msg,
    parse_mode: 'Markdown'
  });
}

// Analyse des transactions
async function checkWallets() {
  for (const wallet of WALLETS) {
    const txs = await connection.getSignaturesForAddress(new PublicKey(wallet), { limit: 5 });
    
    for (const tx of txs) {
      const transfer = await analyzeTransaction(tx.signature, wallet);
      if (!transfer || transfer.amount < MIN_SOL_AMOUNT) continue;

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

        // Alerte seulement au 3ème achat
        if (tokenTracker[transfer.mint].count === 3) {
          await sendTelegramAlert(transfer.mint, tokenTracker[transfer.mint]);
        }
      }
    }
  }
}

// Serve HTTP minimal pour Render
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('✅ Solana Tracker actif - Alertes Telegram activées');
}).listen(process.env.PORT || 3000, () => {
  console.log(`Port ${process.env.PORT || 3000} - Prêt pour les alertes`);
  setInterval(checkWallets, 30 * 60 * 1000); // Vérifie toutes les 30 min
});
