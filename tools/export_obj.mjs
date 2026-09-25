// Export a house model to OBJ: node tools/export_obj.mjs [--house zielistki34] [--out path.obj]
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import { serve } from './serve.mjs';

const require = createRequire(import.meta.url);
let playwright;
try {
  playwright = require('playwright');
} catch {
  playwright = require(execSync('npm root -g').toString().trim() + '/playwright');
}
const arg = (k, d) => {
  const i = process.argv.indexOf(`--${k}`);
  return i > 0 ? process.argv[i + 1] : d;
};
const house = arg('house', 'zielistki34');
const out = arg('out', `output/${house}.obj`);

const server = await serve(0);
const browser = await playwright.chromium.launch();
const page = await browser.newPage();
page.on('pageerror', (e) => console.error('[page error]', e));
await page.goto(`http://localhost:${server.address().port}/export.html?house=${house}`);
await page.waitForFunction(() => window.objText, null, { timeout: 120000 });
fs.writeFileSync(out, await page.evaluate(() => window.objText));
console.log('wrote', out, fs.statSync(out).size, 'bytes');
await browser.close();
server.close();
