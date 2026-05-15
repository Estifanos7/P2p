/**
 * SwapGuard P2P Escrow Bot
 * Node.js + grammy + express
 * 
 * Install: npm install grammy express dotenv crypto uuid
 * Run:     node bot.js
 */

require('dotenv').config();
const { Bot, InlineKeyboard, webhookCallback } = require('grammy');
const express = require('express');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');

// ─── CONFIG ─────────────────────────────────────────────────
const BOT_TOKEN   = process.env.BOT_TOKEN   || 'YOUR_BOT_TOKEN';
const WEBAPP_URL  = process.env.WEBAPP_URL  || 'https://your-domain.com';
const PORT        = process.env.PORT        || 3000;
const ADMIN_IDS   = (process.env.ADMIN_IDS || '').split(',').map(Number).filter(Boolean);
const HMAC_SECRET = process.env.HMAC_SECRET || crypto.randomBytes(32).toString('hex');

const bot = new Bot(BOT_TOKEN);
const app = express();
app.use(express.json());

// ─── IN-MEMORY STORE (replace with DB in production) ────────
// Use PostgreSQL/MongoDB in production.
const db = {
  users:   {},   // telegramId -> UserRecord
  offers:  {},   // offerId    -> OfferRecord
  trades:  {},   // tradeId    -> TradeRecord
  disputes:{},   // disputeId  -> DisputeRecord
};

// ─── MODELS ─────────────────────────────────────────────────
function createUser(tgUser) {
  return {
    id:            tgUser.id,
    username:      tgUser.username || `user_${tgUser.id}`,
    firstName:     tgUser.first_name,
    completedTrades: 0,
    rating:        5.0,
    ratingCount:   0,
    joinedAt:      Date.now(),
    kycVerified:   false,
    banned:        false,
    paymentMethods: [],
  };
}

function createTrade(offer, buyerId, fiatAmt, payMethod) {
  const cryptoAmt = (parseFloat(fiatAmt) / offer.price).toFixed(8);
  const fee       = (parseFloat(fiatAmt) * 0.005).toFixed(2);
  return {
    id:           'TRD-' + uuidv4().split('-')[0].toUpperCase(),
    offerId:      offer.id,
    coin:         offer.coin,
    type:         offer.type,          // 'buy' | 'sell'
    sellerId:     offer.type === 'sell' ? offer.ownerId : buyerId,
    buyerId:      offer.type === 'sell' ? buyerId       : offer.ownerId,
    fiatAmt:      parseFloat(fiatAmt).toFixed(2),
    cryptoAmt,
    fee,
    rate:         offer.price,
    payMethod,
    status:       'created',           // created|locked|paid|released|disputed|cancelled|refunded
    escrowLocked: false,
    createdAt:    Date.now(),
    lockedAt:     null,
    paidAt:       null,
    releasedAt:   null,
    timeoutMs:    30 * 60 * 1000,     // 30 min payment window
    timeoutHandle: null,
    messages:     [],                  // trade chat log
  };
}

// ─── HELPERS ────────────────────────────────────────────────
function getUser(id) {
  return db.users[id] || null;
}

function requireUser(ctx) {
  const id = ctx.from?.id;
  if (!id) return null;
  if (!db.users[id]) {
    db.users[id] = createUser(ctx.from);
  }
  return db.users[id];
}

function fmtTrade(t) {
  return [
    `🔐 *Trade ${t.id}*`,
    `├ Coin: \`${t.cryptoAmt} ${t.coin}\``,
    `├ Fiat: \`$${t.fiatAmt} USD\``,
    `├ Rate: \`$${t.rate.toLocaleString()}\``,
    `├ Fee:  \`$${t.fee}\``,
    `├ Pay:  \`${t.payMethod}\``,
    `└ Status: *${t.status.toUpperCase()}*`,
  ].join('\n');
}

function escrowProgressBar(status) {
  const steps   = ['created', 'locked', 'paid', 'released'];
  const labels  = ['📝 Created', '🔐 Locked', '💸 Paid', '✅ Released'];
  const idx     = steps.indexOf(status);
  return labels.map((l, i) => (i <= idx ? `*${l}*` : l)).join(' → ');
}

