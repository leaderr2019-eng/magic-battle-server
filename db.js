// db-supabase.js — сохранение кланов в Supabase
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_KEY = process.env.SUPABASE_KEY || '';

let supabase = null;
if (SUPABASE_URL && SUPABASE_KEY) {
  supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
}

const BOSS_MAX_HP = 5000000;
const BOSS_LVL = 100;

function mondayKey(d) {
  const n = d instanceof Date ? d : new Date(d || Date.now());
  const day = n.getUTCDay();
  const diff = day === 0 ? 6 : day - 1;
  const mon = new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate() - diff));
  return mon.toISOString().slice(0, 10);
}

async function loadClan(id) {
  if (!supabase) return null;
  const { data, error } = await supabase.from('clans').select('*').eq('id', id).single();
  if (error || !data) return null;
  return data.data || null;
}

async function saveClan(clan) {
  if (!supabase || !clan || !clan.id) return;
  await supabase.from('clans').upsert({ id: clan.id, data: clan, updated_at: new Date().toISOString() });
}

async function loadAllClans() {
  if (!supabase) return [];
  const { data } = await supabase.from('clans').select('id, data');
  return (data || []).map(r => r.data).filter(Boolean);
}

async function deleteClan(id) {
  if (!supabase) return;
  await supabase.from('clans').delete().eq('id', id);
}

async function loadProfiles() {
  if (!supabase) return [];
  const { data } = await supabase.from('profiles').select('id, data');
  return (data || []).map(r => [r.id, r.data]);
}

async function saveProfile(id, profile) {
  if (!supabase || !id) return;
  await supabase.from('profiles').upsert({ id, data: profile, updated_at: new Date().toISOString() });
}

async function loadClanNames() {
  if (!supabase) return { names: [], emblems: [] };
  const { data } = await supabase.from('clan_meta').select('id, name, emblem');
  const names = [], emblems = [];
  (data || []).forEach(r => {
    if (r.name) names.push([r.id, r.name]);
    if (r.emblem) emblems.push([r.id, r.emblem]);
  });
  return { names, emblems };
}

async function saveClanMeta(id, name, emblem) {
  if (!supabase || !id) return;
  if (!name) {
    await supabase.from('clan_meta').delete().eq('id', id);
  } else {
    await supabase.from('clan_meta').upsert({ id, name, emblem: emblem || null });
  }
}

module.exports = {
  supabase,
  BOSS_MAX_HP,
  BOSS_LVL,
  mondayKey,
  loadClan,
  saveClan,
  loadAllClans,
  deleteClan,
  loadProfiles,
  saveProfile,
  loadClanNames,
  saveClanMeta
};
