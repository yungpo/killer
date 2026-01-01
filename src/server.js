import express from 'express';
import bcrypt from 'bcryptjs';
import dotenv from 'dotenv';
import { z } from 'zod';

import db from './db.js';
import { authMiddleware, signToken } from './auth.js';

dotenv.config();

const app = express();
app.use(express.json());

const COMMISSION_RATE = 0.1;
const REFERRAL_RATE = 0.3;
const REFERRAL_DURATION_DAYS = 60;

function ensureGamesSeeded() {
  const count = db.prepare('SELECT COUNT(*) as count FROM games').get();
  if (count.count > 0) return;

  const insert = db.prepare(
    'INSERT INTO games (name, max_players_solo, max_players_duel) VALUES (?, ?, ?)'
  );
  insert.run('Brawl Stars', 10, 2);
  insert.run('Free Fire', 50, 2);
  insert.run('PUBG', 100, 2);
}

ensureGamesSeeded();

function generateReferralCode(email) {
  const suffix = Math.random().toString(36).slice(2, 8).toUpperCase();
  return `${email.split('@')[0]}-${suffix}`.slice(0, 20);
}

function toIso(date) {
  return new Date(date).toISOString();
}

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.get('/api/games', (req, res) => {
  const games = db.prepare('SELECT * FROM games').all();
  res.json({ games });
});

