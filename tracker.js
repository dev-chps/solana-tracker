const { Connection, PublicKey } = require('@solana/web3.js');
const axios = require('axios');

// Config
const RPC_URL = process.env.RPC_URL;
const WALLETS = process.env.WALLETS.split(',');
const TG_TOKEN = process.env.TG_TOKEN;
const TG_CHAT_ID = process.env.TG_CHAT_ID;
const connection = new Connection(RPC_URL, {
  commitment: 'confirmed',
  httpHeaders: { 'maxSupportedTransactionVersion': 0 }
});

// Envoi d'alerte Telegram
async function sendAlert(wallet, tx) {
  const msg = `🔄 *Nouvelle TX Solana* \n\n` +
             `👛 Wallet: \`${wallet.substring(0, 6)}...\`\n` +
             `📊 Montant: ${tx.amount || '?'} SOL\n` +
             `🔗 [Voir TX](https://solscan.io/tx/${tx.signature})`;
  
  try {
    await axios.post(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      chat_id: TG_CHAT_ID,
      text: msg,
      parse_mode: 'Markdown',
      disable_web_page_preview: true
    });
  } catch (error) {
    console.error('Erreur Telegram:', error.message);
  }
}

async function trackWallet(wallet) {
  try {
    const pubKey = new PublicKey(wallet);
    const txs = await connection.getSignaturesForAddress(pubKey, { limit: 3 });
    
    for (const tx of txs) {
      await sendAlert(wallet, {
        signature: tx.signature,
        amount: (tx.amount / 1e9).toFixed(2) // Conversion en SOL
      });
    }
  } catch (error) {
    console.error(`❌ Erreur sur ${wallet.substring(0, 6)}:`, error.message);
  }
}

// Exécution
async function run() {
  console.log(`Début du scan (${WALLETS.length} wallets)...`);
  await Promise.all(WALLETS.map(trackWallet));
  setTimeout(run, 6 * 60 * 60 * 1000); // Toutes les 6h
}

run();
