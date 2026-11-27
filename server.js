/**
 * Magic Battle — API-сервер без внешних зависимостей (только Node.js).
 * Совместим с js/net.js клиента.
 *
 * Запуск:  node server.js
 * Порт:    process.env.PORT || 3000
 */
'use strict';

const http = require('http');
const crypto = require('crypto');
const db = require('./db');
const sb = require('./db-supabase');

const PORT = process.env.PORT || 3000;
const CLAN_FIGHT_XP = 20;
const CLAN_FIGHT_CC = 20;
const CLAN_KILL_XP = 500;
const CLAN_KILL_CC = 400;
const CLAN_FIGHT_EXP = 5;
const CLAN_KILL_EXP = 40;
const MAX_DAMAGE_PER_BATTLE = 2000000;

function send(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Length': Buffer.byteLength(body)
  });
  res.end(body);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', c => {
      size += c.length;
      if (size > 256 * 1024) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

function parseUrl(req) {
  return new URL(req.url || '/', 'http://localhost');
}

function ensureMember(clan, player) {
  if (!player || !player.id) return null;
  if (!Array.isArray(clan.members)) clan.members = [];
  let row = clan.members.find(m => m.id === player.id);
  if (!row) {
    row = {
      id: player.id,
      name: String(player.name || 'Player').slice(0, 24),
      role: clan.members.length === 0 ? 'leader' : 'member',
      contrib: 0,
      bossDmg: 0,
      power: Math.max(0, Math.round(+player.power || 0))
    };
    clan.members.push(row);
  } else {
    if (player.name) row.name = String(player.name).slice(0, 24);
    if (player.power != null) row.power = Math.max(0, Math.round(+player.power || 0));
  }
  return row;
}

function addClanExp(clan, amount) {
  clan.exp = (clan.exp || 0) + (amount || 0);
  while (clan.lvl < 20) {
    const need = 80 * clan.lvl;
    if (clan.exp < need) break;
    clan.exp -= need;
    clan.lvl += 1;
    clan.pts = (clan.pts || 0) + 1;
  }
}

const rooms = new Map();

function broadcastClan(clanId, event) {
  const set = rooms.get(clanId);
  if (!set || !set.size) return;
  const clan = db.getOrCreateClan(clanId);
  db.tickClanWeek(clan);
  const payload = JSON.stringify({
    type: 'clan_state',
    event: event || null,
    clan: db.publicClan(clan)
  });
  for (const client of set) {
    try { client.send(payload); } catch (e) { /* */ }
  }
}

function acceptWs(req, socket) {
  const key = req.headers['sec-websocket-key'];
  if (!key) { socket.destroy(); return; }
  const accept = crypto
    .createHash('sha1')
    .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
    .digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
    'Sec-WebSocket-Accept: ' + accept + '\r\n\r\n'
  );

  let clanId = 'global_astoria_clan';
  try {
    const u = new URL(req.url || '', 'http://localhost');
    clanId = u.searchParams.get('clanId') || clanId;
  } catch (e) { /* */ }

  const client = {
    alive: true,
    lastPong: Date.now(),
    send(data) {
      if (!this.alive) return;
      const payload = Buffer.from(String(data));
      const len = payload.length;
      let header;
      if (len < 126) {
        header = Buffer.alloc(2); header[0] = 0x81; header[1] = len;
      } else if (len < 65536) {
        header = Buffer.alloc(4); header[0] = 0x81; header[1] = 126; header.writeUInt16BE(len, 2);
      } else {
        header = Buffer.alloc(10); header[0] = 0x81; header[1] = 127;
        header.writeUInt32BE(0, 2); header.writeUInt32BE(len, 6);
      }
      socket.write(Buffer.concat([header, payload]));
    },
    close() { this.alive = false; try { socket.end(); } catch (e) {} }
  };

  if (!rooms.has(clanId)) rooms.set(clanId, new Set());
  rooms.get(clanId).add(client);

  const clan = db.getOrCreateClan(clanId);
  db.tickClanWeek(clan);
  client.send(JSON.stringify({ type: 'clan_state', event: null, clan: db.publicClan(clan) }));

  const pingInterval = setInterval(() => {
    if (!client.alive) { clearInterval(pingInterval); return; }
    if (Date.now() - client.lastPong > 60000) { client.close(); clearInterval(pingInterval); return; }
    try { client.send(JSON.stringify({ type: 'ping', ts: Date.now() })); } catch (e) {}
  }, 25000);

  socket.on('data', buf => {
    try {
      const str = buf.toString();
      if (str.includes('pong')) client.lastPong = Date.now();
    } catch (e) {}
  });
  socket.on('close', () => {
    clearInterval(pingInterval);
    client.alive = false;
    const set = rooms.get(clanId);
    if (set) { set.delete(client); if (!set.size) rooms.delete(clanId); }
  });
  socket.on('error', () => { clearInterval(pingInterval); client.close(); });
}

