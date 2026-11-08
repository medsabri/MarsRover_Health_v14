// Captures de toutes les vues (bureau, tablette, mobile) pour revue visuelle.
const { chromium } = require('playwright'); const path = require('path');
(async () => { const b = await chromium.launch({ args: ['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader'] });
 const out = path.join(__dirname, 'shots', 'design'); require('fs').mkdirSync(out, { recursive: true }); const errs = [];
 for (const [w, hh, tag] of [[1440, 900, 'desktop'], [820, 1180, 'tablet'], [390, 844, 'mobile']]) {
  const p = await b.newPage({ viewport: { width: w, height: hh } }); p.on('pageerror', (e) => errs.push(e.message));
  for (const r of ['accueil', 'dashboard', 'maintenance', 'catalogue', 'perturbations', 'terrain', 'donnees', 'matlab', 'assistant']) {
   await p.goto('file://' + path.resolve(__dirname, '..') + '/index.html#/' + r); await p.waitForTimeout(r === 'accueil' || r === 'catalogue' ? 6000 : 3000);
   const ov = await p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
   if (ov > 1) errs.push(`${tag}/${r}: débordement horizontal ${ov}px`);
   await p.screenshot({ path: path.join(out, `${tag}_${r}.png`) });
  } await p.close(); }
 console.log(JSON.stringify(errs)); await b.close(); })();
