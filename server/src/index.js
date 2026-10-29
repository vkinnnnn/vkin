'use strict';
// Production entry: wires real dependencies from the environment. Never logs keys, prompts or transcripts.

const http = require('node:http');
const WebSocket = require('ws');
const OpenAI = require('openai');
const { createClient } = require('@supabase/supabase-js');
const { createApp } = require('./app');
const { createDb } = require('./db');
const { createTokenVerifier } = require('./auth');
const { loadPrices } = require('./prices');

function log(level, obj) {
  const line = JSON.stringify({ level, at: new Date().toISOString(), ...obj });
  if (level === 'error') console.error(line); else console.log(line);
}
const logger = { info: (o) => log('info', o), warn: (o) => log('warn', o), error: (o) => log('error', o) };

function envNumber(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : NaN;
}

function main() {
  const env = process.env;
  if (!env.SUPABASE_SERVICE_ROLE_KEY || !env.SUPABASE_URL) {
    logger.error({ event: 'startup_refused', reason: 'SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required' });
    process.exit(1);
  }
  const nebiusCap = envNumber('NEBIUS_SERVER_CAP_USD', 10);
  const deepgramCap = envNumber('DEEPGRAM_SERVER_CAP_USD', 10);
  const nebiusUserCap = envNumber('NEBIUS_USER_CAP_USD', 0.5);
  const geminiDaily = envNumber('GEMINI_DAILY_REQUEST_CAP', 300);
  const geminiUserDaily = envNumber('GEMINI_USER_DAILY_CAP', 40);
  if (![nebiusCap, deepgramCap, nebiusUserCap, geminiDaily, geminiUserDaily].every((n) => n >= 0)) {
    logger.error({ event: 'startup_refused', reason: 'caps must be non-negative numbers' });
    process.exit(1);
  }
  const deepgramUsdPerMin = envNumber('DEEPGRAM_USD_PER_MIN', NaN); // required for STT; unset -> close 4503

  const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });

  const lazyClient = (apiKey, baseURL) => {
    let client = null;
    return () => {
      if (!apiKey) return null;
      if (!client) client = new OpenAI({ apiKey, baseURL, maxRetries: 0, timeout: 60_000 });
      return client;
    };
  };

  const corsOrigins = (env.CORS_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);

  const vkin = createApp({
    verifyToken: createTokenVerifier({ supabase }),
    db: createDb(supabase),
    nebius: lazyClient(env.NEBIUS_API_KEY, env.NEBIUS_BASE_URL || 'https://api.tokenfactory.nebius.com/v1/'),
    gemini: lazyClient(env.GEMINI_API_KEY, env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta/openai/'),
    deepgramConnect: (url, headers) => new WebSocket(url, { headers, perMessageDeflate: false, handshakeTimeout: 10_000 }),
    deepgramApiKey: env.DEEPGRAM_API_KEY || '',
    deepgramUrl: env.DEEPGRAM_URL || 'wss://api.deepgram.com/v2/listen',
    prices: loadPrices(),
    caps: {
      nebiusUsd: nebiusCap,
      deepgramUsd: deepgramCap,
      deepgramUsdPerMin,
      nebiusUserUsd: nebiusUserCap,
      geminiDailyRequests: geminiDaily,
      geminiUserDailyRequests: geminiUserDaily,
    },
    corsOrigins,
    log: logger,
  });

  const server = http.createServer(vkin.app);
  server.on('upgrade', vkin.handleUpgrade);
  // Time to receive the request (headers / whole body). Responses (SSE) and upgraded sockets are not affected.
  server.headersTimeout = 15_000;
  server.requestTimeout = 30_000;
  vkin.start();

  const port = Number(env.PORT) || 8080;
  server.listen(port, () => {
    logger.info({
      event: 'listening',
      port,
      nebius: Boolean(env.NEBIUS_API_KEY),
      gemini: Boolean(env.GEMINI_API_KEY),
      deepgram: Boolean(env.DEEPGRAM_API_KEY) && deepgramUsdPerMin > 0,
      corsOrigins: corsOrigins.length,
    });
  });

  const shutdown = () => {
    vkin.stop();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

if (require.main === module) main();

module.exports = { main };
