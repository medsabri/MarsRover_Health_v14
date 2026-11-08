// =============================================================================
// charts.js — graphiques (Chart.js 4) thémés + rendus SVG/HTML spécifiques
// (boîtes à moustaches, heatmap de criticité, Gantt). Plugins : bandes d'alerte, seuils.
// =============================================================================
import Chart from 'chart.js/auto';
import { h, cssVar, fmt } from './dom.js';

// Palette catégorielle validée (dataviz : séparation CVD ΔE ≥ 11, contraste ≥ 3:1) — ordre fixe, jamais recyclée par rang
const PALETTE = ['#2563EB', '#E8590C', '#0D9488', '#9333EA', '#DB2777', '#65A30D', '#0284C7', '#B45309'];
export const color = (i) => PALETTE[i % PALETTE.length];

// Bandes verticales (zones d'alerte / fenêtres) et lignes horizontales (seuils documentés)
const bandsPlugin = {
  id: 'bands',
  beforeDatasetsDraw(chart, args, opts) {
    const { ctx, chartArea: a, scales } = chart; if (!opts || !scales.x) return;
    ctx.save();
    for (const b of opts.bands || []) {
      const x0 = scales.x.getPixelForValue(b.x0), x1 = scales.x.getPixelForValue(b.x1);
      ctx.fillStyle = b.color || 'rgba(220,38,38,.14)'; ctx.fillRect(Math.max(a.left, x0), a.top, Math.min(a.right, x1) - Math.max(a.left, x0), a.bottom - a.top);
      if (b.label) { ctx.fillStyle = b.textColor || '#DC2626'; ctx.font = '10px sans-serif'; ctx.fillText(b.label, Math.max(a.left, x0) + 3, a.top + 11); }
    }
    for (const l of opts.hlines || []) {
      const y = scales.y.getPixelForValue(l.y); if (y < a.top || y > a.bottom) continue;
      ctx.strokeStyle = l.color || '#DC2626'; ctx.setLineDash(l.dash || [6, 4]); ctx.lineWidth = 1.2;
      ctx.beginPath(); ctx.moveTo(a.left, y); ctx.lineTo(a.right, y); ctx.stroke();
      if (l.label) { ctx.setLineDash([]); ctx.fillStyle = l.color || '#DC2626'; ctx.font = '10px sans-serif'; ctx.fillText(l.label, a.right - ctx.measureText(l.label).width - 4, y - 3); }
    }
    for (const l of opts.vlines || []) {
      const x = scales.x.getPixelForValue(l.x); if (x < a.left || x > a.right) continue;
      ctx.strokeStyle = l.color || '#2563EB'; ctx.setLineDash(l.dash || [4, 3]); ctx.lineWidth = 1.2;
      ctx.beginPath(); ctx.moveTo(x, a.top); ctx.lineTo(x, a.bottom); ctx.stroke();
      if (l.label) { ctx.setLineDash([]); ctx.fillStyle = l.color || '#2563EB'; ctx.font = '10px sans-serif'; const w = ctx.measureText(l.label).width; ctx.fillText(l.label, x + 3 + w > a.right ? x - w - 4 : x + 3, a.top + 12); }
    }
    ctx.restore();
  },
};
Chart.register(bandsPlugin);

