'use strict';
const fs = require('fs');
const path = require('path');

const DEFAULTS = {
  billing: 'auto',              // 'auto' | 'subscription' | 'api'
  advisor: { showInChat: true },
  notifications: {
    desktop: true,
    sound: true,
    onFinish: true,
    finishMinSeconds: 30,       // only notify for finished tasks that ran at least this long
    onFail: true,
    onAttention: true,          // permission prompts, questions, Claude waiting for input
    onToolErrors: 3,            // notify when a task hits this many tool errors (0 = off)
  },
  adminApiKey: '',              // optional sk-ant-admin key: fetches invoiced cost from the Admin API
  retentionDays: 365,
};

function merge(base, over) {
  const out = { ...base };
  for (const [k, v] of Object.entries(over || {})) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object' ? merge(base[k], v) : v;
  }
  return out;
}

class Config {
  constructor(file) { this.file = file; this.value = merge(DEFAULTS, {}); this.load(); }
  load() {
    try { this.value = merge(DEFAULTS, JSON.parse(fs.readFileSync(this.file, 'utf8'))); } catch { /* defaults */ }
    return this.value;
  }
  get() { return this.value; }
  update(patch) {
    const clean = { ...patch };
    delete clean.__proto__;
    this.value = merge(this.value, clean);
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this.value, null, 2));
    return this.value;
  }
  /** Config as sent to the dashboard: never echoes secrets. */
  public() {
    const v = JSON.parse(JSON.stringify(this.value));
    v.adminApiKeySet = !!v.adminApiKey;
    v.adminApiKey = v.adminApiKey ? '••••' + v.adminApiKey.slice(-4) : '';
    return v;
  }
}

module.exports = { Config, DEFAULTS };
