'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { tmpdir, ROOT } = require('./helpers');

function ccc(dir, ...args) {
  return execFileSync(process.execPath, [path.join(ROOT, 'cli', 'ccc.js'), ...args], {
    env: { ...process.env, CLAUDE_CONFIG_DIR: dir, CCC_HOME: path.join(dir, 'ccc'), CCC_PORT: '1' }, encoding: 'utf8',
  });
}
const settings = dir => JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'));

test('cli: hooks install keeps your own hooks, is idempotent, uninstall removes only ours, backups are kept', () => {
  const dir = tmpdir('ccc-claude');
  const mine = { hooks: { Stop: [{ matcher: '', hooks: [{ type: 'command', command: 'echo mine' }] }] }, model: 'opus' };
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify(mine));
  ccc(dir, 'hooks', 'install');
  ccc(dir, 'hooks', 'install');
  let s = settings(dir);
  assert.equal(s.model, 'opus');
  const stopCmds = s.hooks.Stop.flatMap(g => g.hooks.map(h => h.command));
  assert.equal(stopCmds.filter(c => c === 'echo mine').length, 1);
  assert.equal(stopCmds.filter(c => /ccc-hook\.js" Stop$/.test(c)).length, 1, 'installed once');
  assert.equal(s.hooks.PreToolUse[0].hooks[0].async, true, 'tool hooks run async');
  assert.equal(s.hooks.UserPromptSubmit[0].hooks[0].async, undefined, 'prompt hook is synchronous');
  ccc(dir, 'hooks', 'uninstall');
  s = settings(dir);
  assert.deepEqual(s.hooks, mine.hooks);
  assert.ok(fs.readdirSync(dir).some(f => f.startsWith('settings.json.bak-ccc-')));
});

test('cli: statusline never overwrites an existing status line without --force', () => {
  const dir = tmpdir('ccc-claude');
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ statusLine: { type: 'command', command: 'my-line' } }));
  const out = ccc(dir, 'statusline', 'install');
  assert.match(out, /Left unchanged/);
  assert.equal(settings(dir).statusLine.command, 'my-line');
  ccc(dir, 'statusline', 'install', '--force');
  assert.match(settings(dir).statusLine.command, /ccc-statusline\.js/);
  ccc(dir, 'statusline', 'uninstall');
  assert.equal(settings(dir).statusLine, undefined);
});

test('plugin hooks.json covers every event the CLI installs, with the same async policy', () => {
  const { HOOK_EVENTS } = require('../cli/ccc.js');
  const plugin = JSON.parse(fs.readFileSync(path.join(ROOT, 'hooks', 'hooks.json'), 'utf8')).hooks;
  assert.deepEqual(Object.keys(plugin).sort(), Object.keys(HOOK_EVENTS).sort());
  for (const [ev, isAsync] of Object.entries(HOOK_EVENTS)) {
    const h = plugin[ev][0].hooks[0];
    assert.equal(!!h.async, isAsync, ev);
    assert.match(h.command, /\$\{CLAUDE_PLUGIN_ROOT\}\/cli\/ccc-hook\.js" /);
  }
});
