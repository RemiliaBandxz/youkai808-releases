// Site layout audit: stretched/squashed images, sideways scrolling, and elements poking past the screen edge.
// Usage: node tools/site_audit.cjs   (serves ./docs itself; screenshots go to ./audit-out/). Exit code 1 = problems found.
const { chromium } = require('playwright');
const http = require('http'), fs = require('fs'), path = require('path');
const root = path.join(__dirname, '..', 'docs'), out = path.join(__dirname, '..', 'audit-out');
const PAGES = ['/', '/account/', '/h/', '/terms/', '/privacy/', '/refunds/'];
const SIZES = { desktop: { width: 1366, height: 900 }, phone: { width: 390, height: 844 } };
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.webp': 'image/webp', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.mp3': 'audio/mpeg' };
const srv = http.createServer((q, r) => {
  let p = path.join(root, decodeURIComponent(q.url.split('?')[0]));
  if (fs.existsSync(p) && fs.statSync(p).isDirectory()) p = path.join(p, 'index.html');
  if (!fs.existsSync(p)) { r.writeHead(404); return r.end(); }
  r.writeHead(200, { 'Content-Type': TYPES[path.extname(p)] || 'application/octet-stream' }); fs.createReadStream(p).pipe(r);
});
(async () => {
  await new Promise((ok) => srv.listen(0, ok));
  const base = 'http://localhost:' + srv.address().port;
  fs.mkdirSync(out, { recursive: true });
  const b = await chromium.launch(process.env.HTTPS_PROXY ? { proxy: { server: process.env.HTTPS_PROXY, bypass: 'localhost,127.0.0.1' }, args: ['--ignore-certificate-errors'] } : {});
  let bad = 0;
  for (const [size, vp] of Object.entries(SIZES)) for (const pg of PAGES) {
    const page = await b.newPage({ viewport: vp });
    await page.route(/challenges\.cloudflare\.com|workers\.dev|paddle\.com/, (r) => r.abort());
    await page.goto(base + pg, { waitUntil: 'load' }).catch(() => {});
    await page.waitForTimeout(800);
    const issues = await page.evaluate(() => {
      const res = [], W = document.documentElement.clientWidth;
      if (document.documentElement.scrollWidth > W + 1) res.push(`page scrolls sideways (${document.documentElement.scrollWidth}px > ${W}px)`);
      for (const img of document.images) {
        const r = img.getBoundingClientRect(), cs = getComputedStyle(img);
        if (!img.naturalWidth || !r.width || !r.height || cs.display === 'none') continue;
        const fit = cs.objectFit, nat = img.naturalWidth / img.naturalHeight, shown = r.width / r.height;
        if ((fit === 'fill' || fit === '') && Math.abs(shown / nat - 1) > 0.02)
          res.push(`stretched image ${img.getAttribute('src')}: natural ${nat.toFixed(2)} vs shown ${shown.toFixed(2)}`);
        if (r.right > W + 1 && !img.closest('[style*="overflow"], .tbl')) res.push(`image past right edge: ${img.getAttribute('src')}`);
      }
      return res;
    });
    const shot = path.join(out, `${size}${pg.replace(/\//g, '_') || '_'}.png`);
    await page.screenshot({ path: shot, fullPage: true });
    for (const i of issues) { bad++; console.log(`FAIL ${size} ${pg}: ${i}`); }
    await page.close();
  }
  await b.close(); srv.close();
  console.log(bad ? `${bad} problem(s). Screenshots in audit-out/` : 'All clean. Screenshots in audit-out/');
  process.exit(bad ? 1 : 0);
})();
