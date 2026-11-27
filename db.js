/**
 * Простое файловое хранилище (JSON).
 * Для продакшена позже можно заменить на Postgres/SQLite — API тот же.
 */
'use strict';

const fs = require('fs');
const path = require('path');
let sb = null;
try { sb = require('./db-supabase'); } catch (e) {}

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');

const BOSS_MAX_HP = 5000000;
const BOSS_LVL = 10;

function defaultDb() {
  return {
    players: {},   // id -> { id, name, power, level, verified, updatedAt }
    clans: {},     // id -> clan object
    rating: [],    // cached list optional
    tx: {}         // txId -> timestamp (anti-duplicate)
  };
}

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function load() {
  ensureDir();
  if (!fs.existsSync(DB_FILE)) {
    const db = defaultDb();
    save(db);
    return db;
  }
  try {
    const raw = fs.readFileSync(DB_FILE, 'utf8');
    const db = JSON.parse(raw);
    db.players = db.players || {};
    db.clans = db.clans || {};
    db.tx = db.tx || {};
    return db;
  } catch (e) {
    console.error('[db] load failed, using empty', e.message);
    return defaultDb();
  }
}

let _db = null;
let _saveTimer = null;

function getDb() {
  if (!_db) _db = load();
  return _db;
}

function save(db) {
  ensureDir();
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 0), 'utf8');
  fs.renameSync(tmp, DB_FILE);
}

function scheduleSave() {
  if (_saveTimer) return;
  _saveTimer = setTimeout(() => {
    _saveTimer = null;
    try {
      const db = getDb();
      save(db);
      if (sb && sb.saveClan) {
        Object.values(db.clans || {}).forEach(c => sb.saveClan(c).catch(() => {}));
      }
    } catch (e) {
      console.error('[db] save failed', e.message);
    }
  }, 200);
}

function mondayKey(d) {
  const x = new Date(d || Date.now());
  const day = x.getUTCDay(); // 0 Sun
  const diff = day === 0 ? -6 : 1 - day;
  x.setUTCDate(x.getUTCDate() + diff);
  x.setUTCHours(0, 0, 0, 0);
  return x.toISOString().slice(0, 10);
}

function defaultClan(id, name) {
  return {
    id: id,
    name: name || 'Astoria',
    lvl: 1,
    exp: 0,
    pts: 0,
    bossLvl: BOSS_LVL,
    bossHp: BOSS_MAX_HP,
    bossWeek: mondayKey(),
    actPts: 0,
    actClaimed: {},
    builds: {},
    members: [],
    bossRewards: [],
    bossKillSeq: 0,
    mvpPending: null,
    updatedAt: Date.now()
  };
}

function getOrCreateClan(clanId) {
  const db = getDb();
  const id = clanId || 'global_astoria_clan';
  if (!db.clans[id]) {
    db.clans[id] = defaultClan(id, id === 'global_astoria_clan' ? 'Astoria' : id);
    scheduleSave();
  }
  return db.clans[id];
}

/** Сброс недели босса: обнуление урона, восстановление HP, MVP */
function tickClanWeek(clan) {
  const wk = mondayKey();
  if (clan.bossWeek === wk) return false;
  // MVP прошлой недели
  let top = null;
  (clan.members || []).forEach(m => {
    if (!m || !m.id) return;
    const d = m.bossDmg || 0;
    if (d <= 0) return;
    if (!top || d > top.dmg) top = { id: m.id, name: m.name, dmg: d };
  });
  if (top) {
    clan.mvpPending = {
      playerId: top.id,
      name: top.name,
      dmg: top.dmg,
      week: clan.bossWeek,
      at: Date.now()
    };
  }
  (clan.members || []).forEach(m => { m.bossDmg = 0; });
  clan.bossWeek = wk;
  clan.bossHp = BOSS_MAX_HP;
  clan.bossLvl = BOSS_LVL;
  clan.bossDefeatedThisWeek = false;
  clan.updatedAt = Date.now();
  scheduleSave();
  return true;
}

function upsertPlayer(p) {
  if (!p || !p.id) return null;
  const db = getDb();
  const id = String(p.id).slice(0, 64);
  const prev = db.players[id] || {};
  const row = {
    id,
    name: String(p.name || prev.name || 'Player').slice(0, 24),
    power: Math.max(0, Math.round(+p.power || prev.power || 0)),
    level: Math.max(1, Math.round(+p.level || prev.level || 1)),
    verified: p.verified === true || prev.verified === true,
    updatedAt: Date.now()
  };
  // гости plr_ не в verified
  if (/^(plr_|tx_|m_\d+_)/i.test(id)) row.verified = false;
  db.players[id] = row;
  scheduleSave();
  return row;
}

function getRating(by, limit) {
  const db = getDb();
  const key = by === 'level' ? 'level' : 'power';
  const list = Object.values(db.players)
    .filter(p => p && p.name && !/^(plr_|tx_|m_\d+_)/i.test(p.id))
    .sort((a, b) => (b[key] || 0) - (a[key] || 0) || (b.power || 0) - (a.power || 0))
    .slice(0, Math.min(100, limit || 50));
  return list.map((p, i) => ({
    rank: i + 1,
    id: p.id,
    name: p.name,
    power: p.power,
    level: p.level
  }));
}

function markTx(txId) {
  if (!txId) return false;
  const db = getDb();
  if (db.tx[txId]) return false;
  db.tx[txId] = Date.now();
  // чистка старых
  const keys = Object.keys(db.tx);
  if (keys.length > 5000) {
    keys.sort((a, b) => db.tx[a] - db.tx[b]);
    keys.slice(0, keys.length - 3000).forEach(k => delete db.tx[k]);
  }
  scheduleSave();
  return true;
}

function publicClan(clan) {
  return {
    id: clan.id,
    name: clan.name,
    lvl: clan.lvl,
    exp: clan.exp,
    pts: clan.pts || 0,
    bossHp: clan.bossHp,
    bossLvl: clan.bossLvl,
    bossWeek: clan.bossWeek,
    bossDefeatedThisWeek: !!clan.bossDefeatedThisWeek,
    recruit: clan.recruit || 'free',
    applicants: clan.applicants || [],
    actPts: clan.actPts || 0,
    actClaimed: clan.actClaimed || {},
    builds: clan.builds || {},
    members: (clan.members || []).map(m => ({
      id: m.id,
      name: m.name,
      role: m.role || 'member',
      contrib: m.contrib || 0,
      bossDmg: m.bossDmg || 0,
      power: m.power || 0
    })),
    bossRewards: clan.bossRewards || [],
    mvpPending: clan.mvpPending || null,
    updatedAt: clan.updatedAt
  };
}

module.exports = {
  BOSS_MAX_HP,
  BOSS_LVL,
  getDb,
  scheduleSave,
  getOrCreateClan,
  tickClanWeek,
  upsertPlayer,
  getRating,
  markTx,
  publicClan,
  mondayKey
};
