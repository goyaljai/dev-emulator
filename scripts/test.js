#!/usr/bin/env node
/**
 * dev-emulator test suite
 * Requires a running ADB device (emulator or physical).
 *
 * Usage:
 *   node scripts/test.js
 */
import { execFileSync } from 'child_process';
import { existsSync } from 'fs';
import { homedir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HOME = homedir();

let passed = 0;
let failed = 0;

function assert(label, value, expected) {
  const ok = expected !== undefined ? value === expected : !!value;
  if (ok) {
    process.stdout.write(`  ✅ ${label}\n`);
    passed++;
  } else {
    process.stdout.write(`  ❌ ${label} — got: ${JSON.stringify(value)}\n`);
    failed++;
  }
}

function section(name) {
  process.stdout.write(`\n── ${name} ─────────────────────────────────────────\n`);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function adb(...args) {
  const sdkRoot = (() => {
    const candidates = [
      join(HOME, 'Library', 'Android', 'sdk'),
      join(HOME, 'Android', 'Sdk'),
      process.env.ANDROID_HOME,
      process.env.ANDROID_SDK_ROOT,
    ].filter(Boolean);
    for (const c of candidates) {
      const adbPath = join(c, 'platform-tools', 'adb');
      if (existsSync(adbPath)) return adbPath;
    }
    return 'adb'; // system adb fallback
  })();
  return execFileSync(sdkRoot, args, { encoding: 'utf8' }).trim();
}

function getConnectedDevice() {
  const lines = adb('devices').split('\n').slice(1);
  for (const l of lines) {
    const parts = l.trim().split(/\s+/);
    if (parts[1] === 'device') return parts[0];
  }
  return null;
}

// ── Run tests via dev-emulator script interface ───────────────────────────────

async function runScript(script) {
  return new Promise((resolve, reject) => {
    const child = require('child_process').spawn(
      'node',
      [join(__dirname, '..', 'bin', 'dev-emulator.js')],
      { stdio: ['pipe', 'pipe', 'pipe'] }
    );
    let stdout = '';
    child.stdout.on('data', d => stdout += d);
    child.stdin.write(script);
    child.stdin.end();
    child.on('close', code => {
      if (code !== 0) reject(new Error(`Script exited ${code}`));
      else resolve(stdout.trim());
    });
  });
}

// ── Test runner ───────────────────────────────────────────────────────────────

section('Environment');
const serial = getConnectedDevice();
assert('ADB device connected', !!serial);
if (!serial) {
  process.stdout.write('\nNo device connected — cannot run device tests.\n');
  process.exit(1);
}
process.stdout.write(`  device: ${serial}\n`);

// Import and run tests using the binary directly via Node
import { spawn } from 'child_process';
import { createInterface } from 'readline';

async function test(label, scriptBody) {
  return new Promise((resolve) => {
    const child = spawn('node', [join(__dirname, '..', 'bin', 'dev-emulator.js')], {
      stdio: ['pipe', 'pipe', 'pipe']
    });
    let out = '';
    let err = '';
    child.stdout.on('data', d => out += d);
    child.stderr.on('data', d => err += d);
    child.stdin.write(scriptBody);
    child.stdin.end();
    child.on('close', code => {
      if (code !== 0) {
        process.stdout.write(`  ❌ ${label} — exit ${code}: ${err.slice(-200)}\n`);
        failed++;
      } else {
        try {
          const result = JSON.parse(out.trim().split('\n').pop());
          resolve(result);
          return;
        } catch {
          process.stdout.write(`  ❌ ${label} — bad JSON: ${out.slice(-100)}\n`);
          failed++;
        }
      }
      resolve(null);
    });
  });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

section('device.get() — fast path');
const r1 = await test('uses existing device', `
  const d = await device.get();
  console.log(JSON.stringify({ serial: d.serial }));
`);
assert('serial returned', r1?.serial?.length > 0);

section('size()');
const r2 = await test('returns w and h', `
  const d = await device.get();
  const sz = await d.size();
  console.log(JSON.stringify(sz));
`);
assert('w > 0', (r2?.w || 0) > 0);
assert('h > 0', (r2?.h || 0) > 0);

section('screenshot()');
const r3 = await test('returns local path', `
  const d = await device.get();
  const p = await d.screenshot("test_shot.png");
  console.log(JSON.stringify({ path: p }));
`);
assert('path returned', typeof r3?.path === 'string');
assert('path ends with .png', r3?.path?.endsWith('.png'));
assert('file exists', r3?.path ? existsSync(r3.path) : false);

section('shell()');
const r4 = await test('runs adb shell command', `
  const d = await device.get();
  const out = await d.shell('echo', 'hello');
  console.log(JSON.stringify({ out }));
`);
assert('shell output correct', r4?.out, 'hello');

section('isInstalled()');
const r5 = await test('detects installed package', `
  const d = await device.get();
  const yes = await d.isInstalled('com.google.android.deskclock');
  const no  = await d.isInstalled('com.fake.nothere.ever');
  console.log(JSON.stringify({ yes, no }));
`);
assert('installed package detected', r5?.yes, true);
assert('missing package not detected', r5?.no, false);

section('clearLogcat() + logcat()');
const r6 = await test('logcat with lines option', `
  const d = await device.get();
  await d.clearLogcat();
  await d.sleep(500);
  const logs = await d.logcat('', { lines: 20 });
  console.log(JSON.stringify({ count: logs.split('\\n').filter(l => l.trim()).length }));
`);
// logcat -t N returns approximately N lines but may vary by a few
assert('lines respected (≤25)', (r6?.count || 0) <= 25);

section('isCrashed()');
const r7 = await test('no crash when nothing running', `
  const d = await device.get();
  await d.clearLogcat();
  const result = await d.isCrashed('com.fake.nothere.ever');
  console.log(JSON.stringify(result));
`);
assert('crashed=false when no crash', r7?.crashed, false);

section('getUI()');
const r8 = await test('returns element array', `
  const d = await device.get();
  await d.home();
  await d.sleep(1000);
  const ui = await d.getUI();
  const hasElements = Array.isArray(ui) && ui.length > 0;
  const hasBounds = ui[0] && typeof ui[0].bounds?.cx === 'number';
  console.log(JSON.stringify({ count: ui.length, hasBounds }));
`);
assert('returns array with elements', (r8?.count || 0) > 0);
assert('elements have bounds.cx', r8?.hasBounds, true);

section('findAndTap() + waitForElement()');
const r9 = await test('launches Clock, finds Stopwatch tab', `
  const d = await device.get();
  await d.shell('am', 'force-stop', 'com.google.android.deskclock');
  await d.shell('am', 'start', '-n', 'com.google.android.deskclock/com.android.deskclock.DeskClock');
  await d.sleep(3000);
  const el = await d.waitForElement('Stopwatch', { timeout: 8000 });
  const tapped = await d.findAndTap('Stopwatch');
  console.log(JSON.stringify({ found: !!el, tapped: !!tapped }));
`);
assert('waitForElement found Stopwatch', r9?.found, true);
assert('findAndTap succeeded', r9?.tapped, true);

section('openNotifications()');
const r10 = await test('opens shade without error', `
  const d = await device.get();
  await d.home();
  await d.sleep(500);
  const result = await d.openNotifications();
  await d.sleep(500);
  const shot = await d.screenshot('shade_test.png');
  console.log(JSON.stringify({ shade: result.shade, screenshot: !!shot }));
`);
assert('shade opened', r10?.shade, 'open');
assert('screenshot taken', r10?.screenshot, true);

section('skill files');
const CLAUDE_SKILL = join(HOME, '.claude', 'skills', 'android-agent', 'skill.md');
const CODEX_SKILL  = join(HOME, '.codex', 'skills', 'android-agent', 'SKILL.md');
const GEMINI_SKILL = join(HOME, '.gemini', 'config', 'plugins', 'android', 'skills', 'android-agent', 'SKILL.md');
const hasAnyClaude = existsSync(CLAUDE_SKILL);
const hasAnyCodex  = existsSync(CODEX_SKILL);
const hasAnyGemini = existsSync(GEMINI_SKILL);
assert('at least one skill file exists', hasAnyClaude || hasAnyCodex || hasAnyGemini);
import { readFileSync } from 'fs';
if (hasAnyClaude) assert('Claude skill has frontmatter', readFileSync(CLAUDE_SKILL,'utf8').includes('name: android-agent'));

// ── Summary ───────────────────────────────────────────────────────────────────
process.stdout.write(`\n─────────────────────────────────────────────────────\n`);
process.stdout.write(`Results: ${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