export function themeCharts() {
  Chart.defaults.color = cssVar('--text-2') || '#64748B';
  Chart.defaults.borderColor = 'rgba(148, 163, 184, .22)';
  Chart.defaults.font.family = 'Inter, Segoe UI, system-ui, sans-serif';
  Chart.defaults.font.size = 11;
  Chart.defaults.animation.duration = 450; Chart.defaults.animation.easing = 'easeOutQuart';
  Chart.defaults.maintainAspectRatio = false;
  const L = Chart.defaults.plugins.legend.labels;
  L.usePointStyle = true; L.pointStyle = 'circle'; L.boxWidth = 8; L.boxHeight = 8; L.padding = 14;
  const T = Chart.defaults.plugins.tooltip;
  Object.assign(T, { backgroundColor: 'rgba(11, 11, 12, .92)', titleColor: '#E7E625', bodyColor: '#F4F4F5', padding: 10, cornerRadius: 10, boxPadding: 5, usePointStyle: true, titleFont: { weight: '600' } });
  Chart.defaults.scale.grid.color = 'rgba(148, 163, 184, .18)';
  Chart.defaults.scale.border.display = false;
  Chart.defaults.scale.ticks.padding = 6;
  Chart.defaults.elements.line.borderCapStyle = 'round';
  Chart.defaults.elements.point.hoverRadius = 5;
}
/** Dégradé vertical (aire sous la courbe / barres) — couleur pleine en haut, transparente en bas. */
export function gradient(col, top = .32, bottom = 0) {
  return (ctx) => {
    const { chart } = ctx; const a = chart.chartArea; if (!a) return col + '33';
    const g = chart.ctx.createLinearGradient(0, a.top, 0, a.bottom);
    const hex = (x) => Math.round(x * 255).toString(16).padStart(2, '0');
    g.addColorStop(0, col + hex(top)); g.addColorStop(1, col + hex(bottom)); return g;
  };
}
const solid = (c) => (typeof c === 'string' && /^#[0-9a-f]{6}$/i.test(c) ? c : null);

/** Registre par vue : tous les graphiques sont détruits au démontage (pas de fuite mémoire). */
export class ChartBag {
  constructor() { this.list = []; }
  add(c) { this.list.push(c); return c; }
  destroy() { this.list.forEach((c) => c.destroy()); this.list = []; }
}

export function chartBox(cls = '') { const c = h('canvas'); return { box: h(`div.chart-box${cls ? '.' + cls : ''}`, c), canvas: c }; }

/** Courbe(s) temporelle(s) : series = [{label, data:[{x,y}], color, dashed, fill, step, hidden, pointRadius}]. */
export function lineChart(canvas, series, { xLabel = '', yLabel = '', bands = [], hlines = [], vlines = [], xMin, xMax, yMin, yMax, logY = false, legend = true, tooltipUnit = '' } = {}) {
  const auto = series.filter((s) => s.showLine !== false && !s.dashed).length <= 2;
  return new Chart(canvas, {
    type: 'line',
    data: { datasets: series.map((s, i) => {
      const col = s.color || color(i), base = solid(col);
      const area = s.fill === undefined && auto && base && s.showLine !== false && !s.dashed && !s.step;
      return {
        label: s.label, data: s.data, borderColor: col,
        backgroundColor: s.fillColor || (area ? gradient(base) : (base ? base + '33' : col)),
        borderWidth: s.width ? Math.max(s.width, 2) : 2.2, pointRadius: s.pointRadius ?? 0, pointHoverRadius: 5,
        pointBackgroundColor: s.showLine === false ? (base ? base + 'CC' : col) : '#FFFFFF', pointBorderColor: col, pointBorderWidth: s.showLine === false ? 1 : 2,
        borderDash: s.dashed ? [6, 5] : [], fill: s.fill ?? (area ? 'start' : false), cubicInterpolationMode: s.step ? 'default' : 'monotone',
        stepped: s.step ? 'after' : false, hidden: s.hidden, spanGaps: s.spanGaps ?? false, showLine: s.showLine ?? true, pointStyle: s.pointStyle || 'circle', order: s.order };
    }) },
    options: {
      parsing: true, normalized: true, interaction: { mode: 'nearest', intersect: false },
      scales: { x: { type: 'linear', title: { display: !!xLabel, text: xLabel }, min: xMin, max: xMax, grid: { display: false } },
        y: { type: logY ? 'logarithmic' : 'linear', title: { display: !!yLabel, text: yLabel }, min: yMin, max: yMax, grid: { color: 'rgba(148,163,184,.2)' } } },
      plugins: { legend: { display: legend }, bands: { bands, hlines, vlines }, decimation: { enabled: true, algorithm: 'min-max' },
        tooltip: { callbacks: { label: (c) => ` ${c.dataset.label} : ${fmt(c.parsed.y, 3)}${tooltipUnit ? ' ' + tooltipUnit : ''} @ ${fmt(c.parsed.x, 1)}` } } },
    },
  });
}
export function barChart(canvas, labels, series, { yLabel = '', horizontal = false, stacked = false, legend = true, yMax } = {}) {
  const fillOf = (c) => (Array.isArray(c) ? c.map((x) => x) : solid(c) ? (ctx) => { const a = ctx.chart.chartArea; if (!a) return c; const g = horizontal ? ctx.chart.ctx.createLinearGradient(a.left, 0, a.right, 0) : ctx.chart.ctx.createLinearGradient(0, a.bottom, 0, a.top); g.addColorStop(0, c + 'B3'); g.addColorStop(1, c); return g; } : c);
  return new Chart(canvas, {
    type: 'bar',
    data: { labels, datasets: series.map((s, i) => ({ label: s.label, data: s.data, backgroundColor: fillOf(s.colors || s.color || color(i)), hoverBackgroundColor: s.colors || s.color || color(i),
      borderRadius: 8, borderSkipped: stacked ? false : 'start', maxBarThickness: 34, categoryPercentage: .72, barPercentage: .86, base: s.base })) },
    options: { indexAxis: horizontal ? 'y' : 'x',
      scales: { x: { stacked, grid: { display: horizontal } }, y: { stacked, title: { display: !!yLabel, text: yLabel }, max: yMax, grid: { display: !horizontal } } },
      plugins: { legend: { display: legend } } },
  });
}
export function radarChart(canvas, labels, series) {
  return new Chart(canvas, {
    type: 'radar',
    data: { labels, datasets: series.map((s, i) => { const c = s.color || color(i); return { label: s.label, data: s.data, borderColor: c, backgroundColor: c + '2E', borderWidth: 2.2, pointRadius: 3.5, pointBackgroundColor: '#fff', pointBorderColor: c, pointBorderWidth: 2 }; }) },
    options: { scales: { r: { min: 0, max: 1, ticks: { stepSize: 0.25, backdropColor: 'transparent', color: '#94A3B8' }, grid: { color: 'rgba(148,163,184,.25)' }, angleLines: { color: 'rgba(148,163,184,.25)' }, pointLabels: { font: { size: 11, weight: '500' } } } } },
  });
}
// Texte central des anneaux (jauge, donut)
const centerText = {
  id: 'centerText',
  afterDatasetsDraw(chart, args, o) {
    if (!o || !o.text) return;
    const { ctx } = chart, m = chart.getDatasetMeta(0).data[0]; if (!m) return;
    ctx.save(); ctx.textAlign = 'center'; ctx.fillStyle = cssVar('--text') || '#111827';
    const y = o.gauge ? m.y - 6 : m.y;
    ctx.font = `700 ${o.size || 22}px Inter, sans-serif`; ctx.textBaseline = o.gauge ? 'alphabetic' : 'middle'; ctx.fillText(o.text, m.x, y);
    if (o.sub) { ctx.font = '500 11px Inter, sans-serif'; ctx.fillStyle = cssVar('--text-2') || '#64748B'; ctx.fillText(o.sub, m.x, y + (o.gauge ? 16 : 18)); }
    ctx.restore();
  },
};
Chart.register(centerText);
/** Anneau (donut) : parts nommées — couleurs fournies (états = palette de statut réservée). */
export function doughnutChart(canvas, labels, data, colors, { text = '', sub = '', cutout = '72%', legend = true } = {}) {
  return new Chart(canvas, {
    type: 'doughnut',
    data: { labels, datasets: [{ data, backgroundColor: colors, borderColor: cssVar('--surface') || '#fff', borderWidth: 2, borderRadius: 6, spacing: 2, hoverOffset: 6 }] },
    options: { cutout, plugins: { legend: { display: legend, position: 'right' }, centerText: { text, sub } } },
  });
}
/** Jauge demi-cercle (valeur 0–1) avec zones : rouge < 0,6 ≤ ambre < 0,8 ≤ vert. */
export function gaugeChart(canvas, value, { text = '', sub = '' } = {}) {
  const v = Math.max(0, Math.min(1, value ?? 0));
  const col = v >= 0.8 ? '#16A34A' : v >= 0.6 ? '#F59E0B' : '#DC2626';
  return new Chart(canvas, {
    type: 'doughnut',
    data: { labels: ['valeur', 'reste'], datasets: [{ data: [v, 1 - v], backgroundColor: (ctx) => (ctx.dataIndex === 0 ? gradientArc(col)(ctx) : 'rgba(148,163,184,.22)'), borderWidth: 0, borderRadius: 8 }] },
    options: { rotation: -90, circumference: 180, cutout: '76%', events: [], plugins: { legend: { display: false }, tooltip: { enabled: false }, centerText: { text, sub, gauge: true, size: 26 } } },
  });
}
function gradientArc(col) {
  return (ctx) => { const a = ctx.chart.chartArea; if (!a) return col; const g = ctx.chart.ctx.createLinearGradient(a.left, 0, a.right, 0); g.addColorStop(0, col + '99'); g.addColorStop(1, col); return g; };
}

/** Boîtes à moustaches en SVG. groups = [{label, stats:{wLo,q1,med,q3,wHi,outliers}}]. */
export function boxplotSVG(groups, { unit = '', width = 520, height = 220, big = false } = {}) {
  const pad = big ? { l: 58, r: 14, t: 18, b: 52 } : { l: 46, r: 10, t: 10, b: 34 };
  const all = groups.flatMap((g) => [g.stats.wLo, g.stats.wHi, ...g.stats.outliers]);
  const lo = Math.min(...all), hi = Math.max(...all), span = hi - lo || 1;
  const Y = (v) => pad.t + (1 - (v - lo) / span) * (height - pad.t - pad.b);
  const bw = (width - pad.l - pad.r) / groups.length;
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg'); svg.setAttribute('viewBox', `0 0 ${width} ${height}`); svg.setAttribute('class', big ? 'box big' : 'box'); svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', 'Boîtes à moustaches'); svg.style.width = '100%'; svg.style.height = height + 'px';
  const el = (n, a) => { const e = document.createElementNS(ns, n); for (const [k, v] of Object.entries(a)) e.setAttribute(k, v); svg.append(e); return e; };
  const stroke = cssVar('--text-2'), line = cssVar('--line');
  for (let k = 0; k <= 4; k++) { const v = lo + (span * k) / 4; el('line', { x1: pad.l, x2: width - pad.r, y1: Y(v), y2: Y(v), stroke: line, 'stroke-width': 0.6 }); const t = el('text', { x: pad.l - 6, y: Y(v) + 4, 'text-anchor': 'end', ...(big ? { 'font-size': 13 } : {}) }); t.textContent = fmt(v, 2); }
  groups.forEach((g, i) => {
    const cx = pad.l + bw * (i + 0.5), w = big ? Math.min(110, bw * 0.42) : Math.min(46, bw * 0.5), s = g.stats, c = g.color || color(i);
    el('line', { x1: cx, x2: cx, y1: Y(s.wLo), y2: Y(s.wHi), stroke, 'stroke-width': 1 });
    el('rect', { x: cx - w / 2, y: Y(s.q3), width: w, height: Math.max(1, Y(s.q1) - Y(s.q3)), fill: c + '55', stroke: c });
    el('line', { x1: cx - w / 2, x2: cx + w / 2, y1: Y(s.med), y2: Y(s.med), stroke: c, 'stroke-width': 2 });
    for (const o of s.outliers.slice(0, 60)) el('circle', { cx, cy: Y(o), r: big ? 3.5 : 1.8, fill: c });
    const t = el('text', { x: cx, y: height - (big ? 28 : 18), 'text-anchor': 'middle', ...(big ? { 'font-size': 15 } : {}) }); t.textContent = g.label;
    const t2 = el('text', { x: cx, y: height - (big ? 8 : 6), 'text-anchor': 'middle', ...(big ? { 'font-size': 13 } : {}) }); t2.textContent = `n=${s.n}`;
  });
  if (unit) { const t = el('text', { x: 4, y: 10 }); t.textContent = unit; }
  return svg;
}

