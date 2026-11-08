// Vérifie le modèle procédural de secours (GLB bloqué).
const { chromium } = require('playwright');
(async () => { const b = await chromium.launch({ args: ['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader'] });
 const p = await b.newPage({ viewport: { width: 1280, height: 800 } }); const errs = [];
 p.on('pageerror', (e) => errs.push(e.message));
 await p.route('**/*.glb', (r) => r.abort());
 await p.goto('http://localhost:8765/index.html#/accueil'); await p.waitForTimeout(6000);
 const t = await p.textContent('.overlay-bl'); const n = await p.$$eval('.label3d', (l) => l.length);
 await p.screenshot({ path: 'tests/shots/fallback_procedural.png' });
 console.log(JSON.stringify({ procedural: /procédural/.test(t), labels: n, errs })); await b.close(); })();
