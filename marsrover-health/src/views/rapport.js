// =============================================================================
// Rapport — rapport technique détaillé du système MarsRover Health :
// présentation, architecture, données, méthodes FMDS, méthode de comparaison des outils
// de détection, résultats chiffrés (graphiques), décisions de correction, validation.
// Les chiffres sont lus dans les résultats du backend (API ou instantané hors ligne).
// =============================================================================
import { h, clear, fmt, pct, icon } from '../core/dom.js';
import { ChartBag, chartBox, lineChart, barChart } from '../core/charts.js';
import * as ML from '../core/mlapi.js';
import { AUDIT } from './ia_audit.js';

const PAL = ['#2563EB', '#E8590C', '#0D9488', '#9333EA', '#DB2777', '#65A30D'];
const GREY = '#94A3B8';
const PDF = 'docs/Rapport_MarsRover_Health.pdf';
const ALGO = {
  isolation_forest: 'Isolation Forest', one_class_svm: 'One-Class SVM', autoencoder: 'Autoencodeur', xgboost: 'XGBoost', random_forest: 'Random Forest', svm: 'SVM',
  lstm: 'LSTM', weibull_population: 'Weibull (sans covariable)', weibull_aft: 'Weibull AFT', random_survival_forest: 'Random Survival Forest',
  weibull_mrl_femto: 'Weibull MRL', xgboost_femto: 'XGBoost', random_forest_femto: 'Random Forest',
};
const algo = (a) => ALGO[a] || a;
const CLS = { surchauffe: 'Surchauffe', defaut_electrique: 'Défaut électrique', defaut_capteur: 'Défaut de capteur', surcharge_moteur: 'Surcharge moteur', surpression: 'Surpression' };

let bag = new ChartBag(), fig = 0, tab = 0;

export default {
  async mount(app, params) {
    bag.destroy(); fig = 0; tab = 0;
    document.body.classList.toggle('rp-print', params.print === '1');
    const doc = h('article.rp-doc', h('div.rp-loading', 'Préparation du rapport…'));
    app.append(
      h('div.view-head.rp-head',
        h('h1', 'Rapport technique du système'),
        h('div.rp-actions',
          h('a.btn.primary', { href: PDF, download: 'Rapport_MarsRover_Health.pdf' }, icon('download'), 'Télécharger le rapport (PDF)'),
          h('button.btn', { type: 'button', on: { click: () => window.print() } }, icon('print'), 'Imprimer'))),
      doc);
    try {
      await ML.init();
      const [cmp, an, dg, fi, rul, refs, df, au] = await Promise.all([ML.comparison(), ML.module('anomalies'), ML.module('diagnostic'), ML.module('fiabilite'),
        ML.module('rul'), ML.module('references'), ML.module('defauts'), ML.audit()]);
      clear(doc);
      build(doc, { cmp, an: an.payload, dg: dg.payload, fi: fi.payload, rul: rul.payload, refs: refs.payload || {}, df: df.payload, au });
      document.body.dataset.reportReady = '1';
    } catch (e) {
      console.error(e);
      clear(doc).append(h('p', 'Résultats indisponibles : ', String(e.message || e)));
    }
  },
  unmount() { bag.destroy(); document.body.classList.remove('rp-print'); delete document.body.dataset.reportReady; },
};

// ------------------------------------------------------------------ éléments de mise en page
const P = (...t) => h('p', ...t);
const B = (t) => h('strong', t);
const UL = (items) => h('ul', items.map((x) => h('li', x)));
function figure(caption, node) { fig += 1; return h('figure.rp-fig', node, h('figcaption', h('b', `Figure ${fig}. `), caption)); }
function img(src, caption) { return figure(caption, h('img', { src, alt: caption, loading: 'eager' })); }
function chart(caption, cls, fn) {
  const { box, canvas } = chartBox(cls);
  requestAnimationFrame(() => requestAnimationFrame(() => { if (canvas.isConnected) bag.add(fn(canvas)); }));
  return figure(caption, box);
}
function table(caption, head, rows, { num = [] } = {}) {
  tab += 1;
  return h('div.rp-tbl', h('div.rp-tcap', h('b', `Tableau ${tab}. `), caption),
    h('table', h('thead', h('tr', head.map((c, i) => h(num.includes(i) ? 'th.num' : 'th', c)))),
      h('tbody', rows.map((r) => h('tr', r.map((c, i) => h(num.includes(i) ? 'td.num' : 'td', c instanceof Node ? c : String(c ?? '—'))))))));
}
const section = (n, title, ...body) => h('section.rp-sec', { id: `rp-${n}` }, h('h2', h('span.n', n), title), ...body);
const sub = (title, ...body) => h('div.rp-sub', h('h3', title), ...body);
const box = (kind, title, ...body) => h(`div.rp-box.${kind}`, h('b', title), ...body);
const f3 = (v) => fmt(v, 3), p1 = (v) => pct(v, 1);

