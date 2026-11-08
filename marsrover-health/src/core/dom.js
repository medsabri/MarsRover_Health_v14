// =============================================================================
// dom.js — micro-utilitaires DOM, formatage, badges de provenance, téléchargements.
// =============================================================================
// Icônes (tracés 24×24, trait 1,75 — style cohérent, sans dépendance)
const ICONS = {
  download: '<path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M5 21h14"/>',
  upload: '<path d="M12 21V9"/><path d="m7 14 5-5 5 5"/><path d="M5 3h14"/>',
  play: '<path d="M7 4.5v15l12-7.5z"/>', pause: '<path d="M8 5v14M16 5v14"/>',
  save: '<path d="M5 3h11l3 3v15H5z"/><path d="M8 3v5h7V3"/><path d="M8 21v-7h8v7"/>',
  print: '<path d="M7 9V3h10v6"/><rect x="3" y="9" width="18" height="8" rx="2"/><path d="M7 14h10v7H7z"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="m13.5 6.5 4 4"/>', x: '<path d="M6 6l12 12M18 6 6 18"/>',
  external: '<path d="M14 4h6v6"/><path d="M20 4 10 14"/><path d="M19 14v6H4V5h6"/>', search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  chevronRight: '<path d="m9 6 6 6-6 6"/>', chevronLeft: '<path d="m15 6-6 6 6 6"/>', chevronDown: '<path d="m6 9 6 6 6-6"/>',
  menu: '<path d="M4 7h16M4 12h16M4 17h16"/>', sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>', moon: '<path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z"/>',
  filter: '<path d="M4 5h16l-6 8v6l-4-2v-4z"/>', info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5v.5"/>', check: '<path d="m5 12 5 5 9-10"/>',
  alert: '<path d="M12 3 2 20h20z"/><path d="M12 10v4M12 17v.5"/>', refresh: '<path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 4v7h-7"/>', trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
  cube: '<path d="m12 2 9 5v10l-9 5-9-5V7z"/><path d="m3 7 9 5 9-5M12 12v10"/>', gauge: '<path d="M4 18a8 8 0 1 1 16 0"/><path d="m12 14 4-5"/>', wrench: '<path d="M14.7 6.3a4 4 0 0 0 5 5L12 19l-3 1 1-3 7.7-7.7"/><path d="M14.7 6.3 9 12"/>',
  grid: '<rect x="4" y="4" width="7" height="7" rx="1"/><rect x="13" y="4" width="7" height="7" rx="1"/><rect x="4" y="13" width="7" height="7" rx="1"/><rect x="13" y="13" width="7" height="7" rx="1"/>',
  zap: '<path d="M13 2 4 14h7l-1 8 9-12h-7z"/>', mountain: '<path d="m3 20 6-10 4 6 3-4 5 8z"/>', database: '<ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5"/><path d="M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3"/>',
  cpu: '<rect x="6" y="6" width="12" height="12" rx="2"/><rect x="9.5" y="9.5" width="5" height="5" rx=".5"/><path d="M9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M2 15h4M18 9h4M18 15h4"/>',
  code: '<path d="m8 8-5 4 5 4M16 8l5 4-5 4M14 4l-4 16"/>', chat: '<path d="M4 5h16v11H9l-5 4z"/>', copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V4H4v12h4"/>',
};
/** Icône SVG en ligne (aria-hidden) ; nom inconnu → élément vide. */
export function icon(name, cls = '') {
  const s = document.createElement('span'); s.className = 'ic' + (cls ? ' ' + cls : ''); s.setAttribute('aria-hidden', 'true');
  s.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">${ICONS[name] || ''}</svg>`;
  return s;
}
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/** Création d'élément : h('div.cls#id', {attrs, on:{click}}, ...children). */
export function h(tag, attrs = {}, ...children) {
  const m = tag.match(/^([a-z0-9-]+)?((?:[.#][\w-]+)*)$/i);
  const el = document.createElement(m[1] || 'div');
  (m[2].match(/[.#][\w-]+/g) || []).forEach((p) => (p[0] === '.' ? el.classList.add(p.slice(1)) : (el.id = p.slice(1))));
  if (attrs && (typeof attrs !== 'object' || attrs instanceof Node || Array.isArray(attrs))) { children.unshift(attrs); attrs = {}; }
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'on') for (const [ev, fn] of Object.entries(v)) el.addEventListener(ev, fn);
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k === 'html') el.innerHTML = v;
    else if (k in el && typeof v !== 'string') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  const add = (c) => { if (c === null || c === undefined || c === false) return; if (Array.isArray(c)) c.forEach(add); else el.append(c instanceof Node ? c : document.createTextNode(String(c))); };
  children.forEach(add);
  return el;
}
/** append() natif sans les valeurs nulles (évite l'affichage de « null »). */
export function append(el, ...xs) { const f = (a) => a.flat(Infinity).filter((x) => x !== null && x !== undefined && x !== false); el.append(...f(xs)); return el; }
export function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); return el; }
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ------------------------------------------------------------------ formatage
export function fmt(x, d = 2, unit = '') {
  if (x === null || x === undefined || Number.isNaN(x)) return '—';
  if (x === Infinity) return '∞';
  const a = Math.abs(x);
  let s;
  if (a !== 0 && (a < 1e-3 || a >= 1e6)) s = x.toExponential(2);
  else s = x.toLocaleString('fr-FR', { maximumFractionDigits: d, minimumFractionDigits: 0 });
  return unit ? `${s} ${unit}` : s;
}
export const pct = (x, d = 1) => (x === null || x === undefined || Number.isNaN(x) ? '—' : `${(x * 100).toLocaleString('fr-FR', { maximumFractionDigits: d })} %`);

// ------------------------------------------------------------------ provenance
export const PROV = {
  mission: { label: 'Réel mission', cls: 'mission' },
  experimental: { label: 'Expérimental', cls: 'experimental' },
  simulated: { label: 'Simulé', cls: 'simulated' },
  substituted: { label: 'Estimé par substitution', cls: 'substituted' },
};
export function badge(prov, title) {
  const p = PROV[prov];
  if (!p) return h('span.badge.none', { title: title || 'Aucune donnée' }, 'Aucune donnée');
  return h(`span.badge.${p.cls}`, { title: title || `Provenance : ${p.label}`, 'aria-label': `Provenance ${p.label}` }, p.label);
}
// mentions « démonstration » retirées de l'affichage (interface épurée)
export const demoBadge = () => null;

// ------------------------------------------------------------------ états composants
export const STATUS = {
  ok: { label: 'OK', color: '#16A34A', cls: 'st-ok' },
  warn: { label: 'Attention', color: '#D97706', cls: 'st-warn' },
  fault: { label: 'Défaut', color: '#DC2626', cls: 'st-fault' },
  overtemp: { label: 'Température haute', color: '#EA580C', cls: 'st-overtemp' },
  overload: { label: 'Surcharge', color: '#7C3AED', cls: 'st-overload' },
  sensor: { label: 'Capteur suspect', color: '#0284C7', cls: 'st-sensor' },
  nodata: { label: 'Données insuffisantes', color: '#94A3B8', cls: 'st-nodata' },
};
export const SEVERITY = { ok: 0, nodata: 0.5, sensor: 2, warn: 2, overtemp: 3, overload: 3, fault: 4 };
export function statusEl(st) { const s = STATUS[st] || STATUS.nodata; return h(`span.st.${s.cls}`, h('span.dot', { style: { background: s.color } }), s.label); }

// ------------------------------------------------------------------ notifications / dialogues
export function toast(msg, kind = '') {
  const t = h(`div.toast${kind ? '.' + kind : ''}`, { role: kind === 'err' ? 'alert' : 'status' }, icon(kind === 'err' ? 'alert' : kind === 'ok' ? 'check' : 'info'), h('div', msg));
  document.getElementById('toast').append(t);
  setTimeout(() => t.remove(), 4200);
}
export function modal(title, content, { onClose } = {}) {
  const d = h('dialog', { 'aria-label': title },
    h('div.dlg-h', h('strong', title), h('button.btn.ghost.sm.icon', { on: { click: () => d.close() }, 'aria-label': 'Fermer' }, icon('x'))),
    h('div.dlg-b', content));
  d.addEventListener('close', () => { d.remove(); onClose && onClose(); });
  document.body.append(d); d.showModal();
  return d;
}

// ------------------------------------------------------------------ fichiers
export function download(name, data, mime = 'text/plain;charset=utf-8') {
  const blob = data instanceof Blob ? data : new Blob([data], { type: mime });
  const a = h('a', { href: URL.createObjectURL(blob), download: name });
  document.body.append(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
}
export function toCSV(rows, cols) {
  const c = cols || Object.keys(rows[0] || {});
  const q = (v) => { if (v === null || v === undefined) return ''; const s = typeof v === 'number' ? String(+v.toPrecision(10)) : String(v); return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  return [c.join(','), ...rows.map((r) => c.map((k) => q(r[k])).join(','))].join('\n') + '\n';
}
export function pickFile(accept, multiple = false) {
  return new Promise((res) => {
    const inp = h('input', { type: 'file', accept, multiple });
    inp.addEventListener('change', () => res([...inp.files]));
    inp.click();
  });
}
export function readText(file) { return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsText(file); }); }
export function readBuffer(file) { return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsArrayBuffer(file); }); }

/** Notes explicatives de bas de panneau : retirées de l'affichage (interface épurée). Les messages d'état vide sont conservés. */
const isNote = (n) => n instanceof HTMLElement && ((n.tagName === 'DIV' && n.className === 'small muted' && !/^(Aucun|Aucune)/.test(n.textContent.trim())) || n.classList.contains('warnbox'));
export function panel(title, opts = {}, ...body) {
  body = body.flat(Infinity).filter((n) => !isNote(n));
  const head = h('header', h(opts.level || 'h2', title), h('div.row', opts.badges || []));
  return h(`section.panel${opts.cls ? '.' + opts.cls : ''}`, { 'aria-label': title, id: opts.id }, head, ...body);
}
export function kpi(k, v, unit = '', extra = null) {
  return h('div.kpi', h('div.k', k), typeof v === 'string' && /non calculable|masqu/.test(v) ? h('div.nc', v) : h('div.v', v, unit ? h('span.u', ' ' + unit) : null), extra);
}
export function cssVar(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }

/**
 * Tableaux longs : recherche plein texte + pagination, ajoutées automatiquement
 * (idempotent) aux tableaux de plus de `pageSize` lignes. Ne modifie pas les données.
 */
export function enhanceTables(root, pageSize = 30) {
  root.querySelectorAll('.tbl-wrap').forEach((wrap) => {
    if (wrap.dataset.enh) return;
    const tb = wrap.querySelector('tbody'); if (!tb) return;
    const rows = [...tb.rows]; if (rows.length <= pageSize) return;
    wrap.dataset.enh = '1'; wrap.style.maxHeight = 'none';
    let page = 0, q = '';
    const inp = h('input.inp', { type: 'search', placeholder: 'Rechercher dans le tableau…', 'aria-label': 'Rechercher dans le tableau' });
    const info = h('span'), prev = h('button.btn.sm.icon', { 'aria-label': 'Page précédente' }, icon('chevronLeft')), next = h('button.btn.sm.icon', { 'aria-label': 'Page suivante' }, icon('chevronRight'));
    const tools = h('div.tbl-tools', h('div.search', icon('search'), inp), h('span.small.muted', `${rows.length} lignes`));
    const pager = h('div.pager', info, prev, next);
    wrap.before(tools); wrap.after(pager);
    const draw = () => {
      const match = rows.filter((r) => !q || r.textContent.toLowerCase().includes(q));
      const pages = Math.max(1, Math.ceil(match.length / pageSize)); page = Math.min(page, pages - 1);
      rows.forEach((r) => (r.style.display = 'none'));
      match.slice(page * pageSize, (page + 1) * pageSize).forEach((r) => (r.style.display = ''));
      info.textContent = match.length ? `${page * pageSize + 1}–${Math.min(match.length, (page + 1) * pageSize)} sur ${match.length}` : 'Aucun résultat';
      prev.disabled = page === 0; next.disabled = page >= pages - 1;
    };
    inp.addEventListener('input', () => { q = inp.value.trim().toLowerCase(); page = 0; draw(); });
    prev.addEventListener('click', () => { page--; draw(); }); next.addEventListener('click', () => { page++; draw(); });
    draw();
  });
}