const analyticsLog = [];
const MAX_ANALYTICS = 5000;
const playerProfiles = new Map();

function logAnalytics(entry) {
  analyticsLog.push(entry);
  if (analyticsLog.length > MAX_ANALYTICS) analyticsLog.shift();
}

const clanNames = new Map();
const clanEmblems = new Map();

function getClanName(id, fallback) {
  return clanNames.get(id) || fallback || 'Клан';
}

function getClanEmblem(id) {
  return clanEmblems.get(id) || null;
}

function setClanName(id, name, emblem) {
  if (!id) return;
  if (!name) {
    clanNames.delete(id);
    clanEmblems.delete(id);
    sb.saveClanMeta(id, null, null).catch(() => {});
  } else {
    clanNames.set(id, String(name).slice(0, 20));
    if (emblem) clanEmblems.set(id, emblem);
    sb.saveClanMeta(id, name, emblem).catch(() => {});
  }
}

function loadClanNames() {
  try {
    const fs = require('fs');
    const data = fs.readFileSync('/tmp/clan_names.json', 'utf8');
    const entries = JSON.parse(data);
    entries.forEach(([id, name]) => clanNames.set(id, name));
    const embData = fs.readFileSync('/tmp/clan_emblems.json', 'utf8');
    const embEntries = JSON.parse(embData);
    embEntries.forEach(([id, emb]) => clanEmblems.set(id, emb));
  } catch (e) {}
}
loadClanNames();

let _profileSaveTimer = null;
function scheduleProfileSave() {
  if (_profileSaveTimer) return;
  _profileSaveTimer = setTimeout(() => {
    _profileSaveTimer = null;
    playerProfiles.forEach((p, id) => {
      sb.saveProfile(id, p).catch(() => {});
    });
  }, 2000);
}

function saveProfile(id, data) {
  if (!id) return;
  const prev = playerProfiles.get(id) || {};
  const profile = {
    id: id,
    name: data.name || prev.name || 'Игрок',
    power: data.power != null ? data.power : (prev.power || 0),
    level: data.level != null ? data.level : (prev.level || 0),
    avatar: data.avatar || prev.avatar || 'viking',
    unlocked: Array.isArray(data.unlocked) ? data.unlocked : (prev.unlocked || ['viking']),
    heroLevels: (function() {
      const hl = data.heroLevels || prev.heroLevels || {};
      const out = {};
      const maxLvl = 999;
      for (const k in hl) {
        const v = Math.floor(+hl[k] || 1);
        if (v >= 1 && v <= maxLvl) out[k] = v;
      }
      return out;
    })(),
    verified: data.verified != null ? data.verified : (prev.verified || false),
    ts: Date.now()
  };
  playerProfiles.set(id, profile);
  sb.saveProfile(id, profile).catch(e => console.log('Save profile error:', e.message));
  console.log('Saved profile:', id, profile.name, profile.power);
}

function loadProfiles() {
  try {
    const fs = require('fs');
    const data = fs.readFileSync('/tmp/profiles.json', 'utf8');
    const entries = JSON.parse(data);
    entries.forEach(([id, p]) => playerProfiles.set(id, p));
  } catch (e) {}
}
loadProfiles();

