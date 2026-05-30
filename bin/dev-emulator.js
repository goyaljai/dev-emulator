#!/usr/bin/env node
/**
 * dev-emulator — Android emulator automation for Claude agents.
 * Works on clean machines with no Android tooling preinstalled.
 *
 * Usage:
 *   dev-emulator <<'EOF'
 *   const d = await device.get("pixel7a");
 *   await d.install("/path/to/app.apk");
 *   await d.launch("com.example", ".MainActivity");
 *   await d.sleep(5000);
 *   const shot = await d.screenshot("home.png");
 *   console.log(JSON.stringify({ screenshot: shot }));
 *   EOF
 */

import { execFileSync, execSync, spawn } from 'child_process';
import { existsSync, mkdirSync, writeFileSync, readFileSync, chmodSync } from 'fs';
import { homedir, tmpdir, platform, arch } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import https from 'https';
import { createWriteStream } from 'fs';

const HOME   = homedir();
const TMP    = join(tmpdir(), 'dev-emulator');
mkdirSync(TMP, { recursive: true });

// ── SDK auto-install ──────────────────────────────────────────────────────────

const SDK_ROOT   = join(HOME, 'Library', 'Android', 'sdk');           // macOS default
const SDK_ROOT_L = join(HOME, 'Android', 'Sdk');                      // Linux default
const CMDLINE_VER = '11076708';
const CMDLINE_URL = {
  'darwin-arm64': `https://dl.google.com/android/repository/commandlinetools-mac-${CMDLINE_VER}_latest.zip`,
  'darwin-x64':   `https://dl.google.com/android/repository/commandlinetools-mac-${CMDLINE_VER}_latest.zip`,
  'linux-x64':    `https://dl.google.com/android/repository/commandlinetools-linux-${CMDLINE_VER}_latest.zip`,
};
const AVD_NAME = 'Pixel_7a_dev_emulator';
const AVD_SYSTEM_IMAGE = 'system-images;android-34;google_apis;x86_64';
const AVD_DEVICE = 'pixel_7a';

function getSdkRoot() {
  if (existsSync(join(SDK_ROOT, 'platform-tools', 'adb'))) return SDK_ROOT;
  if (existsSync(join(SDK_ROOT_L, 'platform-tools', 'adb'))) return SDK_ROOT_L;
  // Also check ANDROID_HOME / ANDROID_SDK_ROOT env vars
  const env = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT;
  if (env && existsSync(join(env, 'platform-tools', 'adb'))) return env;
  return null;
}

function getToolPaths(sdkRoot) {
  return {
    adb:      join(sdkRoot, 'platform-tools', 'adb'),
    emulator: join(sdkRoot, 'emulator', 'emulator'),
    sdkman:   join(sdkRoot, 'cmdline-tools', 'latest', 'bin', 'sdkmanager'),
    avdman:   join(sdkRoot, 'cmdline-tools', 'latest', 'bin', 'avdmanager'),
  };
}

async function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const file = createWriteStream(dest);
    https.get(url, res => {
      if (res.statusCode === 302 || res.statusCode === 301) {
        file.close();
        return downloadFile(res.headers.location, dest).then(resolve).catch(reject);
      }
      res.pipe(file);
      file.on('finish', () => file.close(resolve));
    }).on('error', reject);
  });
}

async function installSdk() {
  const p = platform();
  const a = arch();
  const key = p === 'darwin' ? `darwin-${a}` : `linux-${a.replace('aarch64','arm64')}`;
  const url = CMDLINE_URL[key];
  if (!url) throw new Error(`Unsupported platform: ${p}-${a}`);

  const sdkRoot = join(HOME, p === 'darwin' ? 'Library/Android/sdk' : 'Android/Sdk');
  mkdirSync(sdkRoot, { recursive: true });

  process.stderr.write(`[dev-emulator] Installing Android SDK to ${sdkRoot}...\n`);

  const zipPath = join(TMP, 'cmdline-tools.zip');
  process.stderr.write('[dev-emulator] Downloading command-line tools...\n');
  await downloadFile(url, zipPath);

  const extractDir = join(sdkRoot, 'cmdline-tools');
  mkdirSync(extractDir, { recursive: true });
  execSync(`unzip -q -o "${zipPath}" -d "${extractDir}"`);

  // sdkmanager expects tools at cmdline-tools/latest
  const toolsDir = join(extractDir, 'cmdline-tools');
  const latestDir = join(extractDir, 'latest');
  if (existsSync(toolsDir) && !existsSync(latestDir)) {
    execSync(`mv "${toolsDir}" "${latestDir}"`);
  }

  const sdkman = join(latestDir, 'bin', 'sdkmanager');
  chmodSync(sdkman, 0o755);

  // Accept licenses and install required packages
  process.stderr.write('[dev-emulator] Installing platform-tools, emulator, system image...\n');
  const env = { ...process.env, ANDROID_HOME: sdkRoot, ANDROID_SDK_ROOT: sdkRoot };
  execSync(`yes | "${sdkman}" --sdk_root="${sdkRoot}" "platform-tools" "emulator" "${AVD_SYSTEM_IMAGE}"`,
    { env, stdio: ['pipe', 'pipe', 'pipe'] });

  process.stderr.write('[dev-emulator] SDK installed.\n');
  return sdkRoot;
}

