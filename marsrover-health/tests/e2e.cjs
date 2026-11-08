// Test d'intégration de bout en bout (Playwright + Chromium headless).
// Usage : node tests/e2e.cjs [file|http]   (http : lancer « python3 -m http.server 8765 » à la racine)
const { chromium } = require('playwright');
const fs = require('fs'), path = require('path');
const ROOT = path.resolve(__dirname, '..');
const proto = process.argv[2] || 'file';
const BASE = proto === 'http' ? 'http://localhost:8765/index.html' : 'file://' + ROOT + '/index.html';
const SHOTS = path.join(ROOT, 'tests', 'shots', proto); fs.mkdirSync(SHOTS, { recursive: true });
const report = { proto, base: BASE, date: new Date().toISOString(), steps: [], errors: [] };
const ok = (name, pass, detail = '') => { report.steps.push({ name, pass: !!pass, detail }); console.log(`${pass ? '✔' : '✘'} ${name}${detail ? ' — ' + detail : ''}`); };
(async () => {
  const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const ctx = await b.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
  const p = await ctx.newPage();
  p.on('console', (m) => { if (m.type() === 'error') report.errors.push(m.text()); });
  p.on('pageerror', (e) => report.errors.push('pageerror: ' + e.message));
  const go = async (route, wait = 2500) => { await p.goto(BASE + '#/' + route); await p.waitForTimeout(wait); };
  const shot = (n) => p.screenshot({ path: path.join(SHOTS, n + '.png'), fullPage: false });

  // 0. À la une (page d'ouverture par défaut)
  await p.goto(BASE); await p.waitForTimeout(3000); await shot('00_une');
  const une = await p.evaluate(() => ({ route: document.body.dataset.route, cards: document.querySelectorAll('.une-card img').length, v: document.querySelector('.une-video'), txt: [...document.querySelectorAll('.une-card img')].map((i) => i.alt).join(' ') }));
  const vid = await p.$eval('.une-video', (v) => v.muted && v.loop && v.autoplay);
  ok('À la une : page par défaut, vidéo en boucle sans son', une.route === 'une' && vid);
  ok('À la une : 3 fiches + logo de l\'école', une.cards === 3 && !!(await p.$('.une-school img')) && /BEN SLIMENE/.test(une.txt) && /FARHAT/.test(une.txt) && /BEN HMIDA/.test(une.txt));
  report.errors = report.errors.filter((e) => !/net::ERR_/.test(e));   // vidéo distante : hors ligne possible pendant le test
  // 1. Chargement & datasets
  await go('accueil', 9000);
  const ds = await p.evaluate(() => [...window.MRH.registry.values()].map((d) => [d.id, d.rows.length, d.meta.provenance]));
  ok('Chargement des datasets embarqués', ds.length === 7, ds.map((d) => `${d[0]}:${d[1]}`).join(', '));
  ok('Aucune donnée étiquetée « réel mission »', ds.every((d) => d[2] !== 'mission'));
  // 2. Rover 3D
  const hasCanvas = (await p.$$('.home-wrap canvas')).length === 1; ok('Rover 3D chargé (GLB ou procédural)', hasCanvas);
  const nOverlay = await p.$$eval('.overlay-tl, .overlay-tr, .overlay-bl', (l) => l.length);
  const cardsLR = await p.$$eval('.home-col', (cs) => cs.map((c) => c.querySelectorAll('.comp-card').length));
  ok('Accueil : panneaux retirés, fiches à gauche et à droite', nOverlay === 0 && cardsLR.length === 2 && cardsLR.every((n) => n > 0), `gauche ${cardsLR[0]} · droite ${cardsLR[1]}`);
  const clk = await p.textContent('#clock .ct');
  ok('Barre d\'outils : date et heure', /\d{2}:\d{2}:\d{2}/.test(clk), clk);
  const labels = await p.$$eval('.label3d .lr', (l) => l.length);
  ok('Étiquettes 3D par composant (regroupées par partie)', labels >= 25, `${labels} composants étiquetés`);
  await p.$eval('.label3d [data-id="motor_3"]', (e) => e.click()); await p.waitForTimeout(600);
  const sel = await p.$eval('.home-col .comp-card.sel', (e) => e.textContent).catch(() => '');
  ok('Clic 3D → fiche composant sélectionnée', /Moteur roue 3/.test(sel));
  await p.click('#card-battery .cc-head'); await p.waitForTimeout(400);
  ok('Clic fiche → sélection', await p.$eval('#card-battery', (e) => e.classList.contains('sel')));
  await shot('01_accueil');
  // 3. Navigation toolbar
  const navs = await p.$$eval('#nav a', (a) => a.map((x) => x.getAttribute('href')));
  ok('Barre d\'outils : 10 sous-interfaces (dont Rapport ; MATLAB et Assistant retirés)', navs.length === 10 && !navs.some((x) => /matlab|assistant/.test(x)) && !(await p.$('#sidebar')), navs.join(' '));
  // 4. Tableau de bord
  await go('dashboard', 6000); await shot('02_dashboard');
  ok('Dashboard : 3 sous-interfaces, assistant retiré', (await p.$$('.dash-tabs button')).length === 3 && !/Assistant de correction/.test(await p.textContent('#app')));
  const nc = () => p.$$eval('canvas', (c) => c.length);
  let dash = await p.textContent('#app'), canv = await nc();
  await go('dashboard?vue=2', 5000); dash += await p.textContent('#app'); canv += await nc();
  ok('Dashboard : RUL en pleine largeur (vue 2)', await p.$eval('section[aria-label^="Pronostic — RUL"]', (e) => e.classList.contains('c12')));
  await go('dashboard?vue=3', 4000); dash += await p.textContent('#app'); canv += await nc();
  ok('Dashboard : KM / Weibull', /Kaplan–Meier|Médiane KM/.test(dash));
  ok('Dashboard : « non calculable » affiché', /non calculable avec les données retenues/.test(dash));
  ok('Dashboard : RUL avec unité et IC', /RUL batterie[\s\S]*cycles[\s\S]*IC 90/.test(dash));
  ok('Dashboard : interprétation intelligente', /Interprétation intelligente/.test(dash));
  ok('Dashboard : graphiques rendus (3 vues)', canv >= 6, `${canv} canvas`);
  // 5. Maintenance (non paramétrique + paramétrique)
  await go('maintenance?c=wheel_3', 4000); await shot('03_maintenance_subst');
  let t = await p.textContent('#app');
  ok('Maintenance non paramétrique : plan « estimé par substitution »', /estimé par substitution/i.test(t) && /Nouveau plan de maintenance/.test(t) && /sensibilité/.test(t));
  const [dl] = await Promise.all([p.waitForEvent('download'), p.click('text=Dataset dérivé (CSV)')]);
  ok('Export du dataset dérivé', /dataset_derive_wheel_3\.csv/.test(dl.suggestedFilename()));
  await go('maintenance?c=battery', 4000); await shot('04_maintenance_param');
  t = await p.textContent('#app'); ok('Maintenance paramétrique (batterie, RUL)', /paramétrique/.test(t) && /Pronostic batterie/.test(t));
  // 6. Catalogue
  await go('catalogue', 9000); await shot('05_catalogue');
  t = await p.textContent('#app');
  ok('Catalogue : nominal / actuel / écart', /Nominal/.test(t) && /Actuel/.test(t) && /Restant/.test(t) && /Vie consommée/.test(t));
  const thumbs = await p.$$eval('.card img', (i) => i.filter((x) => x.src.startsWith('data:image')).length);
  ok('Catalogue : vignettes 3D', thumbs >= 15, `${thumbs} vignettes`);
  // 7. Perturbations
  await go('perturbations?c=motor_3', 6000); await shot('06_perturbation');
  t = await p.textContent('#app');
  ok('Perturbation : avant/après + détection', /Avant \/ après/.test(t) && /Détection/.test(t));
  ok('Perturbation : propagation 3D + cascade', (await p.$$('.mini3d canvas')).length === 1 && /Effets en cascade/.test(t));
  await p.click('text=Sauvegarder le scénario'); await p.waitForTimeout(1500);
  ok('Perturbation : scénario sauvegardé', /Scénarios sauvegardés \(1\)|Scénarios sauvegardés \([1-9]/.test(await p.textContent('#app')));
  // 8. Terrain
  await go('terrain', 7000);
  await p.click('button:has-text("Lecture")'); await p.waitForTimeout(4000); await shot('07_terrain');
  const pos = await p.$eval('.terrain-wrap ~ .row input[type=range], .panel input[aria-label="Position dans la simulation"]', (e) => +e.value);
  ok('Terrain : lecture synchronisée', pos > 0, `pas ${pos}`);
  await p.click('text=Appliquer l\'impact aux composants'); await p.waitForTimeout(800);
  await go('dashboard', 5000);
  const imp = await p.evaluate(() => window.MRH.state.terrainImpact && window.MRH.state.terrainImpact.applied);
  ok('Terrain → impact appliqué aux composants / tableau de bord', imp);
  // 9. Données : import
  await go('donnees?tab=import', 2000);
  const csv = path.join(ROOT, 'tests', 'fixture_import.csv');
  fs.writeFileSync(csv, 'unit,t_h,status\nA,120,1\nB,340,1\nC,500,0\nD,610,1\nE,800,0\n');
  await p.setInputFiles('input[aria-label="Fichier à importer"]', csv); await p.waitForTimeout(800);
  await p.click('button.btn.primary:has-text("Importer")'); await p.waitForTimeout(600);
  const refused = await p.textContent('#toast');
  ok('Import refusé sans provenance déclarée', /provenance/i.test(refused));
  const selects = await p.$$('select.inp');
  await p.selectOption('select[required]', 'experimental');
  await p.selectOption('select[data-k="time"]', 't_h'); await p.selectOption('select[data-k="event"]', 'status'); await p.selectOption('select[data-k="id"]', 'unit');
  await p.click('button.btn.primary:has-text("Importer")'); await p.waitForTimeout(1500);
  const n2 = await p.evaluate(() => window.MRH.registry.size);
  ok('Import avec mapping + provenance', n2 === 8, `${n2} datasets`); await shot('08_donnees');
  // 10 bis. Rapport technique (graphiques, images du système, décisions, PDF)
  await go('rapport', 4500); t = await p.textContent('#app');
  const rp = await p.evaluate(() => ({ ready: document.body.dataset.reportReady, canv: document.querySelectorAll('.rp-doc canvas').length, imgs: document.querySelectorAll('.rp-doc img').length, pdf: document.querySelector('.rp-actions a[download]')?.getAttribute('href') }));
  ok('Rapport : graphiques, images, méthode de comparaison et décisions', rp.ready === '1' && rp.canv >= 6 && rp.imgs >= 6 && /Méthode de comparaison des outils de détection/.test(t) && /Décisions de correction/.test(t), `${rp.canv} graphiques · ${rp.imgs} images`);
  ok('Rapport : PDF téléchargeable avec logos', !!rp.pdf && fs.existsSync(path.join(ROOT, rp.pdf)) && fs.statSync(path.join(ROOT, rp.pdf)).size > 200000);
  await shot('13_rapport');
  // 11 bis. Intelligence artificielle & maintenance prédictive (résultats du backend)
  await go('ia?tab=anomalies', 3500); t = await p.textContent('#app');
  const src = await p.evaluate(() => document.body.dataset.mlSource);
  ok('IA : source des résultats (API en http, instantané en file)', proto === 'http' ? src === 'api' : src === 'snapshot', src);
  ok('IA : anomalies (F1, AUC, historique)', /AUC-ROC/.test(t) && /Historique des anomalies/.test(t) && (await p.$$('.ia-body canvas')).length >= 3);
  await go('ia?tab=diagnostic', 2500); t = await p.textContent('#app');
  ok('IA : diagnostic + 5 classes de défaut (maintenance préventive)', /Matrice de confusion/.test(t) && /5 classes de défaut/.test(t) && /Surpression/.test(t) && /Surcharge moteur/.test(t));
  await go('ia?tab=fiabilite', 2500); t = await p.textContent('#app');
  ok('IA : Weibull + RSF (C-index, Brier)', /β \(forme\)/.test(t) && /C-index/.test(t) && /Brier intégré/.test(t));
  await go('ia?tab=rul&equipment=CMAPSS-FD001-TE-076', 2500); t = await p.textContent('#app');
  ok('IA : RUL XGBoost vs LSTM avec unité', /RMSE/.test(t) && /LSTM/.test(t) && /cycles/.test(t));
  await go('ia?tab=maintenabilite', 2000); t = await p.textContent('#app');
  ok('IA : MTTR prévisionnel non inventé (sans note)', /En attente de données/.test(t) && !/Aucune prédiction produite/.test(t));
  await go('ia?tab=securite', 2500); t = await p.textContent('#app');
  ok('IA : AMDEC / FTA / coupes minimales (sans avertissement)', /NPR/.test(t) && /Coupes minimales/.test(t) && !/Avertissement/.test(t));
  await go('ia?tab=comparaison', 2000); t = await p.textContent('#app');
  ok('IA : comparaison des algorithmes', (await p.$$('.ia-best')).length >= 5);
  await go('ia?tab=references&part=femto', 3000); t = await p.textContent('#app');
  ok('IA : FEMTO (Weibull 17 roulements, RUL, détection)', /17/.test(t) && /Weibull MRL/.test(t) && /Avance de détection/.test(t));
  await go('ia?tab=references&part=hirf', 3000); t = await p.textContent('#app');
  ok('IA : HIRF (53 essais, résistance interne, BHM)', /53/.test(t) && /Résistance interne/.test(t) && /BHM/.test(t));
  await go('ia?tab=recommandations', 2000);
  ok('IA : recommandations traçables', (await p.$$('.ia-reco-card')).length > 10); await shot('12_ia_recommandations');
  // 12. Accessibilité / responsive (mobile)
  await p.setViewportSize({ width: 390, height: 844 }); await go('dashboard', 4000);
  const hs = await p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
  ok('Responsive : pas de défilement horizontal (390 px)', hs); await shot('11_mobile_dashboard');
  // 13. fps (rendu logiciel SwiftShader : non représentatif d'un GPU)
  await p.setViewportSize({ width: 1440, height: 900 }); await go('accueil', 8000);
  const fps = await p.$eval('.fps', (e) => e.textContent);
  ok('Mesure fps (indicative, rendu logiciel)', true, fps);
  report.errors = [...new Set(report.errors)].filter((e) => !/GPU stall|WebGL.*Performance/.test(e));
  ok('Console sans erreur', report.errors.length === 0, report.errors.slice(0, 5).join(' | '));
  fs.writeFileSync(path.join(ROOT, 'tests', `e2e_report_${proto}.json`), JSON.stringify(report, null, 1));
  console.log(`\n${report.steps.filter((s) => s.pass).length}/${report.steps.length} vérifications réussies (${proto}).`);
  await b.close();
})().catch((e) => { console.error(e); process.exit(1); });
