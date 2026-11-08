// Captures de la section IA (bureau / mobile) + erreurs console. Usage : node tests/shots_ia.cjs [file|http]
const { chromium } = require('playwright'); const path = require('path'); const fs = require('fs');
const proto = process.argv[2] || 'file';
const BASE = proto === 'http' ? 'http://127.0.0.1:8765/index.html' : 'file://' + path.resolve(__dirname, '..') + '/index.html';
const TABS = ['anomalies', 'diagnostic', 'fiabilite', 'rul', 'maintenabilite', 'disponibilite', 'securite', 'comparaison', 'modeles', 'recommandations', 'audit'];
(async () => {
  const b = await chromium.launch(); const out = path.join(__dirname, 'shots', 'ia'); fs.mkdirSync(out, { recursive: true }); const errs = [];
  for (const [w, hh, tag] of [[1440, 900, 'desktop'], [1024, 768, 'tablet'], [820, 1180, 'tablet2'], [390, 844, 'mobile']]) {
    const p = await b.newPage({ viewport: { width: w, height: hh } });
    p.on('pageerror', (e) => errs.push(`${tag}: ${e.message}`)); p.on('console', (m) => { if (m.type() === 'error') errs.push(`${tag}: ${m.text()}`); });
    for (const t of TABS) {
      await p.goto(`${BASE}#/ia?tab=${t}`); await p.waitForTimeout(1800);
      const ov = await p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth); if (ov > 1) errs.push(`${tag}/${t}: débordement ${ov}px`);
      const err = await p.$('.ia-callout.warn strong'); if (err && /indisponibles/.test(await err.textContent())) errs.push(`${tag}/${t}: résultats indisponibles`);
      await p.screenshot({ path: path.join(out, `${tag}_${t}.png`), fullPage: tag === 'desktop' });
    }
    await p.close();
  }
  console.log(JSON.stringify(errs, null, 1)); await b.close();
})();