// ─── VALIDATE TELEGRAM INIT DATA (security) ─────────────────
function validateInitData(initData) {
  const params  = new URLSearchParams(initData);
  const hash    = params.get('hash');
  params.delete('hash');
  const dataStr = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
  const computed  = crypto.createHmac('sha256', secretKey).update(dataStr).digest('hex');
  return computed === hash;
}

// ─── BOT COMMANDS ────────────────────────────────────────────

// /start
bot.command('start', async (ctx) => {
  const user = requireUser(ctx);
  if (user.banned) { await ctx.reply('🚫 Your account has been banned.'); return; }

  const kb = new InlineKeyboard()
    .webApp('🚀 Open SwapGuard', WEBAPP_URL)
    .row()
    .text('📋 My Trades',   'my_trades')
    .text('📊 My Stats',    'my_stats')
    .row()
    .text('❓ Help',        'help')
    .text('📣 Support',     'support');

  await ctx.reply(
    `👋 *Welcome to SwapGuard P2P!*\n\n` +
    `Trade crypto peer-to-peer with *escrow protection*.\n\n` +
    `🔐 Your funds are always safe — we hold crypto in escrow until payment is confirmed.\n\n` +
    `Tap below to open the trading platform:`,
    { parse_mode: 'Markdown', reply_markup: kb }
  );
});

// /help
bot.command('help', async (ctx) => {
  await ctx.reply(
    `*SwapGuard Help* 🆘\n\n` +
    `*Commands:*\n` +
    `/start — Open SwapGuard\n` +
    `/trades — View your active trades\n` +
    `/stats — Your trading statistics\n` +
    `/dispute <tradeId> — Open a dispute\n` +
    `/cancel <tradeId> — Cancel a pending trade\n` +
    `/support — Contact support\n\n` +
    `*How escrow works:*\n` +
    `1. Seller locks crypto in escrow\n` +
    `2. Buyer sends fiat payment\n` +
    `3. Buyer confirms payment sent\n` +
    `4. Seller releases escrow\n` +
    `5. Trade complete ✅\n\n` +
    `_Disputes are resolved within 24 hours._`,
    { parse_mode: 'Markdown' }
  );
});

// /trades
bot.command('trades', async (ctx) => {
  const user = requireUser(ctx);
  const myTrades = Object.values(db.trades).filter(
    t => t.sellerId === user.id || t.buyerId === user.id
  );
  if (myTrades.length === 0) {
    await ctx.reply('📭 You have no trades yet. Open SwapGuard to start trading!');
    return;
  }
  const active  = myTrades.filter(t => !['released','cancelled','refunded'].includes(t.status));
  const closed  = myTrades.filter(t =>  ['released','cancelled','refunded'].includes(t.status));
  const lines   = [
    `*Your Trades (${myTrades.length} total)*\n`,
    active.length  ? `*Active (${active.length}):*\n`  + active.map(t  => `• ${t.id} — ${t.cryptoAmt} ${t.coin} — *${t.status}*`).join('\n')  : '',
    closed.length  ? `\n*Closed (${closed.length}):*\n` + closed.slice(0,5).map(t => `• ${t.id} — ${t.cryptoAmt} ${t.coin} — ${t.status}`).join('\n') : '',
  ].filter(Boolean).join('\n');
  await ctx.reply(lines, { parse_mode: 'Markdown' });
});

// /stats
bot.command('stats', async (ctx) => {
  const user = requireUser(ctx);
  const myTrades = Object.values(db.trades).filter(t => t.sellerId===user.id||t.buyerId===user.id);
  const done     = myTrades.filter(t=>t.status==='released').length;
  const vol      = myTrades.filter(t=>t.status==='released').reduce((s,t)=>s+parseFloat(t.fiatAmt),0);
  await ctx.reply(
    `📊 *Your Stats — @${user.username}*\n\n` +
    `✅ Completed trades: *${done}*\n` +
    `💰 Total volume: *$${vol.toFixed(2)}*\n` +
    `⭐ Rating: *${user.rating.toFixed(1)}/5.0* (${user.ratingCount} reviews)\n` +
    `🔐 KYC: ${user.kycVerified ? '✅ Verified' : '❌ Unverified'}\n` +
    `📅 Member since: ${new Date(user.joinedAt).toLocaleDateString()}`,
    { parse_mode: 'Markdown' }
  );
});

