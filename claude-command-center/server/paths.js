'use strict';
// Every location the Command Center reads or writes, in one place.
// All of them can be overridden by environment variables (tests use this).
const os = require('os');
const path = require('path');

const CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');

module.exports = {
  HOME: process.env.CCC_HOME || path.join(os.homedir(), '.claude-command-center'),
  CLAUDE_DIR,
  PROJECTS_DIR: process.env.CCC_PROJECTS_DIR || path.join(CLAUDE_DIR, 'projects'),
  CLAUDE_JSON: process.env.CCC_CLAUDE_JSON || path.join(os.homedir(), '.claude.json'),
  PORT: Number(process.env.CCC_PORT || 47821),
  HOST: '127.0.0.1',
  APP_ROOT: path.resolve(__dirname, '..'),
};