(async () => {
  try {
    const meta = await sb.loadClanNames();
    if (meta.names) meta.names.forEach(([id, name]) => clanNames.set(id, name));
    if (meta.emblems) meta.emblems.forEach(([id, emb]) => clanEmblems.set(id, emb));
    const profs = await sb.loadProfiles();
    console.log('Supabase profiles raw:', profs ? profs.length : 0);
    if (profs) {
      profs.forEach(([id, p]) => {
        playerProfiles.set(id, p);
        console.log('Loaded profile:', id, p.name, p.power);
      });
    }
    const clans = await sb.loadAllClans();
    console.log('Supabase clans raw:', clans ? clans.length : 0);
    if (clans) {
      clans.forEach(c => {
        if (c && c.id) {
          const dbData = db.getDb();
          dbData.clans[c.id] = c;
          console.log('Loaded clan:', c.id, 'members:', (c.members || []).length);
        }
      });
    }
    console.log('Supabase loaded:', clanNames.size, 'clan names,', playerProfiles.size, 'profiles');
  } catch (e) {
    console.log('Supabase load error:', e.message);
  }
})();

function getProfile(id) {
  return playerProfiles.get(id) || null;
}

async function handle(req, res) {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    });
    return res.end();
  }

  const u = parseUrl(req);
  const path = u.pathname.replace(/\/+$/, '') || '/';

  try {
    let m;
    if (req.method === 'POST' && path.match(/^\/clans\/[^/]+\/rename$/)) {
      const m = path.match(/^\/clans\/([^/]+)\/rename$/);
      const clanId = decodeURIComponent(m[1]);
      const body = await readJson(req);
      setClanName(clanId, body.name || '', body.emblem);
      const clan = db.getOrCreateClan(clanId);
      const pub = db.publicClan(clan);
      pub.name = getClanName(clanId, pub.name);
      return send(res, 200, { ok: true, clan: pub });
    }

    m = path.match(/^\/clans\/([^/]+)\/leave$/);
    if (req.method === 'POST' && m) {
      const clan = db.getOrCreateClan(decodeURIComponent(m[1]));
      const body = await readJson(req);
      const playerId = body.playerId;
      if (playerId) {
        clan.members = (clan.members || []).filter(mb => mb.id !== playerId);
        if (clan.members.length === 0) {
          clanNames.delete(decodeURIComponent(m[1]));
        }
      }
      clan.updatedAt = Date.now();
      db.scheduleSave();
      return send(res, 200, { ok: true });
    }

    m = path.match(/^\/clans\/([^/]+)\/role$/);
    if (req.method === 'POST' && m) {
      const clan = db.getOrCreateClan(decodeURIComponent(m[1]));
      const body = await readJson(req);
      const playerId = body.playerId;
      const role = body.role;
      if (playerId && role) {
        const member = (clan.members || []).find(mb => mb.id === playerId);
        if (member) {
          if (role === 'leader') {
            (clan.members || []).forEach(mb => { if (mb.role === 'leader') mb.role = 'officer'; });
          }
          member.role = role;
          clan.updatedAt = Date.now();
          db.scheduleSave();
          console.log('Role changed:', playerId, role);
        }
      }
      return send(res, 200, { ok: true });
    }

    m = path.match(/^\/clans\/([^/]+)\/appstatus$/);
    if (req.method === 'GET' && m) {
      const clanId = decodeURIComponent(m[1]);
      const clan = db.getOrCreateClan(clanId);
      const playerId = u.searchParams.get('id');
      const applicants = clan.applicants || [];
      const pending = applicants.some(a => a.id === playerId);
      console.log('AppStatus:', clanId, 'player:', playerId, 'applicants:', applicants.length, 'pending:', pending);
      return send(res, 200, { ok: true, pending });
    }

    m = path.match(/^\/clans\/([^/]+)\/join$/);
    if (req.method === 'POST' && m) {
      const clanId = decodeURIComponent(m[1]);
      const clan = db.getOrCreateClan(clanId);
      const body = await readJson(req);
      const player = body.player || {};
      if (!player.id) return send(res, 400, { error: 'player.id required' });
      clan.members = clan.members || [];
      if (!clan.members.some(mb => mb.id === player.id)) {
        clan.members.push({ id: player.id, name: player.name || 'Игрок', power: player.power || 0, role: player.role || 'member', contrib: 0, bossDmg: 0 });
      }
      clan.updatedAt = Date.now();
      db.scheduleSave();
      console.log('Clan join:', clanId, 'members:', clan.members.length);
      return send(res, 200, { ok: true, clan: db.publicClan(clan) });
    }

    if (req.method === 'GET' && path === '/vkplay/billing') {
      const uid = u.searchParams.get('uid');
      const sum = u.searchParams.get('sum');
      const tid = u.searchParams.get('tid');
      const merchantParam = u.searchParams.get('merchant_param');
      const sign = u.searchParams.get('sign');
      console.log('VK Play billing:', { uid, sum, tid, merchantParam, sign });
      if (!uid || !tid) return send(res, 400, { error: 'uid and tid required' });
      if (!db.markTx('vkplay_' + tid)) {
        console.log('VK Play duplicate:', tid);
        return send(res, 200, { ok: true, duplicate: true });
      }
      let itemId = null;
      try {
        const mp = JSON.parse(merchantParam || '{}');
        itemId = mp.item_id || mp.itemId;
      } catch (e) {}
      console.log('VK Play payment processed:', uid, sum, itemId);
      return send(res, 200, { ok: true, uid, sum, itemId });
    }

    if (req.method === 'GET' && (path === '/' || path === '/health')) {
      return send(res, 200, { ok: true, service: 'magic-battle-server', version: '1.0.0', time: Date.now() });
    }

    if (req.method === 'POST' && path === '/players/upsert') {
      const body = await readJson(req);
      const id = body.id || (body.player && body.player.id);
      if (!id) return send(res, 400, { error: 'id required' });
      saveProfile(id, {
        name: body.name || (body.player && body.player.name),
        power: body.power != null ? body.power : (body.player && body.player.power),
        level: body.level != null ? body.level : (body.player && body.player.level),
        avatar: body.avatar,
        unlocked: body.unlocked,
        heroLevels: body.heroLevels,
        verified: body.verified != null ? body.verified : (body.player && body.player.verified)
      });
      const row = db.upsertPlayer({
        id: id,
        name: body.name || (body.player && body.player.name),
        power: body.power != null ? body.power : (body.player && body.player.power),
        level: body.level != null ? body.level : (body.player && body.player.level),
        verified: body.verified != null ? body.verified : (body.player && body.player.verified)
      });
      return send(res, 200, { ok: true, player: getProfile(id) });
    }

    if (req.method === 'GET' && path === '/players/profile') {
      const id = u.searchParams.get('id');
      const p = getProfile(id);
      if (!p) return send(res, 404, { error: 'not found' });
      return send(res, 200, { ok: true, profile: p });
    }

    if (req.method === 'POST' && path === '/rating') {
      const body = await readJson(req);
      const row = db.upsertPlayer({
        id: body.id,
        name: body.name,
        power: body.power,
        level: body.level,
        verified: true
      });
      if (!row) return send(res, 400, { error: 'id required' });
      saveProfile(body.id, { name: body.name, power: body.power, level: body.level, verified: true });
      return send(res, 200, { ok: true });
    }

    if (req.method === 'POST' && path === '/analytics') {
      const body = await readJson(req);
      const playerId = String(body.playerId || '').trim();
      if (!playerId) return send(res, 400, { error: 'playerId required' });
      logAnalytics({
        playerId: playerId,
        name: String(body.name || '').slice(0, 24),
        event: String(body.event || 'unknown').slice(0, 32),
        level: Math.max(0, Math.floor(+body.level || 0)),
        power: Math.max(0, Math.floor(+body.power || 0)),
        sessionMs: Math.max(0, Math.floor(+body.sessionMs || 0)),
        extra: body.extra || null,
        ts: Date.now()
      });
      return send(res, 200, { ok: true });
    }

    if (req.method === 'GET' && path === '/analytics') {
      const limit = Math.min(500, Math.max(1, parseInt(u.searchParams.get('limit') || '100', 10)));
      const playerId = u.searchParams.get('playerId');
      let list = analyticsLog.slice(-limit);
      if (playerId) list = list.filter(e => e.playerId === playerId);
      return send(res, 200, { ok: true, count: list.length, list: list });
    }

    if (req.method === 'GET' && path === '/clans/mymembership') {
      const playerId = u.searchParams.get('id');
      if (!playerId) return send(res, 400, { error: 'id required' });
      const dbData = db.getDb();
      console.log('MyMembership check:', playerId, 'clans:', Object.keys(dbData.clans || {}).length);
      for (const [clanId, clan] of Object.entries(dbData.clans || {})) {
        const members = clan.members || [];
        const found = members.find(m => m.id === playerId);
        if (found) {
          console.log('Found in clan:', clanId, 'role:', found.role);
          return send(res, 200, { ok: true, clanId, clanName: clanNames.get(clanId) || clan.name });
        }
      }
      console.log('Not found in any clan');
      return send(res, 200, { ok: true, clanId: null });
    }

    if (req.method === 'GET' && path === '/clans/top') {
      const list = [];
      const dbData = db.getDb();
      for (const [id, name] of clanNames.entries()) {
        if (!name || name === 'Клан') continue;
        let clan = dbData.clans[id];
        if (!clan) {
          clan = db.getOrCreateClan(id);
        }
        const members = clan.members || [];
        if (members.length === 0) continue;
        const power = members.reduce((s, m) => s + (m.power || 0), 0);
        list.push({ id, name, lvl: clan.lvl || 1, members: members.length, power, emblem: getClanEmblem(id) || clan.emblem || null, bossDefeated: !!clan.bossDefeatedThisWeek, recruit: clan.recruit || 'free' });
      }
      list.sort((a, b) => b.power - a.power || b.lvl - a.lvl);
      return send(res, 200, { ok: true, list: list.slice(0, 50) });
    }

    if (req.method === 'GET' && path === '/rating') {
      const by = u.searchParams.get('by') === 'level' ? 'level' : 'power';
      const limit = Math.min(100, Math.max(1, parseInt(u.searchParams.get('limit') || '50', 10)));
      const profiles = [];
      playerProfiles.forEach((p, id) => {
        if (p && p.name && !/^(plr_|tx_|m_\d+_)/i.test(id)) {
          profiles.push({ id, name: p.name, power: p.power || 0, level: p.level || 0, avatar: p.avatar || 'viking', unlocked: p.unlocked || ['viking'], heroLevels: p.heroLevels || {} });
        }
      });
      console.log('Rating request: total profiles', playerProfiles.size, 'filtered', profiles.length);
      profiles.sort((a, b) => (b[by] || 0) - (a[by] || 0));
      const list = profiles.slice(0, limit).map((p, i) => ({ rank: i + 1, ...p }));
      return send(res, 200, { ok: true, by, list });
    }

    m = path.match(/^\/clans\/([^/]+)$/);
    if (req.method === 'GET' && m) {
      const clanId = decodeURIComponent(m[1]);
      const clan = db.getOrCreateClan(clanId);
      db.tickClanWeek(clan);
      db.scheduleSave();
      const pub = db.publicClan(clan);
      const storedName = getClanName(clanId, null);
      if (storedName) pub.name = storedName;
      return send(res, 200, { ok: true, clan: pub });
    }

    m = path.match(/^\/clans\/([^/]+)\/battle$/);
    if (req.method === 'POST' && m) {
      const clan = db.getOrCreateClan(decodeURIComponent(m[1]));
      db.tickClanWeek(clan);
      const body = await readJson(req);
      const player = body.player || {};
      if (!player.id) return send(res, 400, { error: 'player.id required' });

      const txId = body.txId || ('boss_battle_' + Date.now());
      if (!db.markTx(txId)) {
        return send(res, 200, {
          ok: true, duplicate: true, clan: db.publicClan(clan),
          reward: { dealt: 0, sparks: 0, ore: 0, gems: 0, xp: 0, cc: 0, items: [], notes: [], duplicate: true }
        });
      }

      const fled = !!body.fled;
      let dealt = Math.max(0, Math.round(+body.dealt || 0));
      dealt = Math.min(dealt, MAX_DAMAGE_PER_BATTLE, Math.max(0, clan.bossHp));
      const member = ensureMember(clan, player);
      const reward = { dealt, sparks: 0, ore: 0, gems: 0, xp: CLAN_FIGHT_XP, cc: CLAN_FIGHT_CC, items: [], notes: [], win: false };
      let defeated = false;

      if (!fled && dealt > 0) {
        reward.sparks = Math.round(dealt / 300);
        member.bossDmg = (member.bossDmg || 0) + dealt;
        member.contrib = (member.contrib || 0) + 5;
        clan.actPts = (clan.actPts || 0) + 5;
        addClanExp(clan, CLAN_FIGHT_EXP);
        clan.bossHp = Math.max(0, clan.bossHp - dealt);
        if (clan.bossHp <= 0) {
          defeated = true;
          clan.bossDefeatedThisWeek = true;
          reward.win = true;
          reward.gems = 200;
          reward.ore = 200;
          reward.xp += CLAN_KILL_XP;
          reward.cc += CLAN_KILL_CC;
          reward.notes.push('Boss defeated!');
          addClanExp(clan, CLAN_KILL_EXP);
          clan.bossKillSeq = (clan.bossKillSeq || 0) + 1;
          if (!Array.isArray(clan.bossRewards)) clan.bossRewards = [];
          clan.bossRewards.push({ id: 'kill_' + clan.bossKillSeq + '_' + Date.now().toString(36), xp: CLAN_KILL_XP, cc: CLAN_KILL_CC, at: Date.now() });
          if (clan.bossRewards.length > 8) clan.bossRewards = clan.bossRewards.slice(-8);
          clan.bossHp = db.BOSS_MAX_HP;
          clan.bossLvl = db.BOSS_LVL;
        } else {
          clan.bossHp = Math.max(1, clan.bossHp);
        }
      }

      clan.updatedAt = Date.now();
      db.scheduleSave();
      broadcastClan(clan.id, { kind: 'battle', playerName: player.name, dealt, defeated });
      return send(res, 200, { ok: true, clan: db.publicClan(clan), reward });
    }

    m = path.match(/^\/clans\/([^/]+)\/donate$/);
    if (req.method === 'POST' && m) {
      const clan = db.getOrCreateClan(decodeURIComponent(m[1]));
      db.tickClanWeek(clan);
      const body = await readJson(req);
      const player = body.player || {};
      if (!player.id) return send(res, 400, { error: 'player.id required' });
      const count = Math.max(1, Math.min(50, +body.count || 1));
      const member = ensureMember(clan, player);
      const act = 10 * count;
      member.contrib = (member.contrib || 0) + act;
      clan.actPts = (clan.actPts || 0) + act;
      addClanExp(clan, 25 * count);
      clan.updatedAt = Date.now();
      db.scheduleSave();
      broadcastClan(clan.id, { kind: 'donate', playerName: player.name, count });
      return send(res, 200, { ok: true, clan: db.publicClan(clan) });
    }

    m = path.match(/^\/clans\/([^/]+)\/build$/);
    if (req.method === 'POST' && m) {
      const clan = db.getOrCreateClan(decodeURIComponent(m[1]));
      const body = await readJson(req);
      const player = body.player || {};
      const key = body.buildKey;
      if (!player.id || !key) return send(res, 400, { error: 'player.id and buildKey required' });
      ensureMember(clan, player);
      if ((clan.pts || 0) < 1) return send(res, 400, { error: 'no points', clan: db.publicClan(clan) });
      clan.builds = clan.builds || {};
      const cur = clan.builds[key] || 0;
      if (cur >= 20) return send(res, 400, { error: 'max level', clan: db.publicClan(clan) });
      clan.builds[key] = cur + 1;
      clan.pts = (clan.pts || 0) - 1;
      clan.updatedAt = Date.now();
      db.scheduleSave();
      broadcastClan(clan.id, { kind: 'build', buildKey: key });
      return send(res, 200, { ok: true, clan: db.publicClan(clan) });
    }

    m = path.match(/^\/clans\/([^/]+)\/approve$/);
    if (req.method === 'POST' && m) {
      const clan = db.getOrCreateClan(decodeURIComponent(m[1]));
      const body = await readJson(req);
      const appId = body.appId;
      clan.applicants = clan.applicants || [];
      const idx = clan.applicants.findIndex(a => a.id === appId);
      if (idx >= 0) {
        const ap = clan.applicants.splice(idx, 1)[0];
        clan.members = clan.members || [];
        if (!clan.members.some(m => m.id === ap.id)) {
          clan.members.push({ id: ap.id, name: ap.name, power: ap.power || 0, role: 'member', contrib: 0, bossDmg: 0 });
        }
      }
      clan.updatedAt = Date.now();
      db.scheduleSave();
      return send(res, 200, { ok: true, clan: db.publicClan(clan) });
    }

    m = path.match(/^\/clans\/([^/]+)\/reject$/);
    if (req.method === 'POST' && m) {
      const clan = db.getOrCreateClan(decodeURIComponent(m[1]));
      const body = await readJson(req);
      const appId = body.appId;
      clan.applicants = clan.applicants || [];
      clan.applicants = clan.applicants.filter(a => a.id !== appId);
      clan.updatedAt = Date.now();
      db.scheduleSave();
      return send(res, 200, { ok: true, clan: db.publicClan(clan) });
    }

    m = path.match(/^\/clans\/([^/]+)\/apply$/);
    if (req.method === 'POST' && m) {
      const clan = db.getOrCreateClan(decodeURIComponent(m[1]));
      const body = await readJson(req);
      const player = body.player || {};
      if (!player.id) return send(res, 400, { error: 'player.id required' });
      clan.applicants = clan.applicants || [];
      if (!clan.applicants.some(a => a.id === player.id)) {
        clan.applicants.push({ id: player.id, name: player.name || 'Игрок', power: player.power || 0, at: Date.now() });
        if (clan.applicants.length > 50) clan.applicants = clan.applicants.slice(-50);
      }
      clan.updatedAt = Date.now();
      db.scheduleSave();
      return send(res, 200, { ok: true });
    }

    m = path.match(/^\/clans\/([^/]+)\/recruit$/);
    if (req.method === 'POST' && m) {
      const clan = db.getOrCreateClan(decodeURIComponent(m[1]));
      const body = await readJson(req);
      const mode = body.recruit;
      if (mode === 'free' || mode === 'apply' || mode === 'closed') {
        clan.recruit = mode;
        clan.updatedAt = Date.now();
        db.scheduleSave();
      }
      return send(res, 200, { ok: true, clan: db.publicClan(clan) });
    }

    m = path.match(/^\/clans\/([^/]+)\/chest$/);
    if (req.method === 'POST' && m) {
      const clan = db.getOrCreateClan(decodeURIComponent(m[1]));
      const body = await readJson(req);
      const player = body.player || {};
      const idx = +body.chestIdx;
      if (!player.id || !Number.isFinite(idx)) return send(res, 400, { error: 'player.id and chestIdx required' });
      ensureMember(clan, player);
      clan.actClaimed = clan.actClaimed || {};
      const claimKey = player.id + '_' + idx;
      if (clan.actClaimed[claimKey]) return send(res, 200, { ok: true, already: true, clan: db.publicClan(clan) });
      clan.actClaimed[claimKey] = Date.now();
      clan.updatedAt = Date.now();
      db.scheduleSave();
      return send(res, 200, { ok: true, clan: db.publicClan(clan) });
    }

    send(res, 404, { error: 'not found', path });
  } catch (e) {
    console.error('[error]', e);
    send(res, 500, { error: 'server error', message: String(e.message || e) });
  }
}

const server = http.createServer((req, res) => { handle(req, res); });
server.on('upgrade', (req, socket) => {
  const u = parseUrl(req);
  if (u.pathname === '/ws' || u.pathname === '/ws/') acceptWs(req, socket);
  else socket.destroy();
});

server.listen(PORT, () => {
  console.log('[magic-battle-server] http://localhost:' + PORT);
  console.log('  GET  /health');
  console.log('  GET  /rating');
  console.log('  POST /rating');
  console.log('  GET  /clans/global_astoria_clan');
  console.log('  POST /clans/:id/battle');
  console.log('  WS   /ws?clanId=global_astoria_clan');
});
