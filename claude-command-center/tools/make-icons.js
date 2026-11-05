// Renders dashboard/icon.svg to icon-256.png and a multi-size Windows icon.ico (PNG-in-ICO).
// Needs playwright (dev only); the generated files are committed.
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
(async () => {
  const dir = path.join(__dirname, '..', 'dashboard');
  const svg = fs.readFileSync(path.join(dir, 'icon.svg'), 'utf8');
  const b = await chromium.launch();
  const sizes = [16, 24, 32, 48, 64, 128, 256];
  const pngs = [];
  for (const s of sizes) {
    const p = await b.newPage({ viewport: { width: s, height: s } });
    await p.setContent(`<html><body style="margin:0;background:transparent">${svg.replace('<svg ', `<svg width="${s}" height="${s}" `)}</body></html>`);
    pngs.push(await p.screenshot({ omitBackground: true, clip: { x: 0, y: 0, width: s, height: s } }));
  }
  await b.close();
  fs.writeFileSync(path.join(dir, 'icon-256.png'), pngs[pngs.length - 1]);
  const head = Buffer.alloc(6); head.writeUInt16LE(0, 0); head.writeUInt16LE(1, 2); head.writeUInt16LE(sizes.length, 4);
  let offset = 6 + 16 * sizes.length;
  const entries = sizes.map((s, i) => {
    const e = Buffer.alloc(16);
    e.writeUInt8(s >= 256 ? 0 : s, 0); e.writeUInt8(s >= 256 ? 0 : s, 1); e.writeUInt16LE(1, 4); e.writeUInt16LE(32, 6);
    e.writeUInt32LE(pngs[i].length, 8); e.writeUInt32LE(offset, 12); offset += pngs[i].length;
    return e;
  });
  fs.writeFileSync(path.join(dir, 'icon.ico'), Buffer.concat([head, ...entries, ...pngs]));
  console.log('icons written');
})();
