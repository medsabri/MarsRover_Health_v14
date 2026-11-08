// Usage : node tests/shot.cjs <route> [wait_ms] [w] [h] [proto: file|http]
const { chromium } = require('playwright');
(async () => {
  const [route = 'accueil', wait = '6000', W = '1440', H = '900', proto = 'file'] = process.argv.slice(2);
  const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const p = await b.newPage({ viewport: { width: +W, height: +H }, deviceScaleFactor: 1 });
  const errs = [];
  p.on('console', (m) => { if (['error', 'warning'].includes(m.type())) errs.push(m.type() + ': ' + m.text()); });
  p.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
  const base = proto === 'http' ? 'http://localhost:8765/index.html' : 'file:///home/claude/marsrover-health/index.html';
  await p.goto(base + '#/' + route);
  await p.waitForTimeout(+wait);
  await p.screenshot({ path: `/home/claude/marsrover-health/tests/shots/${route.replace(/[^a-z0-9]/gi, '_')}.png` });
  const fps = await p.evaluate(() => (document.querySelector('.fps') || {}).textContent);
  console.log(JSON.stringify({ route, fps, errs: errs.slice(0, 15) }, null, 1));
  await b.close();
})();
