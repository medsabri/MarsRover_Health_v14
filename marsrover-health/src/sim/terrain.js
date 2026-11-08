// =============================================================================
// terrain.js — terrain paramétrable et simulation quasi statique de la mobilité rocker-bogie.
// Simulation d'aide à l'analyse, NON VALIDÉE sur rover réel. Équations (affichées dans l'UI) :
//  Poids                W = m·g_Mars  (m = 1025 kg, g = 3,71 m/s² — valeurs indicatives)
//  Charge normale       N_i = W/6 · cos θ − ΔN_tangage ± ΔN_roulis
//                       ΔN_tangage = W·h_cg·sin θ / L (transfert avant→arrière en montée), ΔN_roulis = W·h_cg·sin φ / B
//  Rocker-bogie         angle bogie = atan((h_milieu − h_arrière)/l_bogie) ; angle rocker = atan((h_avant − h_pivot)/l_rocker)
//  Glissement           s = s0 + k·tan θ_local + Δs_sable   (borné à 0,95)
//  Effort de traction   F_i = N_i·Crr + (W/6)·sin θ_local + F_virage   ; Crr = 0,08 (sol ferme) / 0,20 (sable)
//  Couple / courant     τ_i = F_i·r / (1 − s/2) ;  I_i = τ_i / K + I0   (K = 60 N·m/A, I0 = 0,33 A — démonstration)
//  Puissance            P = Σ V_bus·I_i  (V_bus = 28 V)
//  Thermique moteur     dT/dt = (T_amb + 30·I² − T) / τ_th   (τ_th = 600 s, cohérent avec la télémétrie simulée)
//  Dommage équivalent   usage_eq = Σ Δs·[(N/N0)³ − 1]⁺  (roues, suspension)  ;  Σ Δt·[(I/I_nom)³ − 1]⁺ (moteurs)
// =============================================================================
import { mulberry32 } from '../ml/stats.js';

export const CONST = { m: 1025, g: 3.71, hcg: 1.0, L: 2.2, B: 2.0, r: 0.2625, K: 60, I0: 0.33, Vbus: 28, crr: 0.08, crrSand: 0.2, s0: 0.02, kSlip: 0.8, dsSand: 0.15, tauTh: 600, Tamb: -40, lBogie: 1.1, lRocker: 1.65 };
export const WHEELS = [
  { key: 'L_front', id: 1, x: 1.0, z: 1.0 }, { key: 'L_mid', id: 2, x: 1.0, z: -0.1 }, { key: 'L_rear', id: 3, x: 1.0, z: -1.2 },
  { key: 'R_front', id: 4, x: -1.0, z: 1.0 }, { key: 'R_mid', id: 5, x: -1.0, z: -0.1 }, { key: 'R_rear', id: 6, x: -1.0, z: -1.2 },
];
export const DEFAULTS = { slopeDeg: 15, hillStart: 14, hillLength: 12, craterDepth: 0.35, craterRadius: 2.2, craterAt: 8, turnRadius: 6, turnStart: 34, rocks: 0.5, sand: true, sandStart: 44, sandLength: 10, speed: 0.042, length: 62, seed: 3 };