// /dispute
bot.command('dispute', async (ctx) => {
  const user    = requireUser(ctx);
  const tradeId = ctx.message?.text?.split(' ')[1]?.toUpperCase();
  if (!tradeId) { await ctx.reply('Usage: /dispute <tradeId>\nExample: /dispute TRD-A1B2C3'); return; }
  const trade = db.trades[tradeId];
  if (!trade) { await ctx.reply('❌ Trade not found.'); return; }
  if (trade.sellerId !== user.id && trade.buyerId !== user.id) { await ctx.reply('❌ You are not part of this trade.'); return; }
  if (!['locked','paid'].includes(trade.status)) { await ctx.reply(`❌ Cannot dispute a trade with status: ${trade.status}`); return; }

  trade.status = 'disputed';
  const disputeId = 'DSP-' + uuidv4().split('-')[0].toUpperCase();
  db.disputes[disputeId] = { id: disputeId, tradeId, openedBy: user.id, openedAt: Date.now(), status: 'open', resolution: null };

  // notify both parties
  const counterpartyId = trade.sellerId===user.id ? trade.buyerId : trade.sellerId;
  const counterparty   = db.users[counterpartyId];
  if (counterparty) {
    await bot.api.sendMessage(counterpartyId,
      `⚠️ *Dispute Opened*\nTrade ${tradeId} has been disputed by your counterparty.\nOur support team will contact both parties within 24 hours.`,
      { parse_mode: 'Markdown' }
    ).catch(()=>{});
  }

  // notify admins
  for (const adminId of ADMIN_IDS) {
    await bot.api.sendMessage(adminId,
      `🚨 *New Dispute: ${disputeId}*\n` +
      `Trade: ${tradeId}\n` +
      `Opened by: @${user.username}\n` +
      `Amount: $${trade.fiatAmt} / ${trade.cryptoAmt} ${trade.coin}\n` +
      `Pay method: ${trade.payMethod}`,
      { parse_mode: 'Markdown' }
    ).catch(()=>{});
  }

  await ctx.reply(
    `⚠️ *Dispute ${disputeId} Opened*\n\n` +
    `Trade: ${tradeId}\nOur team will review and contact both parties within 24 hours.\nCrypto remains locked in escrow until resolved.`,
    { parse_mode: 'Markdown' }
  );
});

// /cancel
bot.command('cancel', async (ctx) => {
  const user    = requireUser(ctx);
  const tradeId = ctx.message?.text?.split(' ')[1]?.toUpperCase();
  if (!tradeId) { await ctx.reply('Usage: /cancel <tradeId>'); return; }
  const trade   = db.trades[tradeId];
  if (!trade)   { await ctx.reply('❌ Trade not found.'); return; }
  if (trade.sellerId !== user.id && trade.buyerId !== user.id) { await ctx.reply('❌ Not your trade.'); return; }
  if (trade.status !== 'created') { await ctx.reply(`❌ Cannot cancel: status is ${trade.status}.`); return; }

  trade.status = 'cancelled';
  await ctx.reply(`✅ Trade ${tradeId} cancelled.`);
});

// /support
bot.command('support', async (ctx) => {
  await ctx.reply(
    `🛟 *SwapGuard Support*\n\n` +
    `For urgent issues, open a dispute via /dispute <tradeId>\n\n` +
    `Email: support@swapguard.io\n` +
    `Response time: < 24 hours\n\n` +
    `_SwapGuard never asks for your seed phrase or private keys._`,
    { parse_mode: 'Markdown' }
  );
});

// ─── CALLBACK QUERIES ────────────────────────────────────────
bot.callbackQuery('my_trades', async (ctx) => {
  await ctx.answerCallbackQuery();
  const user = requireUser(ctx);
  const kb   = new InlineKeyboard().webApp('📋 Open Trades', WEBAPP_URL);
  await ctx.reply('Tap to view your trades in SwapGuard:', { reply_markup: kb });
});

bot.callbackQuery('my_stats', async (ctx) => {
  await ctx.answerCallbackQuery();
  ctx.message = { text: '/stats', ...ctx.message };
  const user = requireUser(ctx);
  const myTrades = Object.values(db.trades).filter(t=>t.sellerId===user.id||t.buyerId===user.id);
  const done  = myTrades.filter(t=>t.status==='released').length;
  const vol   = myTrades.filter(t=>t.status==='released').reduce((s,t)=>s+parseFloat(t.fiatAmt),0);
  await ctx.reply(
    `📊 *Stats — @${user.username}*\n✅ ${done} trades · 💰 $${vol.toFixed(2)} · ⭐ ${user.rating.toFixed(1)}`,
    { parse_mode: 'Markdown' }
  );
});

