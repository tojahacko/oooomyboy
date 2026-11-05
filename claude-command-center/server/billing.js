'use strict';
// Which kind of money are we looking at?
//  * subscription (Pro/Max/Team via claude.ai login): you are not billed per token. Token
//    costs are a SUBSCRIPTION-EQUIVALENT value: what the same usage would cost on the API.
//  * api (Console API key / cloud provider): token costs are an ESTIMATE of real spend at
//    list prices. The invoiced amount is only known from the Admin API cost report.
const fs = require('fs');
const https = require('https');

function detectBilling({ claudeJsonPath, env = process.env, configured = 'auto' }) {
  if (configured === 'subscription' || configured === 'api') return { mode: configured, source: 'settings' };
  if (env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN) return { mode: 'api', source: 'ANTHROPIC_API_KEY is set' };
  if (env.CLAUDE_CODE_USE_BEDROCK || env.CLAUDE_CODE_USE_VERTEX || env.CLAUDE_CODE_USE_FOUNDRY) return { mode: 'api', source: 'cloud provider env' };
  try {
    const j = JSON.parse(fs.readFileSync(claudeJsonPath, 'utf8'));
    if (j.oauthAccount && (j.oauthAccount.emailAddress || j.oauthAccount.accountUuid)) {
      return { mode: 'subscription', source: 'claude.ai login found in ~/.claude.json', plan: j.oauthAccount.billingType || null };
    }
    if (j.primaryApiKey || j.customApiKeyResponses) return { mode: 'api', source: 'API key login in ~/.claude.json' };
  } catch { /* not readable */ }
  return { mode: 'unknown', source: 'could not tell; set it in Settings' };
}

/**
 * Invoiced cost from the Admin API (raw HTTP; not in the SDKs).
 * GET /v1/organizations/cost_report  -> amounts are decimal strings in cents (USD).
 */
function fetchCostReport(adminKey, { days = 30, now = Date.now() } = {}) {
  const start = new Date(now - days * 86400000);
  start.setUTCHours(0, 0, 0, 0);
  const qs = new URLSearchParams({ starting_at: start.toISOString(), bucket_width: '1d', limit: '31' });
  qs.append('group_by[]', 'description');
  return new Promise((resolve, reject) => {
    const req = https.request({
      host: 'api.anthropic.com', path: '/v1/organizations/cost_report?' + qs, method: 'GET',
      headers: { 'x-api-key': adminKey, 'anthropic-version': '2023-06-01' }, timeout: 15000,
    }, res => {
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error(`Admin API ${res.statusCode}: ${body.slice(0, 200)}`));
        try { resolve(summarizeCostReport(JSON.parse(body))); } catch (e) { reject(e); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('Admin API timeout')));
    req.on('error', reject);
    req.end();
  });
}

function summarizeCostReport(report) {
  const days = [];
  const byModel = {};
  let totalUsd = 0;
  for (const b of report.data || []) {
    let dayUsd = 0;
    for (const r of b.results || []) {
      const usd = Number(r.amount) / 100;
      if (!isFinite(usd)) continue;
      dayUsd += usd;
      const k = r.model || r.description || 'other';
      byModel[k] = (byModel[k] || 0) + usd;
    }
    totalUsd += dayUsd;
    days.push({ date: (b.starting_at || '').slice(0, 10), usd: dayUsd });
  }
  return { totalUsd, days, byModel, fetchedAt: Date.now(), source: 'Anthropic Admin API cost_report (invoiced)' };
}

module.exports = { detectBilling, fetchCostReport, summarizeCostReport };
