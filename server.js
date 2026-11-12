const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const { Pool } = require('pg');
const crypto = require('crypto');
const path = require('path');

const app = express();
app.use(express.json({ limit: '32kb' }));
app.use(express.static(path.join(__dirname, 'public')));

const { BOT_TOKEN, WEBAPP_URL, DATABASE_URL, ADMIN_TELEGRAM_ID } = process.env;
if (!BOT_TOKEN || !WEBAPP_URL || !DATABASE_URL) {
  console.error('Missing BOT_TOKEN, WEBAPP_URL or DATABASE_URL environment variable.');
  process.exit(1);
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: DATABASE_URL.includes('localhost') ? false : { rejectUnauthorized: false }
});

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS players (
      telegram_id BIGINT PRIMARY KEY,
      username TEXT,
      first_name TEXT,
      coins BIGINT NOT NULL DEFAULT 0,
      click_power INTEGER NOT NULL DEFAULT 1,
      auto_click INTEGER NOT NULL DEFAULT 0,
      multiplier INTEGER NOT NULL DEFAULT 1,
      level1 INTEGER NOT NULL DEFAULT 1,
      level2 INTEGER NOT NULL DEFAULT 0,
      level3 INTEGER NOT NULL DEFAULT 0,
      cost1 BIGINT NOT NULL DEFAULT 50,
      cost2 BIGINT NOT NULL DEFAULT 200,
      cost3 BIGINT NOT NULL DEFAULT 1000,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS promos (
      code TEXT PRIMARY KEY,
      reward BIGINT NOT NULL CHECK (reward > 0),
      max_uses INTEGER NOT NULL CHECK (max_uses > 0),
      uses INTEGER NOT NULL DEFAULT 0,
      expires_at TIMESTAMPTZ,
      active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS promo_redemptions (
      telegram_id BIGINT NOT NULL REFERENCES players(telegram_id),
      code TEXT NOT NULL REFERENCES promos(code),
      redeemed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (telegram_id, code)
    );
  `);
}

function verifyTelegramInitData(initData) {
  if (!initData || typeof initData !== 'string') return null;
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) return null;
  params.delete('hash');

  const authDate = Number(params.get('auth_date'));
  if (!authDate || Math.abs(Date.now() / 1000 - authDate) > 86400) return null;

  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');

  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
  const calculatedHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');

  const a = Buffer.from(calculatedHash, 'hex');
  const b = Buffer.from(hash, 'hex');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

  try {
    const user = JSON.parse(params.get('user') || 'null');
    if (!user || !Number.isSafeInteger(Number(user.id))) return null;
    return user;
  } catch {
    return null;
  }
}

async function requireTelegram(req, res, next) {
  const initData = req.get('X-Telegram-Init-Data');
  const user = verifyTelegramInitData(initData);
  if (!user) return res.status(401).json({ error: 'Открой игру через Telegram.' });
  req.telegramUser = user;
  next();
}

async function ensurePlayer(user) {
  await pool.query(
    `INSERT INTO players (telegram_id, username, first_name)
     VALUES ($1, $2, $3)
     ON CONFLICT (telegram_id) DO UPDATE SET
       username = EXCLUDED.username,
       first_name = EXCLUDED.first_name,
       updated_at = NOW()`,
    [String(user.id), user.username || null, user.first_name || null]
  );
}

function playerState(row) {
  return {
    coins: Number(row.coins),
    clickPower: row.click_power,
    autoClick: row.auto_click,
    multiplier: row.multiplier,
    level1: row.level1, level2: row.level2, level3: row.level3,
    cost1: Number(row.cost1), cost2: Number(row.cost2), cost3: Number(row.cost3)
  };
}

app.get('/api/state', requireTelegram, async (req, res) => {
  try {
    await ensurePlayer(req.telegramUser);
    const result = await pool.query('SELECT * FROM players WHERE telegram_id=$1', [String(req.telegramUser.id)]);
    res.json({ player: playerState(result.rows[0]), firstName: req.telegramUser.first_name || '' });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Не удалось загрузить игру.' });
  }
});

app.post('/api/tap', requireTelegram, async (req, res) => {
  const client = await pool.connect();
  try {
    await ensurePlayer(req.telegramUser);
    await client.query('BEGIN');
    const q = await client.query('SELECT * FROM players WHERE telegram_id=$1 FOR UPDATE', [String(req.telegramUser.id)]);
    const p = q.rows[0];
    const coins = Number(p.coins) + p.click_power * p.multiplier;
    await client.query('UPDATE players SET coins=$1, updated_at=NOW() WHERE telegram_id=$2', [String(coins), String(req.telegramUser.id)]);
    await client.query('COMMIT');
    res.json({ coins });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error(e);
    res.status(500).json({ error: 'Ошибка сохранения клика.' });
  } finally { client.release(); }
});

app.post('/api/upgrade', requireTelegram, async (req, res) => {
  const type = Number(req.body.type);
  if (![1, 2, 3].includes(type)) return res.status(400).json({ error: 'Неизвестное улучшение.' });
  const client = await pool.connect();
  try {
    await ensurePlayer(req.telegramUser);
    await client.query('BEGIN');
    const q = await client.query('SELECT * FROM players WHERE telegram_id=$1 FOR UPDATE', [String(req.telegramUser.id)]);
    const p = q.rows[0];
    const costField = `cost${type}`;
    const cost = Number(p[costField]);
    if (Number(p.coins) < cost) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Недостаточно монет.' });
    }
    let update;
    if (type === 1) update = ['click_power=click_power+1, level1=level1+1, cost1=$1', Math.floor(cost * 1.45)];
    if (type === 2) update = ['auto_click=auto_click+1, level2=level2+1, cost2=$1', Math.floor(cost * 1.6)];
    if (type === 3) update = ['multiplier=multiplier*2, level3=level3+1, cost3=$1', Math.floor(cost * 2.2)];
    await client.query(
      `UPDATE players SET coins=coins-$1, ${update[0]}, updated_at=NOW() WHERE telegram_id=$2`,
      [cost, update[1], String(req.telegramUser.id)]
    );
    const fresh = await client.query('SELECT * FROM players WHERE telegram_id=$1', [String(req.telegramUser.id)]);
    await client.query('COMMIT');
    res.json({ player: playerState(fresh.rows[0]) });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error(e);
    res.status(500).json({ error: 'Ошибка покупки.' });
  } finally { client.release(); }
});

app.post('/api/auto-tick', requireTelegram, async (req, res) => {
  const client = await pool.connect();
  try {
    await ensurePlayer(req.telegramUser);
    await client.query('BEGIN');
    const q = await client.query('SELECT * FROM players WHERE telegram_id=$1 FOR UPDATE', [String(req.telegramUser.id)]);
    const p = q.rows[0];
    const now = Date.now();
    const previous = p.updated_at ? new Date(p.updated_at).getTime() : now;
    const elapsed = Math.max(0, Math.min(10, Math.floor((now - previous) / 1000)));
    const earned = elapsed * p.auto_click * p.multiplier;
    await client.query(
      'UPDATE players SET coins=coins+$1, updated_at=NOW() WHERE telegram_id=$2',
      [earned, String(req.telegramUser.id)]
    );
    const fresh = await client.query('SELECT * FROM players WHERE telegram_id=$1', [String(req.telegramUser.id)]);
    await client.query('COMMIT');
    res.json({ player: playerState(fresh.rows[0]) });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error(e);
    res.status(500).json({ error: 'Ошибка автоклика.' });
  } finally { client.release(); }
});

app.post('/api/promo/redeem', requireTelegram, async (req, res) => {
  const code = String(req.body.code || '').trim().toUpperCase();
  if (!/^[A-Z0-9_-]{3,32}$/.test(code)) return res.status(400).json({ error: 'Проверь промокод.' });
  const client = await pool.connect();
  try {
    await ensurePlayer(req.telegramUser);
    await client.query('BEGIN');
    const p = await client.query('SELECT * FROM promos WHERE code=$1 FOR UPDATE', [code]);
    if (!p.rowCount || !p.rows[0].active) {
      await client.query('ROLLBACK'); return res.status(400).json({ error: 'Промокод не найден или отключён.' });
    }
    const promo = p.rows[0];
    if (promo.expires_at && new Date(promo.expires_at) < new Date()) {
      await client.query('ROLLBACK'); return res.status(400).json({ error: 'Срок действия промокода истёк.' });
    }
    if (promo.uses >= promo.max_uses) {
      await client.query('ROLLBACK'); return res.status(400).json({ error: 'Лимит активаций исчерпан.' });
    }
    const already = await client.query('SELECT 1 FROM promo_redemptions WHERE telegram_id=$1 AND code=$2', [String(req.telegramUser.id), code]);
    if (already.rowCount) {
      await client.query('ROLLBACK'); return res.status(400).json({ error: 'Ты уже использовал этот промокод.' });
    }
    await client.query('INSERT INTO promo_redemptions (telegram_id, code) VALUES ($1,$2)', [String(req.telegramUser.id), code]);
    await client.query('UPDATE promos SET uses=uses+1 WHERE code=$1', [code]);
    await client.query('UPDATE players SET coins=coins+$1, updated_at=NOW() WHERE telegram_id=$2', [String(promo.reward), String(req.telegramUser.id)]);
    const fresh = await client.query('SELECT * FROM players WHERE telegram_id=$1', [String(req.telegramUser.id)]);
    await client.query('COMMIT');
    res.json({ message: `Начислено ${promo.reward} монет!`, player: playerState(fresh.rows[0]) });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error(e);
    res.status(500).json({ error: 'Не удалось активировать промокод.' });
  } finally { client.release(); }
});

app.get('/api/admin/whoami', requireTelegram, (req, res) => {
  res.json({ telegramId: String(req.telegramUser.id), isAdmin: !!ADMIN_TELEGRAM_ID && String(req.telegramUser.id) === String(ADMIN_TELEGRAM_ID) });
});

app.post('/api/admin/promo', requireTelegram, async (req, res) => {
  if (!ADMIN_TELEGRAM_ID || String(req.telegramUser.id) !== String(ADMIN_TELEGRAM_ID)) {
    return res.status(403).json({ error: 'Нет доступа администратора.' });
  }
  const code = String(req.body.code || '').trim().toUpperCase();
  const reward = Math.floor(Number(req.body.reward));
  const maxUses = Math.floor(Number(req.body.maxUses));
  const expiresAt = req.body.expiresAt ? new Date(req.body.expiresAt) : null;
  if (!/^[A-Z0-9_-]{3,32}$/.test(code) || !Number.isSafeInteger(reward) || reward < 1 ||
      !Number.isSafeInteger(maxUses) || maxUses < 1 || (expiresAt && Number.isNaN(expiresAt.getTime()))) {
    return res.status(400).json({ error: 'Проверь код, награду, лимит и дату.' });
  }
  try {
    await pool.query(
      `INSERT INTO promos (code,reward,max_uses,expires_at)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (code) DO UPDATE SET reward=EXCLUDED.reward,
       max_uses=EXCLUDED.max_uses, expires_at=EXCLUDED.expires_at, uses=0, active=TRUE`,
      [code, String(reward), maxUses, expiresAt]
    );
    res.json({ message: `Промокод ${code} создан.` });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Не удалось создать промокод.' });
  }
});

app.post('/api/admin/promo/toggle', requireTelegram, async (req, res) => {
  if (!ADMIN_TELEGRAM_ID || String(req.telegramUser.id) !== String(ADMIN_TELEGRAM_ID)) {
    return res.status(403).json({ error: 'Нет доступа администратора.' });
  }
  const code = String(req.body.code || '').trim().toUpperCase();
  const result = await pool.query('UPDATE promos SET active=NOT active WHERE code=$1 RETURNING active', [code]);
  if (!result.rowCount) return res.status(404).json({ error: 'Промокод не найден.' });
  res.json({ active: result.rows[0].active });
});

app.get('/api/admin/promos', requireTelegram, async (req, res) => {
  if (!ADMIN_TELEGRAM_ID || String(req.telegramUser.id) !== String(ADMIN_TELEGRAM_ID)) {
    return res.status(403).json({ error: 'Нет доступа администратора.' });
  }
  const result = await pool.query('SELECT code,reward,max_uses,uses,expires_at,active FROM promos ORDER BY created_at DESC');
  res.json({ promos: result.rows });
});

async function startBot() {
  const bot = new TelegramBot(BOT_TOKEN, { polling: true });
  bot.onText(/\/start/, async (msg) => {
    const chatId = msg.chat.id;
    const opts = WEBAPP_URL.startsWith('https://')
      ? { reply_markup: { inline_keyboard: [[{ text: '🎮 Играть в FollyTap', web_app: { url: WEBAPP_URL } }]] } }
      : {};
    await bot.sendMessage(chatId, '💜 Добро пожаловать в FollyTap! Нажми кнопку ниже, чтобы открыть игру.', opts);
  });
  bot.on('polling_error', (e) => console.error('Telegram polling error:', e.message));
}

const port = process.env.PORT || 3000;
initDb().then(async () => {
  app.listen(port, () => console.log(`FollyTap server listening on ${port}`));
  await startBot();
}).catch((e) => {
  console.error('Database initialization failed:', e);
  process.exit(1);
});
