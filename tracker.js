const http = require('http');
const { Connection, PublicKey } = require('@solana/web3.js');
const axios = require('axios');

// Config
const RPC_URL = process.env.RPC_URL;
const WALLETS = process.env.WALLETS.split(',');
const TG_TOKEN = process.env.TG_TOKEN;
const TG_CHAT_ID = process.env.TG_CHAT_ID;
const TEST_TOKEN = process.env.TEST_TOKEN || "default-secret"; // Sécurité
const MIN_SOL_AMOUNT = 10;
const MIN_WALLETS = 3;

const connection = new Connection(RPC_URL, {
  commitment: 'confirmed',
  httpHeaders: { 'maxSupportedTransactionVersion': 0 }
});

const tokenTracker = {};
const processedTxs = new Set();

// [Vos fonctions existantes fetchTokenName, analyzeTransaction, sendTelegramAlert, checkWallets...]

// Serveur HTTP avec endpoint de test
const server = http.createServer(async (req, res) => {
  // Endpoint de test
  if (req.method === 'POST' && req.url === '/trigger-test') {
    if (req.headers['x-test-token'] !== TEST_TOKEN) {
      res.writeHead(403);
      return res.end("Accès refusé");
    }

    try {
      await sendTelegramAlert("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", {
        count: 3,
        wallets: ["7o1UnD...", "HSQEzV...", "GDKVNs..."],
        amount: 42.5
      });
      res.writeHead(200);
      res.end("Alerte test envoyée !");
    } catch (error) {
      res.writeHead(500);
      res.end("Erreur: " + error.message);
    }
    return;
  }

  // Route principale
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ 
    status: 'online',
    endpoints: { test: 'POST /trigger-test' } 
  }));
}).listen(process.env.PORT || 3000, () => {
  console.log(`🚀 Serveur prêt sur port ${process.env.PORT || 3000}`);
  checkWallets();
  setInterval(checkWallets, 30 * 60 * 1000);
});