bot.callbackQuery('help',    async (ctx) => { await ctx.answerCallbackQuery(); /* reuse help */ });
bot.callbackQuery('support', async (ctx) => { await ctx.answerCallbackQuery(); await ctx.reply('📧 Email: support@swapguard.io'); });

// ─── REST API (called by the Mini App) ───────────────────────

// Middleware: validate Telegram init data on all /api routes
app.use('/api', (req, res, next) => {
  const initData = req.headers['x-telegram-init-data'];
  // In production, enforce this. Dev mode: skip if no init data header.
  if (initData && process.env.NODE_ENV === 'production') {
    if (!validateInitData(initData)) {
      return res.status(401).json({ error: 'Invalid Telegram auth' });
    }
  }
  next();
});

// GET /api/offers?coin=BTC&type=sell
app.get('/api/offers', (req, res) => {
  const { coin, type } = req.query;
  let offers = Object.values(db.offers).filter(o => o.active);
  if (coin) offers = offers.filter(o => o.coin === coin);
  if (type) offers = offers.filter(o => o.type === type);
  res.json({ offers });
});

// POST /api/offers — create a new offer
app.post('/api/offers', (req, res) => {
  const { userId, coin, type, price, minAmount, maxAmount, payMethods } = req.body;
  if (!userId || !coin || !type || !price || !minAmount || !maxAmount || !payMethods) {
    return res.status(400).json({ error: 'Missing fields' });
  }
  const user = db.users[userId];
  if (!user) return res.status(404).json({ error: 'User not found' });

  const offer = {
    id:         'OFF-' + uuidv4().split('-')[0].toUpperCase(),
    ownerId:    userId,
    ownerName:  user.username,
    coin, type, price: parseFloat(price),
    minAmount:  parseFloat(minAmount),
    maxAmount:  parseFloat(maxAmount),
    payMethods: Array.isArray(payMethods) ? payMethods : [payMethods],
    active:     true,
    createdAt:  Date.now(),
    trades:     0,
    completion: 100,
    rating:     user.rating,
    avgTime:    15,
  };
  db.offers[offer.id] = offer;
  res.json({ offer });
});

// POST /api/trades — open a new trade
app.post('/api/trades', async (req, res) => {
  const { offerId, buyerId, fiatAmt, payMethod } = req.body;
  const offer = db.offers[offerId];
  if (!offer || !offer.active) return res.status(404).json({ error: 'Offer not found or inactive' });

  const buyer = db.users[buyerId];
  if (!buyer) return res.status(404).json({ error: 'Buyer not found' });
  if (buyer.banned) return res.status(403).json({ error: 'Account banned' });

  const amt = parseFloat(fiatAmt);
  if (amt < offer.minAmount || amt > offer.maxAmount) {
    return res.status(400).json({ error: `Amount must be between $${offer.minAmount} and $${offer.maxAmount}` });
  }

  const trade = createTrade(offer, buyerId, fiatAmt, payMethod || offer.payMethods[0]);
  db.trades[trade.id] = trade;

  // Notify seller
  try {
    const kb = new InlineKeyboard().webApp('🔐 Open Trade', `${WEBAPP_URL}?trade=${trade.id}`);
    await bot.api.sendMessage(offer.ownerId,
      `🔔 *New Trade Request!*\n\n` +
      fmtTrade(trade) + '\n\n' +
      `Buyer: @${buyer.username}\n\n` +
      `Please lock the crypto in escrow to start the trade.`,
      { parse_mode: 'Markdown', reply_markup: kb }
    );
  } catch(e) { console.error('Notify seller failed:', e.message); }

  // Notify buyer
  try {
    const kb = new InlineKeyboard().webApp('📋 View Trade', `${WEBAPP_URL}?trade=${trade.id}`);
    await bot.api.sendMessage(buyerId,
      `✅ *Trade Created: ${trade.id}*\n\n` +
      escrowProgressBar('created') + '\n\n' +
      `Waiting for seller to lock funds in escrow...`,
      { parse_mode: 'Markdown', reply_markup: kb }
    );
  } catch(e) { console.error('Notify buyer failed:', e.message); }

  res.json({ trade });
});

