#!/usr/bin/env node
/**
 * Preflight checks — run before any SDK install attempt.
 * Detects problems early and tells the user exactly how to fix them.
 */
import { execSync } from 'child_process';
import { existsSync } from 'fs';
import { platform } from 'os';

const PASS = '✅';
const FAIL = '❌';
const WARN = '⚠️ ';

let allOk = true;

function check(label, fn) {
  try {
    const msg = fn();
    process.stderr.write(`${PASS} ${label}${msg ? ': ' + msg : ''}\n`);
  } catch (e) {
    process.stderr.write(`${FAIL} ${label}: ${e.message}\n`);
    allOk = false;
  }
}

function warn(label, fn) {
  try { fn(); }
  catch (e) { process.stderr.write(`${WARN} ${label}: ${e.message}\n`); }
}

// 1. Platform
check('Platform', () => {
  const p = platform();
  if (p === 'win32') throw new Error('Windows is not supported. Use macOS or Linux.');
  return p;
});

// 2. Node version
check('Node.js version', () => {
  const v = parseInt(process.version.slice(1).split('.')[0]);
  if (v < 18) throw new Error(`Node ${process.version} found, but Node 18+ is required. Install from https://nodejs.org`);
  return process.version;
});

// 3. unzip (needed for SDK extraction)
check('unzip', () => {
  execSync('which unzip', { stdio: 'pipe' });
  return 'found';
});

// 4. Java (needed for sdkmanager + avdmanager)
warn('Java (optional, needed to boot new emulator)', () => {
  execSync('which java', { stdio: 'pipe' });
  const v = execSync('java -version 2>&1', { encoding: 'utf8', stdio: ['pipe','pipe','pipe'] });
});

// 5. Internet (quick ping to Google's SDK host)
warn('Internet connectivity', () => {
  execSync('curl -sf --max-time 5 https://dl.google.com > /dev/null 2>&1', { stdio: 'pipe' });
});

if (!allOk) {
  process.stderr.write('\n[dev-emulator] Fix the issues above before running dev-emulator.\n\n');
  process.exit(1);
}

export { allOk };
