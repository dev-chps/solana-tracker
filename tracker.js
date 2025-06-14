const { Connection, PublicKey } = require('@solana/web3.js');

// Config
const RPC_URL = process.env.RPC_URL;
const WALLETS = process.env.WALLETS.split(',');
const connection = new Connection(RPC_URL, {
  commitment: 'confirmed',
  httpHeaders: { 
    'maxSupportedTransactionVersion': 0 
  }
});

// Cache pour éviter les doublons
const processedTxs = new Set();

async function trackWallet(wallet) {
  try {
    const pubKey = new PublicKey(wallet);
    const txs = await connection.getSignaturesForAddress(pubKey, { limit: 5 });
    
    console.log(`\n🔍 ${wallet.substring(0, 6)}...`);
    
    for (const tx of txs) {
      if (processedTxs.has(tx.signature)) continue;
      processedTxs.add(tx.signature);
      
      console.log(`📜 TX: ${tx.signature.substring(0, 8)}...`);
      console.log(`⏳ ${new Date(tx.blockTime*1000).toLocaleString()}`);
      console.log(`🔗 https://solscan.io/tx/${tx.signature}`);
    }
  } catch (error) {
    console.error(`❌ ${wallet.substring(0, 6)}:`, error.message);
  }
}

// Traitement par batch avec délai
async function run() {
  console.log("=== SCAN STARTED ===");
  console.log(`Tracking ${WALLETS.length} wallets...`);
  
  const BATCH_SIZE = 3; // 3 wallets à la fois
  const DELAY_MS = 1500; // 1.5s entre les batchs
  
  for (let i = 0; i < WALLETS.length; i += BATCH_SIZE) {
    const batch = WALLETS.slice(i, i + BATCH_SIZE);
    await Promise.all(batch.map(trackWallet));
    
    if (i + BATCH_SIZE < WALLETS.length) {
      await new Promise(resolve => setTimeout(resolve, DELAY_MS));
    }
  }

  console.log("=== SCAN COMPLETED ===");
  setTimeout(run, 6 * 60 * 60 * 1000); // Relance dans 6h
}

run();
