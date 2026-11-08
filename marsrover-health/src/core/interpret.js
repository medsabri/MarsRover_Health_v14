// =============================================================================
// interpret.js — « interprétation intelligente » : textes générés par règles à partir des
// résultats calculés. Chaque phrase indique son niveau de confiance et ses limites.
// =============================================================================
import { fmt, pct } from './dom.js';

export function interpretKM(L, km, w, cmp) {
  const out = [];
  out.push({ t: `Population : ${km.n} unités, ${km.events} défaillances observées, ${km.n - km.events} censures (${pct((km.n - km.events) / km.n, 0)}). Source « ${L.name} ».`, level: 'fait' });
  if (km.median !== null) out.push({ t: `Médiane de survie (Kaplan–Meier) : ${fmt(km.median, 2)} ${L.unit}.`, level: 'estimation' });
  else out.push({ t: `La médiane de survie n'est pas atteinte (R(t) reste > 0,5 sur la période observée).`, level: 'fait' });
  if (w && w.ok) {
    const shape = w.beta > 1.15 ? 'croissant (usure / vieillissement)' : w.beta < 0.85 ? 'décroissant (défaillances de jeunesse / mélange de populations)' : 'quasi constant (défaillances aléatoires)';
    out.push({ t: `Weibull MLE : β = ${fmt(w.beta, 2)}${w.ci ? ` [${fmt(w.ci.beta[0], 2)} ; ${fmt(w.ci.beta[1], 2)}]` : ''} → taux de défaillance ${shape} ; η = ${fmt(w.eta, 1)} ${L.unit}, MTTF = ${fmt(w.mttf, 1)} ${L.unit}, B10 = ${fmt(w.b10, 1)} ${L.unit}.`, level: 'estimation' });
    if (w.ci && w.ci.beta[0] < 1 && w.ci.beta[1] > 1) out.push({ t: 'L\'intervalle de confiance de β contient 1 : l\'hypothèse d\'un taux constant ne peut pas être rejetée avec ces données.', level: 'limite' });
  }
  if (cmp && cmp.rows.length > 1) {
    const d = cmp.rows[1].aic - cmp.rows[0].aic;
    out.push({ t: `Comparaison AIC : ${cmp.rows[0].model} est préférée${d < 2 ? `, mais l'écart avec ${cmp.rows[1].model} (ΔAIC = ${fmt(d, 2)}) est faible : choix de loi non tranché` : ` (ΔAIC = ${fmt(d, 1)})`}.`, level: d < 2 ? 'limite' : 'estimation' });
  }
  if (km.n < 30) out.push({ t: `Petit échantillon (n = ${km.n}) : intervalles de confiance larges, à interpréter avec prudence.`, level: 'limite' });
  if (L.prov === 'simulated') out.push({ t: 'Données SIMULÉES : ces courbes valident la méthode, pas un composant réel.', level: 'limite' });
  if (L.prov === 'experimental') out.push({ t: 'Données EXPÉRIMENTALES de banc d\'essai : non transférables telles quelles à un composant de rover (cahier des charges §9.4).', level: 'limite' });
  return out;
}
export function interpretAnomalies(alerts, metrics) {
  const out = [];
  const by = {}; alerts.forEach((a) => (by[a.componentName] = (by[a.componentName] || 0) + 1));
  const top = Object.entries(by).sort((a, b) => b[1] - a[1]);
  out.push({ t: `${alerts.length} alerte(s) persistante(s) détectée(s) après la fenêtre d'apprentissage (800 h)${top.length ? ` ; principaux composants : ${top.slice(0, 3).map(([k, n]) => `${k} (${n})`).join(', ')}` : ''}.`, level: 'fait' });
  const m = metrics.filter((x) => x.precision !== null);
  if (m.length) {
    const fa = m.reduce((s, x) => s + x.falseAlarms, 0);
    out.push({ t: `Sur les anomalies injectées (vérité terrain connue car données simulées) : ${m.reduce((s, x) => s + x.eventsDetected, 0)} / ${m.reduce((s, x) => s + x.events.length, 0)} événements détectés, ${fa} fausse(s) alerte(s).`, level: 'estimation' });
    const slow = m.filter((x) => x.meanDelay !== null && x.meanDelay > 24);
    if (slow.length) out.push({ t: `Détection tardive pour ${slow.map((x) => `${x.variable} (délai moyen ${fmt(x.meanDelay, 0)} h)`).join(', ')} : une dérive lente n'est signalée qu'une fois l'écart devenu significatif par rapport à la variabilité de son contexte opérationnel.`, level: 'limite' });
  }
  out.push({ t: 'La référence de chaque variable est calculée par contexte (mode opératoire × terrain) : une hausse de courant en pente ou dans le sable n\'est pas une anomalie en soi.', level: 'méthode' });
  out.push({ t: 'Les pertes de liaison pendant les coupures PROGRAMMÉES (hors passage orbiteur) ne sont pas comptées comme pannes.', level: 'méthode' });
  return out;
}
export function interpretRUL(rb, rv) {
  const out = [];
  if (rb && rb.current) {
    const c = rb.current;
    out.push({ t: `Batterie (pack en service, SIMULÉ) : SOH = ${pct(rb.soh, 1)}. RUL = ${fmt(c.value, 0)} cycles [IC 90 % : ${fmt(c.ci[0], 0)} – ${fmt(c.ci[1], 0)}] avant le seuil de 80 % C0, méthode retenue sur validation : ${rb.results[rb.chosen].name}.`, level: 'estimation' });
    const cov = rb.results[rb.chosen].test.coverage;
    if (cov < 0.8) out.push({ t: `Sur les packs de test, l'intervalle n'a couvert la RUL vraie que dans ${pct(cov, 0)} des cas : l'incertitude est probablement SOUS-estimée (peu de packs d'apprentissage).`, level: 'limite' });
  }
  if (rv) {
    out.push({ t: `Roulements (SIMULÉ) : modèle retenu sur validation = ${rv.results[rv.chosen].name} (RMSE test ${fmt(rv.results[rv.chosen].test.rmse, 0)} h).`, level: 'estimation' });
    if (rv.jump.share > 0.5) out.push({ t: `Dans ${pct(rv.jump.share, 0)} des trajectoires, la fin de vie est un SAUT brutal au dernier point (pas une tendance) : l'indicateur vibratoire ne prévient pas la panne, d'où l'avantage du modèle de survie conditionnelle sur l'extrapolation de tendance.`, level: 'limite' });
  }
  out.push({ t: 'Pour les autres composants, aucune fin de vie n\'est définie : la RUL est masquée (règle du cahier des charges).', level: 'règle' });
  return out;
}
export function interpretFMDS(rows) {
  const ok = rows.filter((r) => r.f.computable);
  const out = [{ t: `MTBF/MTTR/disponibilité calculables pour ${ok.length} composant(s) seulement (journal d'événements SIMULÉ) ; ${rows.length - ok.length} composant(s) : non calculable avec les données retenues.`, level: 'règle' }];
  for (const r of ok) out.push({ t: `${r.c.name} : MTBF = ${fmt(r.f.mtbf, 0)} h${r.f.mtbfCI ? ` [IC 90 % : ${fmt(r.f.mtbfCI[0], 0)} – ${fmt(r.f.mtbfCI[1], 0)}]` : ''}, MTTR = ${fmt(r.f.mttr, 2)} h (remise en service), Ai = ${pct(r.f.availability, 2)}, Ao = ${pct(r.f.availabilityAo, 2)}.`, level: 'estimation' });
  out.push({ t: 'MTTR = durée de remise en service (redémarrage, rétablissement de liaison) : en contexte martien, aucune réparation physique n\'est possible.', level: 'méthode' });
  return out;
}
