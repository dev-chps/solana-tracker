const { Connection, PublicKey } = require('@solana/web3.js');
const axios = require('axios');

// Config
const MIN_SOL_AMOUNT = 10; // Filtre les TX > 10 SOL
const MIN_WALLETS = 3; // Alerte si 3+ wallets achètent le même token
const connection = new Connection(process.env.RPC_URL, "confirmed");

// Dictionnaire pour tracker les tokens
const tokenTracker = {};

async function analyzeTransaction(signature, wallet) {
  const tx = await connection.getParsedTransaction(signature);
  if (!tx) return null;

  const transfers = tx.transaction.message.instructions
    .filter(ix => ix.programId?.equals(new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA")))
    .map(ix => ({
      mint: ix.parsed?.info?.mint,
      amount: ix.parsed?.info?.amount / 1e9, // Converti en SOL
      wallet
    }))
    .filter(t => t.amount > MIN_SOL_AMOUNT); // Filtre les gros montants

  return transfers.length ? transfers[0] : null;
}

async function checkWallets() {
  const wallets = process.env.WALLETS.split(',');
  
  for (const wallet of wallets) {
    const txs = await connection.getSignaturesForAddress(new PublicKey(wallet), { limit: 5 });
    
    for (const tx of txs) {
      const transfer = await analyzeTransaction(tx.signature, wallet);
      if (!transfer) continue;

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
      }

      // Alerte si seuil atteint
      if (tokenTracker[transfer.mint].count === MIN_WALLETS) {
        await sendTelegramAlert(transfer.mint, tokenTracker[transfer.mint]);
      }
    }
  }
}

async function sendTelegramAlert(mint, data) {
  const tokenName = await fetchTokenName(mint); // À implémenter
  const msg = `🚨 *Achat groupé détecté!*\n\n` +
             `🪙 Token: ${tokenName || mint}\n` +
             `👛 Wallets: ${data.count} (${data.wallets.slice(0, 3).map(w => w.substring(0, 6))}...)\n` +
             `💰 Montant total: ${data.amount.toFixed(2)} SOL\n` +
             `🔍 [Voir token](https://solscan.io/token/${mint})`;

  await axios.post(`https://api.telegram.org/bot${process.env.TG_TOKEN}/sendMessage`, {
    chat_id: process.env.TG_CHAT_ID,
    text: msg,
    parse_mode: 'Markdown'
  });
}

// À exécuter périodiquement
setInterval(checkWallets, 30 * 60 * 1000); // Toutes les 30 min