// ------------------------------------------------------------------ construction du rapport
function build(doc, D) {
  const task = (re) => D.cmp.find((t) => re.test(t.task));
  const T = { det: task(/anomalies/i), diag: task(/Diagnostic/i), surv: task(/Fiabilit/i), rul: task(/^Pronostic RUL/i), risk: task(/risque/i), femto: task(/FEMTO/i) };
  const m = (t, a) => (t.rows.find((r) => r.algorithm === a) || { metrics: {} }).metrics;
  const det = T.det, best = det.best;
  const W = D.fi.weibull_cmapss;
  const ds = D.au.datasets || [];
  const nAudit = (s) => AUDIT.filter((x) => x.state === s).length;
  const date = new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' }).format(new Date());

  // ---------------- page de garde
  doc.append(h('header.rp-cover',
    h('div.rp-logos', h('img', { src: 'assets/img/polytechnique-sousse.png', alt: 'École Polytechnique de Sousse' }), h('img.app', { src: 'assets/img/logo.png', alt: 'MarsRover Health' })),
    h('div.rp-kicker', 'Projet Pratique — Rapport technique'),
    h('h1', 'MarsRover Health'),
    h('p.rp-subtitle', 'Surveillance FMDS et maintenance prédictive des sous-systèmes d\'un rover martien : détection d\'anomalies, diagnostic, fiabilité et pronostic de durée de vie restante'),
    h('img.rp-cover-img', { src: 'assets/img/report/rover3d.jpg', alt: 'Jumeau numérique 3D du rover' }),
    h('div.rp-authors',
      h('div', h('span', 'Réalisé par'), h('b', 'Mohamed Sabri BEN SLIMENE'), h('b', 'Wassim FARHAT')),
      h('div', h('span', 'Encadré par'), h('b', 'M. Faycel BEN HMIDA')),
      h('div', h('span', 'Établissement'), h('b', 'École Polytechnique de Sousse')),
      h('div', h('span', 'Date'), h('b', date)))));

  // ---------------- résumé + sommaire
  doc.append(h('section.rp-sec.rp-abstract', h('h2', 'Résumé'),
    P('Ce rapport présente MarsRover Health, une plateforme d\'aide à la décision qui évalue la fiabilité, la maintenabilité, la disponibilité et la sécurité (FMDS) des sous-systèmes d\'un rover martien, et qui en anticipe les défaillances par apprentissage automatique. ',
      'Le système associe un jumeau numérique 3D, un tableau de bord FMDS, un module de tests de perturbation, une simulation de terrain et un backend analytique (Python, SQLite, API REST) qui entraîne, compare et versionne les modèles.'),
    P('Les modèles sont évalués sur des jeux de référence publics (NASA C-MAPSS, Milling, batteries Li-ion, IGBT, FEMTO/PRONOSTIA et HIRF) selon un protocole sans fuite d\'information : apprentissage sur des unités ou des périodes distinctes de celles du test, seuils fixés sur un jeu de validation et choix du modèle par un critère unique déclaré à l\'avance. ',
      `En détection d'anomalies, ${algo(best)} est retenu (F1 = ${f3(m(det, best).f1)}, taux de fausses alertes ${p1(m(det, best).fpr)}). `,
      `Le pronostic de durée de vie restante par ${algo(T.rul.best)} atteint un RMSE de ${fmt(m(T.rul, T.rul.best).RMSE, 1)} cycles, contre ${fmt(D.rul.baseline_constant.RMSE, 1)} pour un prédicteur constant. `,
      'Le rapport détaille également l\'audit de l\'application initiale et les décisions de correction qui en découlent.'),
    h('p.rp-kw', B('Mots-clés : '), 'FMDS, PHM, maintenance prédictive, détection d\'anomalies, Isolation Forest, One-Class SVM, autoencodeur, Weibull, survie, RUL, XGBoost, LSTM, AMDEC, arbre de défaillances.')));
  doc.append(h('nav.rp-toc', h('h2', 'Sommaire'), h('ol', [
    'Contexte, problématique et objectifs', 'Présentation du système', 'Architecture logicielle', 'Données et provenance', 'Méthodes FMDS',
    'Méthode de comparaison des outils de détection', 'Résultats de la détection d\'anomalies', 'Diagnostic, fiabilité, pronostic et risque',
    'Validation sur données expérimentales (FEMTO, HIRF)', 'Diagnostic des cinq classes de défaut', 'Décisions de correction', 'Vérification et validation', 'Limites et perspectives', 'Conclusion',
  ].map((t, i) => h('li', h('a', { href: `#rp-${i + 1}`, on: { click: (e) => { e.preventDefault(); document.getElementById(`rp-${i + 1}`)?.scrollIntoView({ behavior: 'smooth' }); } } }, t))))));

  // ---------------- 1. contexte
  doc.append(section(1, 'Contexte, problématique et objectifs',
    P('Un rover martien opère à plusieurs minutes-lumière de la Terre, sans possibilité d\'intervention physique. Chaque défaillance non anticipée d\'une roue, d\'un moteur de traction, d\'une batterie ou d\'un calculateur peut compromettre la mission. ',
      'La maintenance y est donc avant tout prédictive et opérationnelle : il s\'agit d\'adapter l\'usage (vitesse, couple, séquencement des charges, choix de trajectoire) avant que la dégradation ne devienne critique.'),
    P(B('Problématique. '), 'Comment estimer, à partir de la télémétrie et de données de référence, l\'état de santé de chaque sous-système, détecter tôt les comportements anormaux, en identifier la cause probable et prévoir la durée de vie restante, tout en garantissant la traçabilité et l\'honnêteté des résultats lorsque les données réelles de mission sont absentes ?'),
    P(B('Objectifs. ')),
    UL(['Calculer les indicateurs FMDS (R(t), λ(t), MTTF, MTBF, MTTR, disponibilités Ai et Ao, NPR, probabilité de l\'événement redouté).',
      'Détecter les anomalies avec plusieurs algorithmes et les comparer selon un protocole rigoureux.',
      'Diagnostiquer l\'usure et cinq classes de défaut (surchauffe, surpression, défaut électrique, défaut de capteur, surcharge moteur).',
      'Pronostiquer la durée de vie restante (RUL) avec un intervalle d\'incertitude.',
      'Produire des recommandations de maintenance traçables, validées par un opérateur humain.'])));

  // ---------------- 2. présentation
  doc.append(section(2, 'Présentation du système',
    P('MarsRover Health est une application web monopage, utilisable hors ligne, organisée autour d\'un jumeau numérique du rover. Chaque composant (25 au total, répartis en 8 sous-systèmes) possède une fiche : fonction, durée de vie nominale, usage actuel, vie consommée avec sa plage d\'incertitude, provenance des données et état.'),
    img('assets/img/report/rover3d.jpg', 'Accueil 3D : jumeau numérique du rover, fiches des composants et état de santé coloré par pièce.'),
    P('Le tableau de bord FMDS regroupe la santé globale pondérée par la criticité, la répartition des états, la santé par sous-système, les courbes temporelles avec seuils et zones d\'alerte, la fiabilité (Kaplan–Meier, Weibull), la matrice de criticité AMDEC et le pronostic.'),
    img('assets/img/report/dashboard.jpg', 'Tableau de bord FMDS — vue d\'ensemble de l\'état du rover.'),
    h('div.rp-grid2',
      img('assets/img/report/perturbations.jpg', 'Tests de perturbation : injection d\'un défaut, détection, délai et propagation.'),
      img('assets/img/report/terrain.jpg', 'Simulation de terrain rocker-bogie et impact sur les composants.')),
    img('assets/img/report/ia_anomalies.jpg', 'Section « IA prédictive » : résultats des modèles calculés par le backend.'),
    table('Interfaces de l\'application et rôle de chacune.', ['Interface', 'Rôle'], [
      ['À la une', 'Présentation du projet et de l\'équipe.'], ['Accueil 3D', 'Jumeau numérique, sélection d\'un composant en 3D ou par sa fiche.'],
      ['Tableau de bord', 'Indicateurs FMDS, anomalies, pronostic, export CSV.'], ['IA prédictive', 'Douze onglets : anomalies, diagnostic, fiabilité, RUL, maintenabilité, disponibilité, AMDEC/FTA, comparaison, modèles, FEMTO & HIRF, recommandations, audit.'],
      ['Maintenance', 'Plan préventif paramétrique ou par substitution, calendrier et export.'], ['Catalogue', 'Durée nominale, usage, écart et vie consommée par composant.'],
      ['Perturbations', 'Scénarios de défaut, détection, facteur d\'accélération, risque et propagation.'], ['Terrain', 'Simulation de franchissement et effets sur les courants et la charge.'],
      ['Données', 'Inventaire des jeux, import avec correspondance des colonnes et provenance obligatoire.'], ['Rapport', 'Le présent rapport, téléchargeable en PDF.']])));

  // ---------------- 3. architecture
  doc.append(section(3, 'Architecture logicielle',
    P('L\'architecture sépare strictement l\'affichage du calcul. Le navigateur n\'entraîne aucun modèle : il lit des résultats déjà calculés et stockés, soit en direct par l\'API, soit dans un instantané embarqué lorsque l\'application est ouverte hors ligne.'),
    figure('Architecture en couches de MarsRover Health.', h('div.rp-archi', { html: ARCHI_SVG })),
    UL([h('span', B('Frontend : '), 'modules ES regroupés par esbuild, rendu 3D three.js, graphiques Chart.js, routage par ancre (#/…).'),
      h('span', B('Backend : '), 'Python, serveur HTTP de la bibliothèque standard, API REST JSON, export CSV, tâches d\'entraînement en arrière-plan.'),
      h('span', B('Persistance : '), 'SQLite avec migrations versionnées, 14 tables métier plus recommandations et journal d\'audit ; chaque résultat porte l\'équipement, l\'algorithme, la version du modèle, l\'unité, la provenance et le statut de validation.'),
      h('span', B('Registre de modèles : '), 'six statuts (non entraîné, en attente de données, en cours, entraîné, validé, erreur) ; une prédiction est refusée pour un modèle non entraîné.')])));

  // ---------------- 4. données
  const PROV = { simulated: 'Simulé', experimental: 'Expérimental', substituted: 'Estimé par substitution', mission: 'Réel mission' };
  doc.append(section(4, 'Données et provenance',
    P('Chaque donnée porte une provenance explicite, affichée sur chaque bloc de l\'interface. Aucune valeur manquante n\'est imputée et aucune valeur aberrante n\'est corrigée : elles sont signalées par un indicateur de qualité et exclues des calculs concernés.'),
    table('Jeux de données chargés en base.', ['Jeu', 'Équipement', 'Unités', 'Unité de temps', 'Provenance'], ds.map((d) => [d.dataset, d.kind, d.n, d.unit, PROV[d.provenance] || d.provenance]), { num: [2] }),
    P(`La base contient ${fmt(D.au.sensor_data, 0)} mesures et ${fmt(D.au.failure_history, 0)} durées de vie, dont ${fmt(D.au.failures_observed, 0)} défaillances observées et ${fmt(D.au.censored, 0)} observations censurées ; ${fmt(D.au.missing_values, 0)} valeurs manquantes sont conservées telles quelles.`)));

  // ---------------- 5. FMDS
  const tR = W.curve.t, R = tR.map((t) => Math.exp(-((t / W.eta) ** W.beta)));
  const lam = tR.map((t) => (W.beta / W.eta) * (t / W.eta) ** (W.beta - 1) * 1000);
  doc.append(section(5, 'Méthodes FMDS',
    table('Indicateurs FMDS et formules appliquées.', ['Indicateur', 'Formule', 'Commentaire'], [
      ['Fiabilité', 'R(t) = exp(−(t/η)^β)', 'Weibull à 2 paramètres, maximum de vraisemblance avec censure à droite'],
      ['Taux de défaillance', 'λ(t) = (β/η)(t/η)^(β−1)', 'β > 1 : usure ; β < 1 : défaillances de jeunesse'],
      ['MTTF', 'η·Γ(1 + 1/β)', 'Durée moyenne de fonctionnement avant défaillance'],
      ['MTBF', 'U / r', 'U : temps de fonctionnement, r : nombre de pannes'],
      ['MTTR', 'Σ durées des réparations terminées / nombre', 'Les réparations en cours sont exclues'],
      ['Disponibilité inhérente', 'Ai = MTBF / (MTBF + MTTR)', 'Arrêts sur panne uniquement'],
      ['Disponibilité opérationnelle', 'Ao = U / (U + Dp + Ds)', 'Tous les arrêts, planifiés ou non'],
      ['Criticité', 'NPR = G × O × D', 'Gravité, occurrence, détectabilité (1 à 10)'],
      ['Arbre de défaillances', 'P(ET) = Π pᵢ ; P(OU) = 1 − Π(1 − pᵢ)', 'Événements de base indépendants ; bornes si une probabilité manque']]),
    P(`Appliquée aux 200 turboréacteurs C-MAPSS FD001 (100 défaillances, 100 censures), la loi de Weibull donne β = ${fmt(W.beta, 2)} [${fmt(W.beta_ci[0], 2)} ; ${fmt(W.beta_ci[1], 2)}] et η = ${fmt(W.eta, 0)} cycles, soit un MTTF de ${fmt(W.mttf, 0)} cycles. `,
      'Un paramètre de forme nettement supérieur à 1 caractérise un mécanisme d\'usure : le taux de défaillance croît rapidement avec l\'âge, ce qui justifie une maintenance conditionnelle plutôt que systématique.'),
    h('div.rp-grid2',
      chart('Fonction de fiabilité R(t) — Weibull, C-MAPSS FD001.', 'tall', (c) => lineChart(c, [{ label: 'R(t)', data: tR.map((t, i) => ({ x: t, y: R[i] })), color: PAL[0], width: 2.5 }], { xLabel: 'cycles', yLabel: 'R(t)', yMin: 0, yMax: 1, legend: false })),
      chart('Taux de défaillance λ(t) (×10⁻³ / cycle).', 'tall', (c) => lineChart(c, [{ label: 'λ(t)', data: tR.map((t, i) => ({ x: t, y: lam[i] })), color: PAL[1], width: 2.5 }], { xLabel: 'cycles', yLabel: 'λ(t) ×10⁻³', yMin: 0, legend: false })))));

  // ---------------- 6. méthode de comparaison
  doc.append(section(6, 'Méthode de comparaison des outils de détection',
    P('Comparer des détecteurs d\'anomalies n\'a de sens que si tous sont évalués dans des conditions identiques et sur des données qu\'ils n\'ont jamais vues. Le protocole retenu suit les bonnes pratiques de la littérature PHM et se décompose en cinq étapes.'),
    h('ol.rp-steps',
      h('li', B('Apprentissage sur le fonctionnement normal uniquement. '), 'Les trois détecteurs (Isolation Forest, One-Class SVM, autoencodeur 14-8-4-8-14) apprennent la distribution des 14 capteurs informatifs sur les 50 premiers cycles de chaque unité d\'apprentissage, période réputée saine.'),
      h('li', B('Normalisation commune. '), 'Les capteurs sont centrés et réduits avec les statistiques du seul jeu d\'apprentissage ; aucune information du test n\'est utilisée.'),
      h('li', B('Seuil de décision fixé sur la validation. '), 'Pour chaque détecteur, le seuil est le quantile 99 % des scores sur un jeu de validation normal distinct. Ce choix fixe a priori le taux de fausses alertes visé à environ 1 % et rend les outils comparables.'),
      h('li', B('Jeu de test étiqueté. '), 'Le test NASA définit deux classes nettes : normal (RUL > 125 cycles) et anormal (RUL ≤ 30 cycles). La zone intermédiaire, ambiguë par nature, est exclue de l\'évaluation des métriques ponctuelles.'),
      h('li', B('Critère unique déclaré à l\'avance. '), 'Le meilleur outil est celui qui maximise le F1 ; en cas d\'écart inférieur à 0,005, le taux de fausses alertes puis l\'avance de détection départagent les candidats.')),
    table('Métriques utilisées pour comparer les détecteurs.', ['Métrique', 'Définition', 'Intérêt opérationnel'], [
      ['Précision', 'VP / (VP + FP)', 'Part des alertes réellement justifiées : coût des interventions inutiles'],
      ['Rappel', 'VP / (VP + FN)', 'Part des anomalies détectées : risque de défaillance non vue'],
      ['F1', '2·P·R / (P + R)', 'Compromis unique entre précision et rappel (critère de choix)'],
      ['AUC-ROC', 'Aire sous la courbe ROC', 'Pouvoir de séparation indépendant du seuil'],
      ['Taux de fausses alertes', 'FP / (FP + VN)', 'Charge de travail des opérateurs'],
      ['Avance médiane', 'Cycles entre la première alerte persistante et la défaillance', 'Temps disponible pour planifier une action']])));

  // ---------------- 7. résultats détection
  const dRows = det.rows;
  const KEYS = [['precision', 'Précision'], ['recall', 'Rappel'], ['f1', 'F1'], ['auc_roc', 'AUC-ROC']];
  doc.append(section(7, 'Résultats de la détection d\'anomalies',
    table('Comparaison des détecteurs sur le test C-MAPSS FD001 (données jamais vues).', ['Détecteur', 'Précision', 'Rappel', 'F1', 'AUC-ROC', 'Fausses alertes', 'Avance (cycles)', 'Entraînement (s)'],
      dRows.map((r) => [h('span', algo(r.algorithm), r.algorithm === best ? h('span.rp-best', 'retenu') : null), p1(r.metrics.precision), p1(r.metrics.recall), f3(r.metrics.f1), fmt(r.metrics.auc_roc, 4), p1(r.metrics.fpr), fmt(r.metrics.lead_median_cycles, 0), fmt(r.train_time_s, 2)]), { num: [1, 2, 3, 4, 5, 6, 7] }),
    h('div.rp-grid2',
      chart('Précision, rappel, F1 et AUC-ROC par détecteur.', 'tall', (c) => barChart(c, KEYS.map((k) => k[1]), dRows.map((r, i) => ({ label: algo(r.algorithm), data: KEYS.map(([k]) => r.metrics[k]), color: PAL[i] })), { yMax: 1 })),
      chart('Avance médiane de détection avant défaillance (cycles).', 'tall', (c) => barChart(c, dRows.map((r) => algo(r.algorithm)), [{ label: 'Avance', data: dRows.map((r) => r.metrics.lead_median_cycles), colors: dRows.map((_, i) => PAL[i]) }], { legend: false }))),
    sub('Analyse',
      P(`Les deux détecteurs à frontière (Isolation Forest et One-Class SVM) obtiennent des performances très proches : F1 de ${f3(m(det, 'isolation_forest').f1)} et ${f3(m(det, 'one_class_svm').f1)}, AUC supérieure à 0,999 et environ 1 % de fausses alertes, conforme au seuil fixé. `,
        `L'autoencodeur est plus précis (${p1(m(det, 'autoencoder').precision)}) mais manque davantage d'anomalies (rappel ${p1(m(det, 'autoencoder').recall)}) et alerte plus tard (${fmt(m(det, 'autoencoder').lead_median_cycles, 0)} cycles d'avance contre ${fmt(m(det, 'one_class_svm').lead_median_cycles, 0)}).`),
      P('Les AUC proches de 1 s\'expliquent par la construction du test : la zone ambiguë étant exclue, les deux classes sont bien séparées. La valeur discriminante pour l\'exploitation est donc l\'avance de détection, qui conditionne le temps de réaction de l\'équipe.')),
    box('decision', 'Décision', P(`${algo(best)} est retenu comme détecteur principal (meilleur F1 et meilleure avance, ${fmt(m(det, best).lead_median_cycles, 0)} cycles). L'Isolation Forest est conservé en second avis, car son score est interprétable par variable et son coût de prédiction reste faible ; une alerte confirmée par les deux détecteurs est classée prioritaire.`))));

  // ---------------- 8. diagnostic, fiabilité, RUL, risque
  const crit = (t) => t.rows.filter((r) => r.key != null);
  doc.append(section(8, 'Diagnostic, fiabilité, pronostic et risque',
    sub('8.1 Diagnostic d\'usure (Milling)',
      P(`Classification de l'état d'usure d'outils de fraisage (normal, usure critique, défaut mécanique) selon les seuils ISO 3685 (VB = 0,3 et 0,6 mm). La validation « un outil exclu » (16 plis) garantit qu'un outil n'est jamais à la fois en apprentissage et en test. Référence : la classe majoritaire atteint un F1 macro de ${f3(D.dg.majority_baseline.f1_macro)}.`),
      chart('F1 macro par algorithme (validation hors outil) comparé à la classe majoritaire.', '', (c) => barChart(c, [...crit(T.diag).map((r) => algo(r.algorithm)), 'Classe majoritaire'], [{ label: 'F1 macro', data: [...crit(T.diag).map((r) => r.metrics.f1_macro), D.dg.majority_baseline.f1_macro], colors: [...crit(T.diag).map((_, i) => PAL[i]), GREY] }], { legend: false, yMax: 1 })),
      box('decision', 'Décision', P(`${algo(T.diag.best)} est retenu (F1 macro ${f3(m(T.diag, T.diag.best).f1_macro)}), devant XGBoost pourtant prévu au cahier des charges : le choix suit uniquement le critère de validation. L'écart-type entre outils (${f3(m(T.diag, T.diag.best).f1_macro_fold_std)}) rappelle que 16 outils constituent un échantillon réduit.`))),
    sub('8.2 Survie conditionnelle S(t | X)',
      P('Sur 1 416 turboréacteurs C-MAPSS FD001–FD004, dont 49 % censurés, trois modèles de survie sont comparés par l\'indice de concordance (C-index, à maximiser) et le score de Brier intégré (IBS, à minimiser).'),
      table('Comparaison des modèles de survie (jeu de test, 30 % des unités).', ['Modèle', 'C-index', 'IBS'], crit(T.surv).map((r) => [h('span', algo(r.algorithm), r.algorithm === T.surv.best ? h('span.rp-best', 'retenu') : null), f3(r.metrics.c_index), fmt(r.metrics.ibs, 4)]), { num: [1, 2] }),
      box('decision', 'Décision', P(`${algo(T.surv.best)} est retenu : meilleur C-index et meilleur IBS. La Random Survival Forest, plus flexible, ne compense pas la taille limitée des covariables disponibles à la mise en service.`))),
    sub('8.3 Pronostic de durée de vie restante (RUL)',
      P(`Cible plafonnée à ${D.rul.cap} cycles ; fenêtres glissantes de ${D.rul.window} cycles ; évaluation au dernier cycle observé des 100 unités de test NASA.`),
      chart('RMSE du pronostic RUL (cycles) comparé au prédicteur constant.', '', (c) => barChart(c, [...crit(T.rul).map((r) => algo(r.algorithm)), 'Prédicteur constant'], [{ label: 'RMSE', data: [...crit(T.rul).map((r) => r.metrics.RMSE), D.rul.baseline_constant.RMSE], colors: [...crit(T.rul).map((_, i) => PAL[i]), GREY] }], { legend: false })),
      box('decision', 'Décision', P(`${algo(T.rul.best)} est retenu (RMSE ${fmt(m(T.rul, T.rul.best).RMSE, 2)} cycles, R² ${f3(m(T.rul, T.rul.best).R2)}), le LSTM restant en alternative (RMSE ${fmt(m(T.rul, 'lstm').RMSE, 2)}). Ces erreurs sont de l'ordre de grandeur publié pour FD001 et environ trois fois inférieures à celle du prédicteur constant.`))),
    sub('8.4 Classification des situations à risque (RUL ≤ 30 cycles)',
      table('Classification du risque.', ['Modèle', 'Précision', 'Rappel', 'F1', 'AUC-ROC'], crit(T.risk).map((r) => [h('span', algo(r.algorithm), r.algorithm === T.risk.best ? h('span.rp-best', 'retenu') : null), p1(r.metrics.precision), p1(r.metrics.recall), f3(r.metrics.f1), fmt(r.metrics.auc_roc, 4)]), { num: [1, 2, 3, 4] }),
      P(`En sécurité, un rappel élevé est prioritaire : manquer une situation à risque coûte davantage qu'une alerte superflue. ${algo(T.risk.best)} offre le meilleur rappel (${p1(m(T.risk, T.risk.best).recall)}) et le meilleur F1.`))));

  // ---------------- 9. FEMTO / HIRF
  const F = D.refs.femto;
  doc.append(section(9, 'Validation sur données expérimentales (FEMTO, HIRF)',
    P('Les jeux FEMTO/PRONOSTIA (17 roulements vieillis en conditions accélérées) et HIRF (53 essais de batteries d\'un avion électrique Edge 540) apportent des mesures réelles de laboratoire. Ils servent à confronter les méthodes à des signaux bruités et à des durées de vie dispersées.'),
    F ? P(`FEMTO — Weibull sur les 17 durées de vie : β = ${fmt(F.reliability.beta, 2)} (usure), η = ${fmt(F.reliability.eta, 2)} h, MTTF = ${fmt(F.reliability.mttf, 2)} h, B10 = ${fmt(F.reliability.b10, 2)} h ; l'adéquation n'est pas rejetée (KS p = ${fmt(F.reliability.ks_p, 2)}).`) : null,
    T.femto ? chart('Erreur absolue moyenne (h) du pronostic RUL sur les 11 roulements de test FEMTO.', '', (c) => barChart(c, crit(T.femto).map((r) => algo(r.algorithm)), [{ label: 'MAE (h)', data: crit(T.femto).map((r) => r.metrics.MAE), colors: crit(T.femto).map((_, i) => PAL[i]) }], { legend: false })) : null,
    box('decision', 'Décision', P('La référence statistique Weibull MRL (durée résiduelle moyenne conditionnelle) fait mieux que XGBoost et Random Forest. Avec seulement six durées d\'apprentissage très dispersées, un modèle supervisé ne généralise pas : les modèles appris ne sont donc pas validés et la référence statistique est conservée.')),
    P('HIRF — la résistance interne estimée vaut environ 48 mΩ pour les packs 20 V et 97 mΩ pour les packs 40 V, rapport cohérent avec un nombre double d\'éléments en série. Sa hausse au fil des essais est significative pour deux packs du même circuit série. Aucune décharge n\'atteignant la fin de vie, la fiabilité et la RUL ne sont pas calculables sur ce jeu.')));

  // ---------------- 10. 5 classes
  const ev = D.df.rover_eval || {};
  const evK = Object.keys(ev);
  doc.append(section(10, 'Diagnostic des cinq classes de défaut',
    P('Aucun jeu ne contient d\'historique de pannes étiqueté par cause : un classifieur supervisé ne peut pas être entraîné de manière crédible. Les cinq classes sont donc traitées par des règles techniques explicites dont la référence normale est apprise sur une période saine : seuil à 4 écarts-types robustes, persistance de 2 à 3 échantillons, et détection des capteurs figés ou physiquement impossibles.'),
    table('Évaluation des règles sur la télémétrie rover (anomalies injectées, après 800 h).', ['Classe', 'Épisodes détectés', 'Précision (échantillons)', 'Fausses alarmes', 'Délai médian (h)'],
      evK.map((k) => [CLS[k] || k, `${ev[k].episodes_detectes} / ${ev[k].episodes}`, p1(ev[k].precision_echantillons), ev[k].fausses_alarmes, fmt(ev[k].delai_median_h, 0)]), { num: [1, 2, 3, 4] }),
    chart('Précision par classe de défaut (règles techniques).', '', (c) => barChart(c, evK.map((k) => CLS[k] || k), [{ label: 'Précision', data: evK.map((k) => ev[k].precision_echantillons), colors: evK.map((_, i) => PAL[i]) }], { legend: false, yMax: 1 })),
    P('La précision plus faible du défaut électrique s\'explique physiquement : une surcharge moteur fait aussi chuter la tension batterie, si bien que les deux signatures se recouvrent. La surpression n\'est pas évaluable sur le rover, faute de capteur de pression ; la règle est appliquée aux turboréacteurs C-MAPSS. Chaque détection est associée à une action de maintenance préventive explicite.')));

  // ---------------- 11. décisions de correction
  const LBL = { incorrect: 'Incorrecte', partiel: 'Partielle', absent: 'Absente', impossible: 'Non validable' };
  const corr = AUDIT.filter((a) => a.state !== 'correct');
  doc.append(section(11, 'Décisions de correction',
    P(`L'audit de l'application initiale a porté sur ${AUDIT.length} fonctionnalités : ${nAudit('correct')} étaient correctes, ${nAudit('incorrect')} incorrectes, ${nAudit('partiel')} partielles, ${nAudit('absent')} absentes et ${nAudit('impossible')} impossibles à valider faute de données. Chaque écart a donné lieu à une décision documentée.`),
    table('Constats de l\'audit et décisions de correction.', ['Domaine', 'Fonctionnalité', 'État initial', 'Constat', 'Décision'], corr.map((a) => [a.area, a.feature, LBL[a.state] || a.state, a.finding, a.action])),
    sub('Principales corrections',
      UL([h('span', B('Disponibilité. '), 'L\'indicateur présenté comme « opérationnel » était en réalité la disponibilité inhérente Ai ; il est renommé et la disponibilité opérationnelle Ao est ajoutée.'),
        h('span', B('Isolation Forest. '), 'Le sous-échantillonnage se faisait avec remise, contrairement à l\'algorithme de Liu et al. (2008) ; il est corrigé par un tirage sans remise.'),
        h('span', B('Provenance. '), 'C-MAPSS, produit par un simulateur, était présenté comme réel ; il est désormais marqué « simulé ». Milling, batteries, IGBT, FEMTO et HIRF sont marqués « expérimental ».'),
        h('span', B('Qualité des données. '), 'Cellules hors critère dès le départ, capacités nulles, doublons, unités non documentées : signalés par un indicateur de qualité et exclus des calculs, jamais corrigés.'),
        h('span', B('Architecture. '), 'Les calculs analytiques sont déplacés vers un backend testé, avec base SQL, registre de modèles et API ; l\'interface n\'affiche que des résultats versionnés.'),
        h('span', B('Prévisions sans données. '), 'MTTR et disponibilité prévisionnels restent « en attente de données » : aucune performance n\'est simulée pour combler l\'absence d\'historique réel.')]))));

  // ---------------- 12. V&V
  doc.append(section(12, 'Vérification et validation',
    table('Campagne de tests.', ['Suite', 'Contenu', 'Résultat'], [
      ['Tests unitaires backend', 'Formules FMDS, Weibull comparé à lifelines, gradient LSTM, arbre de défaillances, garde-fous, API, persistance', '28 / 28'],
      ['Tests de bout en bout (ouverture locale)', 'Navigation, 3D, tableau de bord, maintenance, catalogue, perturbations, terrain, données, IA, rapport, responsive', 'Tous réussis'],
      ['Tests de bout en bout (backend réel)', 'Même parcours, résultats lus en direct par l\'API', 'Tous réussis'],
      ['Rendu multi-écrans', '1 920 à 390 px', 'Aucun débordement horizontal'],
      ['Reproductibilité', 'Reconstruction complète avec graine fixe', 'Métriques identiques']]),
    P('Le gradient analytique du LSTM est vérifié par différences finies (erreur relative de l\'ordre de 10⁻⁷). Les estimateurs de Weibull et de Kaplan–Meier sont confrontés à la bibliothèque de référence lifelines.')));

  // ---------------- 13. limites
  doc.append(section(13, 'Limites et perspectives',
    UL(['Les données de mission réelles du rover ne sont pas disponibles : les durées de vie des composants sont estimées par substitution à partir de jeux de laboratoire, et ce transfert reste à valider.',
      'Les essais FEMTO sont accélérés (4 à 5 kN, quelques heures) et ne sont pas directement transposables à un roulement de roue.',
      'Le MTTR et la disponibilité prévisionnels nécessitent au moins 30 réparations terminées et 24 périodes d\'exploitation documentées.',
      'Un diagnostic supervisé multi-pannes nécessite un historique étiqueté par cause confirmée (au moins 30 cas par classe).']),
    P(B('Perspectives. '), 'Intégrer un flux de télémétrie réel, calibrer les seuils par contexte opérationnel, quantifier l\'incertitude des pronostics par méthodes bayésiennes et boucler les recommandations validées par les opérateurs vers le réentraînement des modèles.')));

  // ---------------- 14. conclusion
  doc.append(section(14, 'Conclusion',
    P('MarsRover Health fournit une chaîne complète et traçable, de la donnée brute à la recommandation de maintenance. Les outils de détection ont été comparés selon un protocole identique, sans fuite d\'information, avec un critère de choix déclaré à l\'avance ; les modèles retenus surpassent systématiquement les références naïves, et les modèles qui ne le font pas ne sont pas validés.'),
    P('Les décisions de correction issues de l\'audit ont renforcé la rigueur du système : indicateurs correctement nommés, algorithmes conformes à leur définition, provenance explicite et résultats versionnés. L\'outil constitue ainsi une base solide pour une maintenance prédictive fondée sur les données, prête à être alimentée par une télémétrie de mission réelle.'),
    h('div.rp-refs', h('h3', 'Références'), h('ol', [
      'Saxena A. et al. (2008). Damage propagation modeling for aircraft engine run-to-failure simulation. PHM08.',
      'Liu F. T., Ting K. M., Zhou Z.-H. (2008). Isolation Forest. IEEE ICDM.',
      'Schölkopf B. et al. (2001). Estimating the support of a high-dimensional distribution. Neural Computation.',
      'Ishwaran H. et al. (2008). Random survival forests. Annals of Applied Statistics.',
      'Graf E. et al. (1999). Assessment and comparison of prognostic classification schemes for survival data. Statistics in Medicine.',
      'Nectoux P. et al. (2012). PRONOSTIA: an experimental platform for bearings accelerated degradation tests. IEEE PHM.',
      'Agogino A., Goebel K. (2007). Milling data set. NASA Prognostics Center of Excellence.',
      'Saha B., Goebel K. (2007). Battery data set. NASA Prognostics Center of Excellence.',
      'ISO 3685:1993. Tool-life testing with single-point turning tools.',
      'IEC 60812:2018. Failure modes and effects analysis (FMEA and FMECA).'].map((r) => h('li', r))))));
}

