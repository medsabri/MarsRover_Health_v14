// =============================================================================
// data.js — registre des datasets, parsing, contrôle qualité, configuration composants.
// =============================================================================
import Papa from 'papaparse';
import { state, idbAll, idbPut, idbDel, log, emit, persist } from './store.js';

export const registry = new Map();     // id → { id, meta, rows, columns, quality, imported }
let CONFIG = null;

export function config() {
  if (!CONFIG) CONFIG = JSON.parse(JSON.stringify(window.MRH_CONFIG || { components: { components: [], dependencies: [] }, fmeca: { modes: [] } }));
  return CONFIG;
}
/** Composants = configuration (components.json) + modifications locales (state.overrides). */
export function components() {
  return config().components.components.map((c) => {
    const o = state.overrides[c.id];
    if (!o) return c;
    const m = JSON.parse(JSON.stringify(c));
    if (o.design_life) m.design_life = { ...m.design_life, ...o.design_life, source: o.design_life.source || 'modifié localement' };
    if (o.thresholds) for (const [v, th] of Object.entries(o.thresholds)) m.thresholds[v] = { ...(m.thresholds[v] || {}), ...th, source: 'modifié localement' };
    return m;
  });
}
export const component = (id) => components().find((c) => c.id === id);
export const dependencies = () => config().components.dependencies;
export function fmecaModes() {
  return config().fmeca.modes.map((m) => ({ ...m, ...(state.fmecaOverrides[m.id] || {}) })).map((m) => ({ ...m, RPN: m.G * m.O * m.D, C: m.G * m.O }));
}
export function setOverride(id, patch) {
  state.overrides[id] = deepMerge(state.overrides[id] || {}, patch);
  persist('overrides'); log('Modification composant', { id, patch }); emit('change', 'overrides');
}
function deepMerge(a, b) { const o = { ...a }; for (const [k, v] of Object.entries(b)) o[k] = v && typeof v === 'object' && !Array.isArray(v) ? deepMerge(a[k] || {}, v) : v; return o; }

export function parseCSV(text) {
  const r = Papa.parse(text.trim(), { header: true, dynamicTyping: true, skipEmptyLines: true, transformHeader: (h) => h.replace(/^﻿/, '').trim() });
  return { rows: r.data, columns: r.meta.fields || [], errors: r.errors.slice(0, 20) };
}
export function parseAny(text, name = '') {
  const t = text.trim();
  if (/\.json$/i.test(name) || t[0] === '[' || t[0] === '{') {
    let j = JSON.parse(t);
    if (!Array.isArray(j)) j = j.data || j.rows || Object.values(j).find(Array.isArray) || [j];
    const columns = [...new Set(j.flatMap((r) => Object.keys(r)))];
    return { rows: j, columns, errors: [] };
  }
  // TXT : séparateur espace/tab/point-virgule détecté automatiquement par PapaParse ; si pas d'en-tête → col1..n
  const first = t.split(/\r?\n/)[0];
  const looksNumericHeader = first.split(/[\s,;\t]+/).filter(Boolean).every((x) => !Number.isNaN(+x));
  if (looksNumericHeader) {
    const r = Papa.parse(t, { header: false, dynamicTyping: true, skipEmptyLines: true, delimiter: /\t/.test(first) ? '\t' : /;/.test(first) ? ';' : /,/.test(first) ? ',' : ' ' });
    const rows = r.data.map((a) => (Array.isArray(a) ? a.filter((x) => x !== '' && x !== null) : a));
    const n = Math.max(...rows.map((a) => a.length));
    const columns = Array.from({ length: n }, (_, i) => `col${i + 1}`);
    return { rows: rows.map((a) => Object.fromEntries(columns.map((c, i) => [c, a[i]]))), columns, errors: [] };
  }
  return parseCSV(t);
}

const UNIT_PATTERNS = [
  [/_A$|courant|current/i, 'A'], [/_V$|tension|voltage/i, 'V'], [/_C$|temp/i, '°C'], [/_h$|heure|hour|time_h/i, 'h'], [/_dB$/i, 'dB'],
  [/_km$|odom/i, 'km'], [/_W$|power|puissance/i, 'W'], [/_Ah$|capac/i, 'Ah'], [/_ohm$/i, 'Ω'], [/rms|vibration/i, 'mm/s (à confirmer)'],
  [/cycle/i, 'cycles'], [/mois/i, 'mois'], [/Mcycles/i, '10^6 cycles'],
];
export function detectUnit(col) { for (const [re, u] of UNIT_PATTERNS) if (re.test(col)) return u; return '—'; }

/** Contrôle qualité : types, valeurs manquantes, bornes, valeurs constantes, doublons. */
export function quality(rows, columns) {
  const n = rows.length;
  const cols = columns.map((c) => {
    const v = rows.map((r) => r[c]);
    const missing = v.filter((x) => x === null || x === undefined || x === '' || (typeof x === 'number' && Number.isNaN(x))).length;
    const nums = v.filter((x) => typeof x === 'number' && Number.isFinite(x));
    const isNum = nums.length >= 0.8 * (n - missing) && nums.length > 0;
    const uniq = new Set(v.filter((x) => x !== null && x !== '')).size;
    let mn = null, mx = null, mu = null;
    if (isNum) { mn = Infinity; mx = -Infinity; let s = 0; for (const x of nums) { if (x < mn) mn = x; if (x > mx) mx = x; s += x; } mu = s / nums.length; }
    const issues = [];
    if (missing / n > 0.2) issues.push(`${Math.round((missing / n) * 100)} % de valeurs manquantes`);
    if (uniq === 1) issues.push('colonne constante');
    if (isNum && nums.length < n - missing) issues.push(`${n - missing - nums.length} valeurs non numériques`);
    return { name: c, type: isNum ? 'numérique' : 'texte', missing, missingRate: n ? missing / n : 0, unique: uniq, min: mn, max: mx, mean: mu, unit: detectUnit(c), issues };
  });
  const keys = new Set(); let dup = 0;
  for (const r of rows) { const k = JSON.stringify(r); if (keys.has(k)) dup++; else keys.add(k); }
  return { n, cols, duplicates: dup, issues: cols.flatMap((c) => c.issues.map((i) => `${c.name} : ${i}`)).concat(dup ? [`${dup} lignes dupliquées`] : []) };
}