/** Construit le terrain : hauteur h(x, z) et type de sol, à partir des paramètres et de la trajectoire. */
export function buildTerrain(p) {
  const path = buildPath(p);
  const rand = mulberry32(p.seed || 3), rocks = [];
  const nR = Math.round(p.rocks * 70);
  for (let k = 0; k < nR; k++) {
    const s = rand() * p.length, P = pathAt(path, s), off = (rand() - 0.5) * 3.2;
    rocks.push({ x: P.x + Math.cos(P.hd) * off, z: P.z - Math.sin(P.hd) * off, r: 0.08 + rand() * 0.16 });
  }
  const crater = p.craterDepth > 0 ? (() => { const P = pathAt(path, p.craterAt); return { x: P.x + 0.4, z: P.z, R: p.craterRadius, d: p.craterDepth }; })() : null;
  const tan = Math.tan((p.slopeDeg * Math.PI) / 180);
  const hill = (x, z) => {
    // colline : montée le long de la trajectoire (abscisse curviligne approchée par la projection sur z avant le virage)
    const sp = Math.min(z, p.turnStart);
    const u = sp - p.hillStart;
    if (u <= 0) return 0;
    if (u < p.hillLength) return tan * u * (u < 1 ? u / 2 + 0.5 : 1) ;
    return tan * p.hillLength;
  };
  const height = (x, z) => {
    let hgt = hill(x, z);
    if (crater) { const d2 = ((x - crater.x) ** 2 + (z - crater.z) ** 2) / (crater.R * crater.R); hgt += -crater.d * Math.exp(-d2 * 2.2) + 0.25 * crater.d * Math.exp(-((Math.sqrt(d2) - 1) ** 2) * 10); }
    for (const r of rocks) { const d2 = (x - r.x) ** 2 + (z - r.z) ** 2; if (d2 < 9 * r.r * r.r) hgt += r.r * Math.exp(-d2 / (r.r * r.r)); }
    return hgt;
  };
  const sandAt = (x, z) => { if (!p.sand) return false; const s = nearestS(path, x, z); return s >= p.sandStart && s <= p.sandStart + p.sandLength; };
  return { path, height, sandAt, rocks, crater, params: p };
}
function buildPath(p) {
  const ds = 0.1, pts = []; let x = 0, z = 0, hd = 0; // hd : cap (0 = +z)
  for (let s = 0; s <= p.length + 1e-9; s += ds) {
    pts.push({ s, x, z, hd });
    const turning = s >= p.turnStart && s < p.turnStart + (Math.PI / 2) * p.turnRadius;
    if (turning) hd += ds / p.turnRadius;
    x += Math.sin(hd) * ds; z += Math.cos(hd) * ds;
  }
  return { pts, ds, turnStart: p.turnStart, turnEnd: p.turnStart + (Math.PI / 2) * p.turnRadius, R: p.turnRadius };
}
export function pathAt(path, s) { const i = Math.max(0, Math.min(path.pts.length - 1, Math.round(s / path.ds))); return path.pts[i]; }
function nearestS(path, x, z) { let best = 0, bd = Infinity; for (let i = 0; i < path.pts.length; i += 5) { const q = path.pts[i], d = (q.x - x) ** 2 + (q.z - z) ** 2; if (d < bd) { bd = d; best = q.s; } } return best; }