const ARCHI_SVG = `<svg viewBox="0 0 900 330" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Architecture">
<defs><marker id="ar" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="#64748B"/></marker></defs>
<g font-family="Inter, sans-serif" font-size="13">
<rect x="20" y="20" width="860" height="70" rx="12" fill="#EFF6FF" stroke="#2563EB"/>
<text x="40" y="46" font-weight="700" fill="#1D4ED8">Navigateur — application monopage</text>
<text x="40" y="70" fill="#334155">Jumeau 3D · Tableau de bord FMDS · Maintenance · Catalogue · Perturbations · Terrain · IA prédictive · Rapport</text>
<rect x="20" y="130" width="410" height="70" rx="12" fill="#FFF7ED" stroke="#E8590C"/>
<text x="40" y="156" font-weight="700" fill="#C2410C">API REST (Python)</text>
<text x="40" y="180" fill="#334155">JSON · filtres équipement / période · export CSV</text>
<rect x="470" y="130" width="410" height="70" rx="12" fill="#F0FDFA" stroke="#0D9488"/>
<text x="490" y="156" font-weight="700" fill="#0F766E">Instantané hors ligne</text>
<text x="490" y="180" fill="#334155">mêmes réponses que l'API · lecture seule</text>
<rect x="20" y="240" width="270" height="70" rx="12" fill="#FAF5FF" stroke="#9333EA"/>
<text x="40" y="266" font-weight="700" fill="#7E22CE">Services analytiques</text>
<text x="40" y="290" fill="#334155">anomalies · diagnostic · fiabilité · RUL…</text>
<rect x="315" y="240" width="270" height="70" rx="12" fill="#FDF2F8" stroke="#DB2777"/>
<text x="335" y="266" font-weight="700" fill="#BE185D">Registre de modèles</text>
<text x="335" y="290" fill="#334155">versions · statuts · métriques</text>
<rect x="610" y="240" width="270" height="70" rx="12" fill="#F7FEE7" stroke="#65A30D"/>
<text x="630" y="266" font-weight="700" fill="#4D7C0F">Base SQLite</text>
<text x="630" y="290" fill="#334155">mesures · résultats · audit</text>
<path d="M225 92V128" stroke="#64748B" stroke-width="1.6" marker-end="url(#ar)" marker-start="url(#ar)"/>
<path d="M675 92V128" stroke="#64748B" stroke-width="1.6" marker-start="url(#ar)"/>
<path d="M155 202V238" stroke="#64748B" stroke-width="1.6" marker-end="url(#ar)"/>
<path d="M300 202L420 238" stroke="#64748B" stroke-width="1.6" marker-end="url(#ar)"/>
<path d="M290 275H313" stroke="#64748B" stroke-width="1.6" marker-end="url(#ar)"/>
<path d="M585 275H608" stroke="#64748B" stroke-width="1.6" marker-end="url(#ar)"/>
<path d="M745 238V202" stroke="#64748B" stroke-width="1.6" marker-end="url(#ar)"/>
</g></svg>`;