// POST /api/trades/:id/lock — seller locks crypto in escrow
app.post('/api/trades/:id/lock', async (req, res) => {
  const trade = db.trades[req.params.id];
  if (!trade) return res.status(404).json({ error: 'Trade not found' });
  if (trade.status !== 'created') return res.status(400).json({ error: 'Trade not in created state' });
  const { userId } = req.body;
  if (trade.sellerId !== userId) return res.status(403).json({ error: 'Only seller can lock escrow' });

  trade.status     = 'locked';
  trade.escrowLocked = true;
  trade.lockedAt   = Date.now();

  // Set payment timeout
  trade.timeoutHandle = setTimeout(async () => {
    if (trade.status === 'locked') {
      trade.status = 'cancelled';
      await notifyBoth(trade, '⏰ Trade auto-cancelled — payment window expired.');
    }
  }, trade.timeoutMs);

  await notifyBoth(trade,
    `🔐 *Escrow Locked!*\n\n` +
    escrowProgressBar('locked') + '\n\n' +
    `*Buyer: Send $${trade.fiatAmt} via ${trade.payMethod} to @${db.users[trade.sellerId]?.username}*\n` +
    `You have 30 minutes to complete payment.`,
    `${WEBAPP_URL}?trade=${trade.id}`
  );

  res.json({ trade });
});

// POST /api/trades/:id/paid — buyer marks payment sent
app.post('/api/trades/:id/paid', async (req, res) => {
  const trade = db.trades[req.params.id];
  if (!trade) return res.status(404).json({ error: 'Trade not found' });
  if (trade.status !== 'locked') return res.status(400).json({ error: 'Escrow not locked yet' });
  const { userId } = req.body;
  if (trade.buyerId !== userId) return res.status(403).json({ error: 'Only buyer can confirm payment' });

  trade.status = 'paid';
  trade.paidAt = Date.now();
  if (trade.timeoutHandle) clearTimeout(trade.timeoutHandle);

  await notifyBoth(trade,
    `💸 *Payment Marked as Sent!*\n\n` +
    escrowProgressBar('paid') + '\n\n` +` +
    `*Seller: Please verify you received $${trade.fiatAmt} via ${trade.payMethod}, then release escrow.*`,
    `${WEBAPP_URL}?trade=${trade.id}`
  );

  res.json({ trade });
});

// POST /api/trades/:id/release — seller releases escrow
app.post('/api/trades/:id/release', async (req, res) => {
  const trade = db.trades[req.params.id];
  if (!trade) return res.status(404).json({ error: 'Trade not found' });
  if (trade.status !== 'paid') return res.status(400).json({ error: 'Payment not confirmed yet' });
  const { userId } = req.body;
  if (trade.sellerId !== userId) return res.status(403).json({ error: 'Only seller can release escrow' });

  trade.status     = 'released';
  trade.releasedAt = Date.now();

  // Update stats
  [trade.sellerId, trade.buyerId].forEach(id => {
    const u = db.users[id];
    if (u) u.completedTrades = (u.completedTrades || 0) + 1;
  });
  const offer = db.offers[trade.offerId];
  if (offer) offer.trades++;

  await notifyBoth(trade,
    `🎉 *Trade Complete!*\n\n` +
    escrowProgressBar('released') + '\n\n' +
    `${trade.cryptoAmt} ${trade.coin} has been released!\n` +
    `Thank you for trading on SwapGuard.`,
    `${WEBAPP_URL}?trade=${trade.id}`
  );

  res.json({ trade });
});