export async function loadAll() {
  const emb = window.MRH_EMBEDDED_DATASETS || {};
  for (const [id, { meta, csv }] of Object.entries(emb)) {
    const p = parseCSV(csv);
    registry.set(id, { id, meta, rows: p.rows, columns: p.columns, quality: quality(p.rows, p.columns), imported: false, csv });
  }
  for (const d of await idbAll()) {
    const p = parseAny(d.text, d.meta.file);
    registry.set(d.id, { id: d.id, meta: d.meta, rows: p.rows, columns: p.columns, quality: quality(p.rows, p.columns), imported: true, mapping: d.mapping });
  }
  emit('datasets');
}
export async function addImported({ id, meta, text, mapping }) {
  const p = parseAny(text, meta.file);
  registry.set(id, { id, meta, rows: p.rows, columns: p.columns, quality: quality(p.rows, p.columns), imported: true, mapping });
  const ok = await idbPut({ id, meta, text, mapping });
  log('Import dataset', { id, file: meta.file, rows: p.rows.length, provenance: meta.provenance, persisted: ok });
  emit('datasets');
  return ok;
}
export async function removeImported(id) { registry.delete(id); await idbDel(id); log('Suppression dataset importé', { id }); emit('datasets'); }
export const ds = (id) => registry.get(id);
export const col = (id, c) => (registry.get(id) ? registry.get(id).rows.map((r) => (r[c] === '' || r[c] === undefined ? null : r[c])) : []);

/** Datasets de durées de vie (temps + statut) disponibles pour la fiabilité. */
export function lifetimeDatasets() {
  const out = [];
  for (const d of registry.values()) {
    const m = d.mapping || {};
    if (d.id === 'bearings_exp') out.push({ id: d.id, name: d.meta.name, prov: d.meta.provenance, time: 'T_obs_Mcycles', event: 'event_1_panne_0_censure', unit: '10^6 cycles' });
    else if (d.id === 'rel500_sim') out.push({ id: d.id, name: d.meta.name, prov: d.meta.provenance, time: 'T_obs_h', event: 'event_1_panne_0_censure', unit: 'h' });
    else if (d.id === 'fire_demo') out.push({ id: d.id, name: d.meta.name, prov: d.meta.provenance, time: 'T_obs_mois', event: 'event_1_panne_0_censure', unit: 'mois' });
    else if (d.id === 'vib_bearings_sim') out.push({ id: d.id, name: d.meta.name + ' (durées jusqu\'à panne)', prov: d.meta.provenance, derivedFromTraj: { idCol: 'ID_Roulement', tCol: 'Cycle_Heure', status: 'Statut_Final_1_Panne_0_Censure' }, unit: 'h' });
    else if (d.id === 'battery_sim') out.push({ id: d.id, name: d.meta.name + ' (cycles jusqu\'à 80 % C0)', prov: d.meta.provenance, derivedFromTraj: { idCol: 'pack_id', tCol: 'cycle', yCol: 'capacity_Ah', thr: 32, dir: 'down' }, unit: 'cycles' });
    else if (d.imported && m.role === 'lifetime' && m.time && m.event) out.push({ id: d.id, name: d.meta.name, prov: d.meta.provenance, time: m.time, event: m.event, unit: m.unit || '—' });
    else if (d.imported && m.role === 'trajectory' && m.id && m.time && m.value) out.push({ id: d.id, name: d.meta.name + ' (durées)', prov: d.meta.provenance, derivedFromTraj: { idCol: m.id, tCol: m.time, yCol: m.value, thr: m.threshold, dir: m.direction || 'up' }, unit: m.unit || '—' });
  }
  return out;
}
/** Extrait (temps, événements) d'un dataset de durées ou de trajectoires. */
export function lifetimes(id) {
  const L = lifetimeDatasets().find((x) => x.id === id); const d = ds(id);
  if (!L || !d) return null;
  if (!L.derivedFromTraj) return { ...L, times: d.rows.map((r) => +r[L.time]), events: d.rows.map((r) => (+r[L.event] ? 1 : 0)) };
  const g = new Map(), f = L.derivedFromTraj;
  for (const r of d.rows) { const k = r[f.idCol]; if (!g.has(k)) g.set(k, []); g.get(k).push(r); }
  const times = [], events = [], ids = [];
  for (const [k, rs] of g) {
    rs.sort((a, b) => a[f.tCol] - b[f.tCol]);
    const last = rs[rs.length - 1];
    let ev;
    if (f.status) ev = +last[f.status] ? 1 : 0;
    else if (f.thr !== undefined) ev = f.dir === 'down' ? +last[f.yCol] <= f.thr + 0.3 : +last[f.yCol] >= f.thr;
    else ev = 1;
    // un pack « en service » non arrivé au seuil est censuré
    times.push(+last[f.tCol]); events.push(ev ? 1 : 0); ids.push(k);
  }
  return { ...L, times, events, ids };
}
export function activeLifetimeOK() { return !!lifetimes(state.activeDataset); }