/** Matrice de criticité gravité × occurrence (cases colorées par G·O, nombre de modes affiché). */
export function criticalityHeatmap(modes, onCell) {
  const grid = h('div.heat', { role: 'grid', 'aria-label': 'Matrice de criticité gravité × occurrence' });
  for (let g = 10; g >= 1; g--) {
    grid.append(h('div.ax', String(g)));
    for (let o = 1; o <= 10; o++) {
      const here = modes.filter((m) => m.G === g && m.O === o);
      const c = g * o; const col = c >= 40 ? '#DC2626' : c >= 20 ? '#D97706' : c >= 10 ? '#0284C7' : '#16A34A';
      grid.append(h('div', { style: { background: col + (here.length ? 'ff' : '33'), cursor: here.length ? 'pointer' : 'default' }, title: here.length ? here.map((m) => `${m.id} ${m.mode} (RPN ${m.RPN})`).join('\n') : `G=${g}, O=${o}`, on: { click: () => here.length && onCell && onCell(here) } }, here.length ? String(here.length) : ''));
    }
  }
  grid.append(h('div.ax', ''));
  for (let o = 1; o <= 10; o++) grid.append(h('div.ax', String(o)));
  return h('div', h('div.small.muted', 'Gravité (G, vertical) × Occurrence (O, horizontal) — couleur = criticité G·O'), grid);
}