// POST /api/trades/:id/dispute
app.post('/api/trades/:id/dispute', async (req, res) => {
  const trade = db.trades[req.params.id];
  if (!trade) return res.status(404).json({ error: 'Trade not found' });
  if (!['locked','paid'].includes(trade.status)) return res.status(400).json({ error: 'Cannot dispute at this stage' });

  const { userId, reason } = req.body;
  trade.status = 'disputed';
  const dsp = { id: 'DSP-'+uuidv4().split('-')[0].toUpperCase(), tradeId: trade.id, openedBy: userId, reason, openedAt: Date.now(), status: 'open' };
  db.disputes[dsp.id] = dsp;

  for (const adminId of ADMIN_IDS) {
    await bot.api.sendMessage(adminId,
      `🚨 *Dispute: ${dsp.id}*\n` +
      `Trade: ${trade.id}\n` +
      `By: ${userId}\n` +
      `Reason: ${reason || 'Not specified'}\n` +
      `Amount: ${trade.cryptoAmt} ${trade.coin} / $${trade.fiatAmt}`,
      { parse_mode: 'Markdown' }
    ).catch(()=>{});
  }

  await notifyBoth(trade, `⚠️ Dispute opened on trade ${trade.id}. Support will contact you within 24h.`);
  res.json({ dispute: dsp });
});

// GET /api/trades/:id
app.get('/api/trades/:id', (req, res) => {
  const trade = db.trades[req.params.id];
  if (!trade) return res.status(404).json({ error: 'Not found' });
  res.json({ trade });
});

// GET /api/users/:id/trades
app.get('/api/users/:id/trades', (req, res) => {
  const id  = parseInt(req.params.id);
  const trades = Object.values(db.trades).filter(t=>t.sellerId===id||t.buyerId===id);
  res.json({ trades });
});

// POST /api/users/:id/rate
app.post('/api/users/:id/rate', (req, res) => {
  const user = db.users[parseInt(req.params.id)];
  if (!user) return res.status(404).json({ error: 'User not found' });
  const { rating } = req.body;
  if (!rating || rating < 1 || rating > 5) return res.status(400).json({ error: 'Rating must be 1–5' });
  user.rating      = ((user.rating * user.ratingCount) + rating) / (user.ratingCount + 1);
  user.ratingCount += 1;
  res.json({ user });
});

// ADMIN: GET /api/admin/disputes (requires admin token)
app.get('/api/admin/disputes', (req, res) => {
  const token = req.headers['x-admin-token'];
  if (token !== process.env.ADMIN_TOKEN) return res.status(403).json({ error: 'Forbidden' });
  res.json({ disputes: Object.values(db.disputes) });
});

// ADMIN: POST /api/admin/disputes/:id/resolve
app.post('/api/admin/disputes/:id/resolve', async (req, res) => {
  const token = req.headers['x-admin-token'];
  if (token !== process.env.ADMIN_TOKEN) return res.status(403).json({ error: 'Forbidden' });
  const dsp   = db.disputes[req.params.id];
  if (!dsp)   return res.status(404).json({ error: 'Dispute not found' });
  const trade = db.trades[dsp.tradeId];
  const { winner, resolution } = req.body; // winner: 'buyer' | 'seller'

  dsp.status     = 'resolved';
  dsp.resolution = resolution;
  dsp.resolvedAt = Date.now();
  trade.status   = winner === 'buyer' ? 'refunded' : 'released';

  await notifyBoth(trade, `⚖️ Dispute resolved: ${resolution}\nOutcome: ${winner === 'buyer' ? 'Buyer refunded' : 'Seller released funds'}`);
  res.json({ dispute: dsp, trade });
});

// Health check
app.get('/health', (req, res) => res.json({ status: 'ok', uptime: process.uptime() }));

// ─── NOTIFY HELPER ───────────────────────────────────────────
async function notifyBoth(trade, message, url) {
  const ids = [trade.sellerId, trade.buyerId];
  const kb  = url ? new InlineKeyboard().webApp('📱 Open Trade', url) : undefined;
  for (const id of ids) {
    if (!id) continue;
    await bot.api.sendMessage(id, message, {
      parse_mode:   'Markdown',
      reply_markup: kb,
    }).catch(() => {});
  }
}

// ─── START ───────────────────────────────────────────────────
async function start() {
  if (process.env.WEBHOOK_URL) {
    // Webhook mode (production)
    app.use(await webhookCallback(bot, 'express'));
    await bot.api.setWebhook(`${process.env.WEBHOOK_URL}/webhook`);
    console.log(`🔗 Webhook set: ${process.env.WEBHOOK_URL}/webhook`);
  } else {
    // Long polling (development)
    bot.start();
    console.log('🤖 Bot started (long polling)');
  }
  app.listen(PORT, () => console.log(`🚀 API server running on :${PORT}`));
}

start().catch(console.error);

module.exports = { app, bot, db };
