#!/usr/bin/env node
'use strict';
// Claude Code statusLine command. Prints one line: model, task state, elapsed and predicted
// remaining time, Claude Code's own session cost. Falls back to a local line if the backend is down.
const http = require('http');
const PORT = Number(process.env.CCC_PORT || 47821);

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', d => { raw += d; });
process.stdin.on('end', () => {
  let p = {};
  try { p = JSON.parse(raw || '{}'); } catch { /* ignore */ }
  const fallback = () => {
    const model = (p.model && p.model.display_name) || '';
    const cost = p.cost && p.cost.total_cost_usd != null ? ` │ $${Number(p.cost.total_cost_usd).toFixed(2)} (Claude Code)` : '';
    process.stdout.write(`\x1b[38;5;141m◆ CCC\x1b[0m ${model}${cost} \x1b[2m│ dashboard offline\x1b[0m`);
    process.exit(0);
  };
  const data = Buffer.from(JSON.stringify(p));
  const req = http.request({ host: '127.0.0.1', port: PORT, path: '/api/statusline', method: 'POST', timeout: 400,
    headers: { 'content-type': 'application/json', 'content-length': data.length, 'x-ccc': '1' } }, res => {
    let out = '';
    res.on('data', d => { out += d; });
    res.on('end', () => {
      try { process.stdout.write(JSON.parse(out).line || ''); process.exit(0); } catch { fallback(); }
    });
  });
  req.on('timeout', () => req.destroy());
  req.on('error', fallback);
  req.end(data);
});
