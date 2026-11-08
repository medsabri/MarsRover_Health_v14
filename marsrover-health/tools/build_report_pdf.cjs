// Génère docs/Rapport_MarsRover_Health.pdf à partir de l'interface « Rapport » (Playwright / Chromium).
// Usage : node tools/build_report_pdf.cjs   (après ./tools/build.sh)
const { chromium } = require('playwright');
const fs = require('fs'), path = require('path');
const ROOT = path.resolve(__dirname, '..');
const b64 = (f) => fs.readFileSync(path.join(ROOT, f)).toString('base64');
(async () => {
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 1100, height: 1400 } });
  await p.goto('file://' + ROOT + '/index.html#/rapport?print=1');
  await p.waitForFunction(() => document.body.dataset.reportReady === '1', null, { timeout: 60000 });
  await p.waitForTimeout(2500);
  await p.emulateMedia({ media: 'print' });
  await p.waitForTimeout(1500);
  const logoApp = `data:image/png;base64,${b64('assets/img/logo.png')}`, logoSchool = `data:image/png;base64,${b64('assets/img/polytechnique-sousse.png')}`;
  const out = path.join(ROOT, 'docs', 'Rapport_MarsRover_Health.pdf');
  await p.pdf({
    path: out, format: 'A4', printBackground: true, displayHeaderFooter: true, preferCSSPageSize: true,
    headerTemplate: `<div style="width:100%;padding:0 14mm;display:flex;align-items:center;justify-content:space-between;font:8px Helvetica,Arial,sans-serif;color:#64748B">
      <span style="display:flex;align-items:center;gap:6px"><img src="${logoApp}" style="height:16px;border-radius:50%"> MarsRover Health — Rapport technique</span>
      <img src="${logoSchool}" style="height:18px"></div>`,
    footerTemplate: `<div style="width:100%;padding:0 14mm;display:flex;justify-content:space-between;font:8px Helvetica,Arial,sans-serif;color:#64748B">
      <span>Projet Pratique — École Polytechnique de Sousse</span><span>Page <span class="pageNumber"></span> / <span class="totalPages"></span></span></div>`,
  });
  await b.close();
  console.log('PDF : ' + out + ' (' + Math.round(fs.statSync(out).size / 1024) + ' Ko)');
})();
