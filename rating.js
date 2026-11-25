// rating.js — модуль рейтинга для magic-battle-server
// Подключи в основной server.js: app.use('/rating', require('./rating'));

const express = require('express');
const router = express.Router();

// In-memory store (для продакшена замени на Redis / Postgres)
const players = new Map();

// Тестовая запись, чтобы не было пусто
players.set('test1', { id: 'test1', name: 'Test', power: 100, level: 1, ts: Date.now() });

function list(by) {
  const arr = Array.from(players.values());
  arr.sort((a, b) => (b[by] || 0) - (a[by] || 0));
  return arr.slice(0, 100).map((p, i) => ({
    rank: i + 1,
    id: p.id,
    name: p.name,
    power: p.power || 0,
    level: p.level || 0
  }));
}

// GET /rating?by=power|level
router.get('/', (req, res) => {
  const by = req.query.by === 'level' ? 'level' : 'power';
  res.json({ ok: true, by, list: list(by) });
});

// POST /rating  { id, name, power, level }
router.post('/', (req, res) => {
  const b = req.body || {};
  const id = String(b.id || '').trim();
  const name = String(b.name || 'Игрок').trim().slice(0, 24);
  const power = Math.max(0, Math.floor(Number(b.power) || 0));
  const level = Math.max(0, Math.floor(Number(b.level) || 0));
  if (!id || id.length < 2 || id.length > 64) {
    return res.status(400).json({ ok: false, error: 'bad id' });
  }
  if (/^(plr_|m_\d+_)/i.test(id)) {
    return res.status(400).json({ ok: false, error: 'guest id not allowed' });
  }
  const prev = players.get(id) || {};
  players.set(id, {
    id,
    name: name || prev.name || 'Игрок',
    power: Math.max(power, prev.power || 0),
    level: Math.max(level, prev.level || 0),
    ts: Date.now()
  });
  res.json({ ok: true });
});

module.exports = router;