/** Gantt : rows = [{label, items:[{start, end, label, color}]}], axe en unités d'usage ou sols. */
export function gantt(rows, { min, max, now = null, unit = '' }) {
  const span = max - min || 1, pos = (v) => `${((v - min) / span) * 100}%`;
  const wrap = h('div.gantt', { role: 'table', 'aria-label': 'Planning de maintenance' });
  const axis = h('div.grow', h('div.small.muted', unit), h('div.track', [0, 0.25, 0.5, 0.75, 1].map((f) => h('span.small.muted', { style: { position: 'absolute', left: `${f * 100}%`, transform: 'translateX(-50%)' } }, fmt(min + f * span, 1)))));
  wrap.append(axis);
  for (const r of rows) {
    const tr = h('div.track');
    if (now !== null) tr.append(h('div.now', { style: { left: pos(now) }, title: 'Aujourd\'hui (usage actuel)' }));
    for (const it of r.items) tr.append(h('div.bar', { style: { left: pos(Math.max(min, it.start)), width: `max(3px, calc(${pos(Math.min(max, it.end))} - ${pos(Math.max(min, it.start))}))`, background: it.color || '#2563EB' }, title: it.title || it.label }, it.label));
    wrap.append(h('div.grow', h('div.small', r.label), tr));
  }
  return wrap;
}
export { Chart };