async function ensureAvd(sdkRoot) {
  const { avdman, sdkman } = getToolPaths(sdkRoot);
  const env = { ...process.env, ANDROID_HOME: sdkRoot, ANDROID_SDK_ROOT: sdkRoot };

  // Check if AVD already exists
  const avdList = execSync(`"${avdman}" list avd`, { env, encoding: 'utf8' });
  if (avdList.includes(AVD_NAME)) {
    process.stderr.write(`[dev-emulator] AVD ${AVD_NAME} already exists\n`);
    return;
  }

  process.stderr.write(`[dev-emulator] Creating AVD ${AVD_NAME}...\n`);
  execSync(
    `echo no | "${avdman}" create avd -n "${AVD_NAME}" -k "${AVD_SYSTEM_IMAGE}" -d "${AVD_DEVICE}" --force`,
    { env, stdio: ['pipe', 'pipe', 'pipe'] }
  );
  process.stderr.write('[dev-emulator] AVD created.\n');
}

// ── ADB helpers ───────────────────────────────────────────────────────────────

function adb(ADB, ...args) {
  return execFileSync(ADB, args, { encoding: 'utf8' }).trim();
}
function adbSilent(ADB, ...args) {
  try { return execFileSync(ADB, args, { encoding: 'utf8', stdio: ['pipe','pipe','pipe'] }).trim(); }
  catch { return ''; }
}

function connectedDevice(ADB) {
  const lines = adb(ADB, 'devices').split('\n').slice(1);
  for (const l of lines) {
    const parts = l.trim().split(/\s+/);
    if (parts[1] === 'device') return parts[0];
  }
  return null;
}

