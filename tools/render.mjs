// Render a 360 orbit around the house to an MP4.
//   node tools/render.mjs [--seconds 16] [--fps 60] [--w 1920] [--h 1080] [--out output/house_360.mp4] [--stills]
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import { serve } from './serve.mjs';

const require = createRequire(import.meta.url);
let playwright;
try {
  playwright = require('playwright');
} catch {
  playwright = require(require('node:child_process').execSync('npm root -g').toString().trim() + '/playwright');
}

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => {
    if (a.startsWith('--')) acc.push([a.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : true]);
    return acc;
  }, [])
);
const seconds = +(args.seconds || 16);
const fps = +(args.fps || 60);
const W = +(args.w || 1920);
const H = +(args.h || 1080);
const out = args.out || 'output/house_360.mp4';
const ffmpeg = process.env.FFMPEG || 'ffmpeg';

const server = await serve(0);
const port = server.address().port;
const browser = await playwright.chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: W, height: H } });
page.on('console', (m) => console.log('[page]', m.text()));
page.on('pageerror', (e) => console.error('[page error]', e));
await page.goto(`http://localhost:${port}/render.html?w=${W}&h=${H}`);
await page.waitForFunction(() => window.sceneReady === true, null, { timeout: 60000 });

const grab = async (angle) => {
  const url = await page.evaluate((a) => window.grab(a), angle);
  return Buffer.from(url.split(',')[1], 'base64');
};

if (args.stills) {
  fs.mkdirSync('output/stills', { recursive: true });
  for (let k = 0; k < 8; k++) fs.writeFileSync(`output/stills/view_${k * 45}.jpg`, await grab((k * Math.PI) / 4));
  console.log('wrote output/stills');
} else {
  const frames = Math.round(seconds * fps);
  const ff = spawn(ffmpeg, ['-y', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', String(fps), '-c:v', 'mjpeg', '-i', '-',
    '-c:v', 'libx264', '-preset', 'slow', '-crf', '18', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', out], { stdio: ['pipe', 'inherit', 'inherit'] });
  const t0 = Date.now();
  for (let i = 0; i < frames; i++) {
    // ease in/out over the loop would stall the motion; keep constant speed so it loops seamlessly
    const buf = await grab((i / frames) * Math.PI * 2);
    if (!ff.stdin.write(buf)) await new Promise((r) => ff.stdin.once('drain', r));
    if (i % 60 === 0) console.log(`frame ${i}/${frames}  ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  }
  ff.stdin.end();
  await new Promise((r) => ff.on('close', r));
  console.log('wrote', out);
}
await browser.close();
server.close();