app.post('/api/register', (req, res) => {
  const schema = z.object({
    email: z.string().email(),
    password: z.string().min(8),
    phone: z.string().min(5),
    referralCode: z.string().optional().nullable()
  });

  const result = schema.safeParse(req.body);
  if (!result.success) {
    return res.status(400).json({ error: result.error.flatten() });
  }

  const { email, password, phone, referralCode } = result.data;
  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
  if (existing) {
    return res.status(409).json({ error: 'Email already registered' });
  }

  let referredById = null;
  let referralExpiresAt = null;
  if (referralCode) {
    const referrer = db
      .prepare('SELECT id FROM users WHERE referral_code = ?')
      .get(referralCode);
    if (referrer) {
      referredById = referrer.id;
      const expires = new Date();
      expires.setDate(expires.getDate() + REFERRAL_DURATION_DAYS);
      referralExpiresAt = toIso(expires);
    }
  }

  const passwordHash = bcrypt.hashSync(password, 10);
  const code = generateReferralCode(email);

  const stmt = db.prepare(
    `INSERT INTO users (email, password_hash, phone, referral_code, referred_by, referral_expires_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  );
  const info = stmt.run(email, passwordHash, phone, code, referredById, referralExpiresAt);

  const token = signToken({ userId: info.lastInsertRowid });
  res.status(201).json({ token, referralCode: code });
});

app.post('/api/login', (req, res) => {
  const schema = z.object({
    email: z.string().email(),
    password: z.string()
  });

  const result = schema.safeParse(req.body);
  if (!result.success) {
    return res.status(400).json({ error: result.error.flatten() });
  }

  const { email, password } = result.data;
  const user = db.prepare('SELECT id, password_hash FROM users WHERE email = ?').get(email);
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  const token = signToken({ userId: user.id });
  res.json({ token });
});

app.get('/api/profile', authMiddleware, (req, res) => {
  const user = db
    .prepare(
      'SELECT id, email, phone, game_tag, balance, referral_code, referred_by, referral_expires_at FROM users WHERE id = ?'
    )
    .get(req.user.userId);
  if (!user) {
    return res.status(404).json({ error: 'User not found' });
  }

  const matches = db
    .prepare(
      `SELECT m.id, g.name as game, m.mode, m.stake, m.status, m.created_at
       FROM matches m
       JOIN games g ON g.id = m.game_id
       JOIN match_players mp ON mp.match_id = m.id
       WHERE mp.user_id = ?
       ORDER BY m.created_at DESC`
    )
    .all(req.user.userId);

  const referrals = db
    .prepare(
      `SELECT u.email, u.created_at, u.referral_expires_at
       FROM users u
       WHERE u.referred_by = ?`
    )
    .all(req.user.userId);

  res.json({ user, matches, referrals });
});

app.post('/api/wallet/topup', authMiddleware, (req, res) => {
  const schema = z.object({ amount: z.number().int().positive() });
  const result = schema.safeParse(req.body);
  if (!result.success) {
    return res.status(400).json({ error: result.error.flatten() });
  }

  const { amount } = result.data;
  db.prepare(
    'INSERT INTO transactions (user_id, type, amount, status, reference) VALUES (?, ?, ?, ?, ?)'
  ).run(req.user.userId, 'topup', amount, 'pending', 'sandbox');

  res.json({ status: 'pending', message: 'Sandbox topup created' });
});

app.post('/api/wallet/withdraw', authMiddleware, (req, res) => {
  const schema = z.object({ amount: z.number().int().positive() });
  const result = schema.safeParse(req.body);
  if (!result.success) {
    return res.status(400).json({ error: result.error.flatten() });
  }

  const { amount } = result.data;
  const user = db.prepare('SELECT balance FROM users WHERE id = ?').get(req.user.userId);
  if (!user || user.balance < amount) {
    return res.status(400).json({ error: 'Insufficient balance' });
  }

  db.prepare('UPDATE users SET balance = balance - ? WHERE id = ?').run(
    amount,
    req.user.userId
  );
  db.prepare(
    'INSERT INTO transactions (user_id, type, amount, status, reference) VALUES (?, ?, ?, ?, ?)'
  ).run(req.user.userId, 'withdraw', amount, 'pending', 'sandbox');

  res.json({ status: 'pending', message: 'Sandbox withdraw created' });
});

app.post('/api/matches', authMiddleware, (req, res) => {
  const schema = z.object({
    gameId: z.number().int(),
    mode: z.enum(['solo', 'duel']),
    stake: z.number().int().positive(),
    playerLimit: z.number().int().positive()
  });

  const result = schema.safeParse(req.body);
  if (!result.success) {
    return res.status(400).json({ error: result.error.flatten() });
  }

  const { gameId, mode, stake, playerLimit } = result.data;
  const user = db.prepare('SELECT balance FROM users WHERE id = ?').get(req.user.userId);
  if (!user || user.balance < stake) {
    return res.status(400).json({ error: 'Insufficient balance' });
  }

  const matchStmt = db.prepare(
    `INSERT INTO matches (game_id, mode, stake, player_limit, status, creator_id)
     VALUES (?, ?, ?, ?, ?, ?)`
  );
  const info = matchStmt.run(gameId, mode, stake, playerLimit, 'waiting_for_players', req.user.userId);

  db.prepare('INSERT INTO match_players (match_id, user_id, status) VALUES (?, ?, ?)').run(
    info.lastInsertRowid,
    req.user.userId,
    'joined'
  );

  db.prepare('UPDATE users SET balance = balance - ? WHERE id = ?').run(
    stake,
    req.user.userId
  );
  db.prepare(
    'INSERT INTO escrow (match_id, user_id, amount, status) VALUES (?, ?, ?, ?)'
  ).run(info.lastInsertRowid, req.user.userId, stake, 'held');

  res.status(201).json({ matchId: info.lastInsertRowid });
});

app.post('/api/matches/:id/join', authMiddleware, (req, res) => {
  const matchId = Number(req.params.id);
  const match = db.prepare('SELECT * FROM matches WHERE id = ?').get(matchId);
  if (!match) {
    return res.status(404).json({ error: 'Match not found' });
  }
  if (match.status !== 'waiting_for_players') {
    return res.status(400).json({ error: 'Match not accepting players' });
  }

  const existing = db
    .prepare('SELECT 1 FROM match_players WHERE match_id = ? AND user_id = ?')
    .get(matchId, req.user.userId);
  if (existing) {
    return res.status(409).json({ error: 'Already joined' });
  }

  const playerCount = db
    .prepare('SELECT COUNT(*) as count FROM match_players WHERE match_id = ?')
    .get(matchId).count;
  if (playerCount >= match.player_limit) {
    return res.status(400).json({ error: 'Match is full' });
  }

  const user = db.prepare('SELECT balance FROM users WHERE id = ?').get(req.user.userId);
  if (!user || user.balance < match.stake) {
    return res.status(400).json({ error: 'Insufficient balance' });
  }

  db.prepare('INSERT INTO match_players (match_id, user_id, status) VALUES (?, ?, ?)').run(
    matchId,
    req.user.userId,
    'joined'
  );

  db.prepare('UPDATE users SET balance = balance - ? WHERE id = ?').run(
    match.stake,
    req.user.userId
  );
  db.prepare(
    'INSERT INTO escrow (match_id, user_id, amount, status) VALUES (?, ?, ?, ?)'
  ).run(matchId, req.user.userId, match.stake, 'held');

  const updatedCount = playerCount + 1;
  if (updatedCount >= match.player_limit) {
    db.prepare('UPDATE matches SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(
      'ready_to_start',
      matchId
    );
  }

  res.json({ status: 'joined' });
});

app.post('/api/matches/:id/start', authMiddleware, (req, res) => {
  const schema = z.object({ matchCode: z.string().min(3) });
  const result = schema.safeParse(req.body);
  if (!result.success) {
    return res.status(400).json({ error: result.error.flatten() });
  }

  const matchId = Number(req.params.id);
  const match = db.prepare('SELECT * FROM matches WHERE id = ?').get(matchId);
  if (!match) {
    return res.status(404).json({ error: 'Match not found' });
  }
  if (match.creator_id !== req.user.userId) {
    return res.status(403).json({ error: 'Only creator can start match' });
  }
  if (match.status !== 'ready_to_start') {
    return res.status(400).json({ error: 'Match not ready to start' });
  }

  db.prepare('UPDATE matches SET status = ?, match_code = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(
    'in_progress',
    result.data.matchCode,
    matchId
  );

  res.json({ status: 'in_progress' });
});

app.post('/api/matches/:id/finish', authMiddleware, (req, res) => {
  const schema = z.object({ winnerUserId: z.number().int() });
  const result = schema.safeParse(req.body);
  if (!result.success) {
    return res.status(400).json({ error: result.error.flatten() });
  }

  const matchId = Number(req.params.id);
  const match = db.prepare('SELECT * FROM matches WHERE id = ?').get(matchId);
  if (!match) {
    return res.status(404).json({ error: 'Match not found' });
  }
  if (match.creator_id !== req.user.userId) {
    return res.status(403).json({ error: 'Only creator can finish match' });
  }
  if (!['in_progress', 'pending_result'].includes(match.status)) {
    return res.status(400).json({ error: 'Match not in finishable state' });
  }

  const players = db
    .prepare('SELECT user_id FROM match_players WHERE match_id = ?')
    .all(matchId);
  const playerIds = players.map((player) => player.user_id);
  if (!playerIds.includes(result.data.winnerUserId)) {
    return res.status(400).json({ error: 'Winner must be participant' });
  }

  const commissionPerUser = Math.round(match.stake * COMMISSION_RATE);
  const totalPot = match.stake * players.length;
  const totalCommission = commissionPerUser * players.length;
  const winnerPayout = totalPot - totalCommission;

  db.prepare('UPDATE users SET balance = balance + ? WHERE id = ?').run(
    winnerPayout,
    result.data.winnerUserId
  );

  const referrerStmt = db.prepare(
    'SELECT referred_by, referral_expires_at FROM users WHERE id = ?'
  );

  for (const player of players) {
    const user = referrerStmt.get(player.user_id);
    if (!user || !user.referred_by || !user.referral_expires_at) continue;
    const expiresAt = new Date(user.referral_expires_at);
    if (Number.isNaN(expiresAt.getTime()) || expiresAt < new Date()) continue;

    const bonus = Math.round(commissionPerUser * REFERRAL_RATE);
    if (bonus <= 0) continue;

    db.prepare('UPDATE users SET balance = balance + ? WHERE id = ?').run(
      bonus,
      user.referred_by
    );
    db.prepare(
      'INSERT INTO referral_earnings (referrer_id, referred_id, match_id, amount) VALUES (?, ?, ?, ?)'
    ).run(user.referred_by, player.user_id, matchId, bonus);
  }

  db.prepare('UPDATE escrow SET status = ? WHERE match_id = ?').run('settled', matchId);
  db.prepare('UPDATE matches SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(
    'finished',
    matchId
  );

  res.json({ status: 'finished', winnerPayout, totalCommission });
});

app.listen(process.env.PORT || 3000, () => {
  console.log(`MVP API running on port ${process.env.PORT || 3000}`);
});