async function waitForBoot(ADB, serial, timeoutMs = 180000) {
  const deadline = Date.now() + timeoutMs;
  process.stderr.write('[dev-emulator] waiting for device boot');
  while (Date.now() < deadline) {
    const v = adbSilent(ADB, '-s', serial, 'shell', 'getprop', 'sys.boot_completed').trim();
    if (v === '1') { process.stderr.write(' ✓\n'); return; }
    process.stderr.write('.');
    await sleep(3000);
  }
  throw new Error('Emulator boot timed out after 3 minutes');
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Device API ────────────────────────────────────────────────────────────────

class Device {
  constructor(serial, ADB) { this._s = serial; this._adb = ADB; }

  async install(apkPath) {
    adb(this._adb, '-s', this._s, 'install', '-r', apkPath);
    return { installed: apkPath };
  }
  async launch(pkg, activity) {
    adb(this._adb, '-s', this._s, 'shell', 'am', 'start', '-n', `${pkg}/${activity}`);
    return { launched: `${pkg}/${activity}` };
  }
  async stop(pkg) {
    adb(this._adb, '-s', this._s, 'shell', 'am', 'force-stop', pkg);
    return { stopped: pkg };
  }
  async tap(x, y) {
    adb(this._adb, '-s', this._s, 'shell', 'input', 'tap', String(x), String(y));
    return { tapped: [x, y] };
  }
  async swipe(x1, y1, x2, y2, durationMs = 300) {
    adb(this._adb, '-s', this._s, 'shell', 'input', 'swipe',
        String(x1), String(y1), String(x2), String(y2), String(durationMs));
    return { swiped: [x1, y1, x2, y2] };
  }
  async key(code) {
    adb(this._adb, '-s', this._s, 'shell', 'input', 'keyevent', String(code));
    return { key: code };
  }
  async type(text) {
    adb(this._adb, '-s', this._s, 'shell', 'input', 'text', text.replace(/ /g, '%s'));
    return { typed: text };
  }
  async openNotifications() {
    await this.swipe(540, 0, 540, 900, 300); return { shade: 'open' };
  }
  async home() { return this.key('KEYCODE_HOME'); }
  async back() { return this.key('KEYCODE_BACK'); }
  async wake() { return this.key('KEYCODE_WAKEUP'); }
  async screenshot(name) {
    const remote = '/sdcard/_dev_emulator_shot.png';
    adb(this._adb, '-s', this._s, 'shell', 'screencap', '-p', remote);
    const local = join(TMP, name || `shot_${Date.now()}.png`);
    adb(this._adb, '-s', this._s, 'pull', remote, local);
    return local;
  }
  async size() {
    const out = adb(this._adb, '-s', this._s, 'shell', 'wm', 'size');
    const m = out.match(/(\d+)x(\d+)/);
    return m ? { w: parseInt(m[1]), h: parseInt(m[2]) } : { w: 1080, h: 2400 };
  }
  async shell(...args) { return adb(this._adb, '-s', this._s, 'shell', ...args); }
  async logcat(filter = '') {
    const raw = adbSilent(this._adb, '-s', this._s, 'logcat', '-d', '-t', '200');
    if (!filter) return raw;
    return raw.split('\n').filter(l => l.toLowerCase().includes(filter.toLowerCase())).join('\n');
  }
  async clearLogcat() { adbSilent(this._adb, '-s', this._s, 'logcat', '-c'); return { cleared: true }; }
  async notifications() {
    return adb(this._adb, '-s', this._s, 'shell', 'dumpsys', 'notification', '--noredact');
  }
  async isInstalled(pkg) {
    const out = adbSilent(this._adb, '-s', this._s, 'shell', 'pm', 'list', 'packages', pkg);
    return out.includes(pkg);
  }
  async sleep(ms) { await sleep(ms); return { slept: ms }; }
  get serial() { return this._s; }
}

// ── device.get() — auto-bootstraps SDK + AVD if missing ─────────────────────

const _devices = {};

const device = {
  async get(name = 'default') {
    if (_devices[name]) return _devices[name];

    // 1. Find or install SDK
    let sdkRoot = getSdkRoot();
    if (!sdkRoot) {
      sdkRoot = await installSdk();
    }
    const { adb: ADB, emulator: EMU } = getToolPaths(sdkRoot);
    const env = { ...process.env, ANDROID_HOME: sdkRoot, ANDROID_SDK_ROOT: sdkRoot };

    // 2. Create AVD if needed
    await ensureAvd(sdkRoot);

    // 3. Check for already-running device
    let serial = connectedDevice(ADB);

    // 4. Boot emulator if nothing connected
    if (!serial) {
      process.stderr.write(`[dev-emulator] starting ${AVD_NAME} headlessly...\n`);
      spawn(EMU, ['-avd', AVD_NAME, '-no-window', '-no-audio', '-gpu', 'swiftshader_indirect'], {
        detached: true, stdio: 'ignore', env
      }).unref();

      const deadline = Date.now() + 60000;
      while (!serial && Date.now() < deadline) {
        await sleep(2000);
        serial = connectedDevice(ADB);
      }
      if (!serial) throw new Error('Could not find emulator after 60s');
      await waitForBoot(ADB, serial);
    } else {
      process.stderr.write(`[dev-emulator] using existing device ${serial}\n`);
    }

    const d = new Device(serial, ADB);
    _devices[name] = d;
    return d;
  }
};

// ── writeFile helper ──────────────────────────────────────────────────────────

function writeFile(name, content) {
  const p = join(TMP, name);
  writeFileSync(p, content, 'utf8');
  return p;
}

// ── Read & eval user script from stdin ───────────────────────────────────────

let script = '';
process.stdin.setEncoding('utf8');
for await (const chunk of process.stdin) script += chunk;

if (!script.trim()) {
  process.stderr.write([
    'dev-emulator — Android automation for Claude agents',
    '',
    'Usage:',
    '  dev-emulator <<\'EOF\'',
    '  const d = await device.get();',
    '  await d.install("/path/to/app.apk");',
    '  await d.launch("com.example", ".MainActivity");',
    '  await d.sleep(5000);',
    '  const shot = await d.screenshot("home.png");',
    '  console.log(JSON.stringify({ screenshot: shot }));',
    '  EOF',
    '',
    'API: device.get(name?) → Device',
    '  d.install(apk) | d.launch(pkg, activity) | d.stop(pkg)',
    '  d.tap(x,y) | d.swipe(x1,y1,x2,y2,ms) | d.key(code) | d.type(text)',
    '  d.screenshot(name?) | d.size() | d.shell(...) | d.logcat(filter?)',
    '  d.home() | d.back() | d.wake() | d.openNotifications() | d.sleep(ms)',
    '',
  ].join('\n'));
  process.exit(0);
}

try {
  const AsyncFunction = Object.getPrototypeOf(async function(){}).constructor;
  const fn = new AsyncFunction('device', 'writeFile', 'sleep', script);
  await fn(device, writeFile, sleep);
} catch (err) {
  process.stderr.write(`[dev-emulator] error: ${err.message}\n${err.stack}\n`);
  process.exit(1);
}