/** Simulation le long de la trajectoire (pas spatial Δs = 0,1 m). */
export function simulate(ter, p = ter.params) {
  const C = CONST, W = C.m * C.g, N0 = W / 6, out = { t: [], s: [], x: [], z: [], hd: [], y: [], pitch: [], roll: [], bogieL: [], bogieR: [], rockerL: [], rockerR: [], power: [], energy: [], wheel: WHEELS.map(() => ({ N: [], F: [], slip: [], I: [], T: [], dy: [] })) };
  const Inom = N0 * C.crr * C.r / C.K + C.I0;
  let E = 0, T = WHEELS.map(() => C.Tamb + 30 * Inom * Inom);
  const dmg = { wheels: WHEELS.map(() => 0), motors: WHEELS.map(() => 0), rockerL: 0, rockerR: 0 };
  const dt = ter.path.ds / p.speed;
  for (let k = 0; k < ter.path.pts.length; k += 1) {
    const P = ter.path.pts[k], c = Math.cos(P.hd), s_ = Math.sin(P.hd);
    const wp = WHEELS.map((w) => { const X = P.x + w.x * c + w.z * s_, Z = P.z - w.x * s_ + w.z * c; return { X, Z, h: ter.height(X, Z), sand: ter.sandAt(X, Z) }; });
    const hF = (wp[0].h + wp[3].h) / 2, hR = (wp[2].h + wp[5].h) / 2, hL = (wp[0].h + wp[1].h + wp[2].h) / 3, hRt = (wp[3].h + wp[4].h + wp[5].h) / 3;
    const pitch = Math.atan2(hF - hR, C.L), roll = Math.atan2(hL - hRt, C.B);
    const y = wp.reduce((a, w) => a + w.h, 0) / 6;
    const bogie = (m, r) => Math.atan2(wp[m].h - wp[r].h, C.lBogie), rocker = (f, m, r) => Math.atan2(wp[f].h - (wp[m].h + wp[r].h) / 2, C.lRocker);
    const turning = P.s >= ter.path.turnStart && P.s < ter.path.turnEnd;
    let Ptot = 0;
    WHEELS.forEach((w, i) => {
      const long = w.z > 0.5 ? -1 : w.z < -0.5 ? 1 : 0, side = w.x > 0 ? 1 : -1;
      let N = N0 * Math.cos(pitch) * Math.cos(roll) + long * (W * C.hcg * Math.sin(pitch) / C.L) / 2 + side * (W * C.hcg * Math.sin(roll) / C.B) / 3;
      // irrégularité locale : roue sur une bosse / un rocher → surcharge (le rocker-bogie la répartit partiellement)
      const planeH = y + Math.tan(pitch) * (w.z + 0.1) + Math.tan(roll) * w.x;
      const dy = wp[i].h - planeH; N *= 1 + Math.max(-0.6, Math.min(1.2, dy * 2.5));
      N = Math.max(0, N);
      // pente locale à la roue dans la direction de marche
      const ahead = ter.height(wp[i].X + s_ * 0.15, wp[i].Z + c * 0.15), loc = Math.atan2(ahead - wp[i].h, 0.15);
      const sand = wp[i].sand;
      const slip = Math.min(0.95, Math.max(0, C.s0 + C.kSlip * Math.tan(Math.max(0, loc)) + (sand ? C.dsSand : 0)));
      const F = N * (sand ? C.crrSand : C.crr) + N0 * Math.sin(loc) + (turning && w.z !== -0.1 ? 0.12 * N * (p.turnRadius < 4 ? 1.6 : 1) : 0);
      const tau = Math.max(0, F) * C.r / Math.max(0.3, 1 - 0.5 * slip); // effort supplémentaire de patinage (démo)
      const I = tau / C.K + C.I0;
      T[i] += (C.Tamb + 30 * I * I - T[i]) * Math.min(1, dt / C.tauTh);
      Ptot += C.Vbus * I;
      const o = out.wheel[i]; o.N.push(N); o.F.push(F); o.slip.push(slip); o.I.push(I); o.T.push(T[i]); o.dy.push(Math.max(-0.2, Math.min(0.2, dy)));
      dmg.wheels[i] += ter.path.ds * Math.max(0, (N / N0) ** 3 - 1);
      dmg.motors[i] += dt * Math.max(0, (I / Inom) ** 3 - 1);
      if (side > 0) dmg.rockerL += ter.path.ds * Math.max(0, (N / N0) ** 3 - 1) / 3; else dmg.rockerR += ter.path.ds * Math.max(0, (N / N0) ** 3 - 1) / 3;
    });
    E += (Ptot * dt) / 3600;
    out.t.push(k * dt); out.s.push(P.s); out.x.push(P.x); out.z.push(P.z); out.hd.push(P.hd); out.y.push(y); out.pitch.push((pitch * 180) / Math.PI); out.roll.push((roll * 180) / Math.PI);
    out.bogieL.push((bogie(1, 2) * 180) / Math.PI); out.bogieR.push((bogie(4, 5) * 180) / Math.PI); out.rockerL.push((rocker(0, 1, 2) * 180) / Math.PI); out.rockerR.push((rocker(3, 4, 5) * 180) / Math.PI);
    out.power.push(Ptot); out.energy.push(E);
  }
  out.dmg = dmg; out.Inom = Inom; out.N0 = N0; out.dt = dt; out.distance = ter.path.pts[ter.path.pts.length - 1].s;
  out.maxI = out.wheel.map((w) => Math.max(...w.I)); out.maxT = out.wheel.map((w) => Math.max(...w.T)); out.maxSlip = out.wheel.map((w) => Math.max(...w.slip));
  return out;
}
export function nominalParams(p) { return { ...p, slopeDeg: 0, craterDepth: 0, rocks: 0, sand: false }; }
