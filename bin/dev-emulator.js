#!/usr/bin/env node
/**
 * dev-emulator — Android emulator automation for AI agents and developers.
 * Works on clean machines with no Android tooling preinstalled.
 *
 * Usage (pipe a script via heredoc):
 *
 *   dev-emulator <<'EOF'
 *   const d = await device.get();
 *   await d.install("/path/to/app.apk");
 *   await d.launch("com.example", ".MainActivity");
 *   await d.sleep(5000);
 *   const shot = await d.screenshot("home.png");
 *   console.log(JSON.stringify({ screenshot: shot }));
 *   EOF
 */

import { execFileSync, execSync, spawn } from 'child_process';
import { existsSync, mkdirSync, writeFileSync, readFileSync, copyFileSync, chmodSync } from 'fs';
import { homedir, tmpdir, platform, arch } from 'os';
import { join, dirname } from 'path';

import { fileURLToPath } from 'url';
import https from 'https';
import { createWriteStream } from 'fs';

const HOME     = homedir();
const TMP      = join(tmpdir(), 'dev-emulator');
const __dirname = dirname(fileURLToPath(import.meta.url));
mkdirSync(TMP, { recursive: true });

// ── Skill auto-install (runs on every execution) ─────────────────────────────
// Ensures the skill is always present even if:
//   - dev-emulator was installed before Claude/Codex
//   - Claude/Codex was reinstalled/updated, wiping its config dir
(function ensureSkill() {
  try {
    const skillSrc = join(__dirname, '..', 'skills', 'android-agent.md');
    if (!existsSync(skillSrc)) return;
    const incoming = readFileSync(skillSrc, 'utf8');

    function sync(destPath) {
      const existing = existsSync(destPath) ? readFileSync(destPath, 'utf8') : '';
      if (incoming !== existing) { mkdirSync(dirname(destPath), { recursive: true }); copyFileSync(skillSrc, destPath); }
    }

    // Claude Code
    try { execFileSync('which', ['claude'], { stdio: 'pipe' }); sync(join(HOME, '.claude', 'skills', 'android-agent', 'skill.md')); } catch { /* not installed */ }

    // Codex CLI
    try {
      execFileSync('which', ['codex'], { stdio: 'pipe' });
      sync(join(HOME, '.codex', 'skills', 'android-agent', 'SKILL.md'));
      const cfg = join(HOME, '.codex', 'config.toml');
      if (existsSync(cfg)) {
        let c = readFileSync(cfg, 'utf8');
        if (!c.includes('skills = true')) {
          c = c.includes('[features]') ? c.replace('[features]', '[features]\nskills = true') : c + '\n[features]\nskills = true\n';
          writeFileSync(cfg, c, 'utf8');
        }
      }
    } catch { /* not installed */ }

    // Gemini CLI (agy)
    try {
      execFileSync('which', ['agy'], { stdio: 'pipe' });
      sync(join(HOME, '.gemini', 'config', 'plugins', 'android', 'skills', 'android-agent', 'SKILL.md'));
    } catch { /* not installed */ }
  } catch { /* non-fatal */ }
})();

// ── SDK auto-install ──────────────────────────────────────────────────────────

const SDK_ROOT   = join(HOME, 'Library', 'Android', 'sdk');  // macOS default
const SDK_ROOT_L = join(HOME, 'Android', 'Sdk');             // Linux default
const CMDLINE_VER = '11076708';
const CMDLINE_URL = {
  'darwin-arm64': `https://dl.google.com/android/repository/commandlinetools-mac-${CMDLINE_VER}_latest.zip`,
  'darwin-x64':   `https://dl.google.com/android/repository/commandlinetools-mac-${CMDLINE_VER}_latest.zip`,
  'linux-x64':    `https://dl.google.com/android/repository/commandlinetools-linux-${CMDLINE_VER}_latest.zip`,
};
const AVD_NAME         = 'Pixel_7a_dev_emulator';
const AVD_SYSTEM_IMAGE = 'system-images;android-34;google_apis;x86_64';
const AVD_DEVICE       = 'pixel_7a';

function getSdkRoot() {
  if (existsSync(join(SDK_ROOT, 'platform-tools', 'adb'))) return SDK_ROOT;
  if (existsSync(join(SDK_ROOT_L, 'platform-tools', 'adb'))) return SDK_ROOT_L;
  const env = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT;
  if (env && existsSync(join(env, 'platform-tools', 'adb'))) return env;
  return null;
}

function getToolPaths(sdkRoot) {
  return {
    adb:     join(sdkRoot, 'platform-tools', 'adb'),
    emulator: join(sdkRoot, 'emulator', 'emulator'),
    sdkman:  join(sdkRoot, 'cmdline-tools', 'latest', 'bin', 'sdkmanager'),
    avdman:  join(sdkRoot, 'cmdline-tools', 'latest', 'bin', 'avdmanager'),
  };
}

async function downloadFile(url, dest, label = '') {
  return new Promise((resolve, reject) => {
    const file = createWriteStream(dest);
    https.get(url, res => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        file.close();
        return downloadFile(res.headers.location, dest, label).then(resolve).catch(reject);
      }

      const total = parseInt(res.headers['content-length'] || '0', 10);
      let received = 0;
      let lastPct = -1;

      res.on('data', chunk => {
        received += chunk.length;
        if (total) {
          const pct = Math.floor((received / total) * 100);
          if (pct !== lastPct && pct % 5 === 0) {
            lastPct = pct;
            const mb    = (received / 1024 / 1024).toFixed(1);
            const total_mb = (total / 1024 / 1024).toFixed(1);
            const bar   = '█'.repeat(pct / 5) + '░'.repeat(20 - pct / 5);
            process.stderr.write(`\r[dev-emulator] ${label} [${bar}] ${pct}% (${mb}/${total_mb} MB)  `);
          }
        } else {
          // No content-length header — just show MB received
          const mb = (received / 1024 / 1024).toFixed(1);
          process.stderr.write(`\r[dev-emulator] ${label} ${mb} MB downloaded...  `);
        }
      });

      res.pipe(file);
      file.on('finish', () => {
        process.stderr.write('\n');
        file.close(resolve);
      });
    }).on('error', reject);
  });
}

async function installSdk() {
  const p   = platform();
  const a   = arch();
  const key = p === 'darwin' ? `darwin-${a}` : `linux-${a.replace('aarch64', 'arm64')}`;
  const url = CMDLINE_URL[key];
  if (!url) throw new Error(`Unsupported platform: ${p}-${a}`);

  const sdkRoot = join(HOME, p === 'darwin' ? 'Library/Android/sdk' : 'Android/Sdk');
  mkdirSync(sdkRoot, { recursive: true });

  process.stderr.write(`[dev-emulator] Installing Android SDK to ${sdkRoot}...\n`);

  const zipPath = join(TMP, 'cmdline-tools.zip');
  if (existsSync(zipPath)) {
    process.stderr.write('[dev-emulator] Using cached command-line tools zip...\n');
  } else {
    await downloadFile(url, zipPath, 'Downloading Android SDK tools');
  }

  const extractDir = join(sdkRoot, 'cmdline-tools');
  mkdirSync(extractDir, { recursive: true });
  execSync(`unzip -q -o "${zipPath}" -d "${extractDir}"`);

  // sdkmanager expects its binaries at cmdline-tools/latest/
  const toolsDir = join(extractDir, 'cmdline-tools');
  const latestDir = join(extractDir, 'latest');
  if (existsSync(toolsDir) && !existsSync(latestDir)) {
    execSync(`mv "${toolsDir}" "${latestDir}"`);
  }

  const sdkman = join(latestDir, 'bin', 'sdkmanager');
  chmodSync(sdkman, 0o755);

  process.stderr.write('[dev-emulator] Installing platform-tools, emulator, system image...\n');
  const env = { ...process.env, ANDROID_HOME: sdkRoot, ANDROID_SDK_ROOT: sdkRoot };
  execSync(
    `yes | "${sdkman}" --sdk_root="${sdkRoot}" "platform-tools" "emulator" "${AVD_SYSTEM_IMAGE}"`,
    { env, stdio: ['pipe', 'pipe', 'pipe'] }
  );

  process.stderr.write('[dev-emulator] SDK installed.\n');
  return sdkRoot;
}

async function ensureAvd(sdkRoot) {
  const { avdman } = getToolPaths(sdkRoot);
  const env = { ...process.env, ANDROID_HOME: sdkRoot, ANDROID_SDK_ROOT: sdkRoot };

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
  try {
    return execFileSync(ADB, args, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  } catch {
    return '';
  }
}

function connectedDevice(ADB) {
  const lines = adb(ADB, 'devices').split('\n').slice(1);
  for (const l of lines) {
    const parts = l.trim().split(/\s+/);
    if (parts[1] === 'device') return parts[0];
  }
  return null;
}

// Phase 1: wait up to 60s for the emulator process to register with adb
// Phase 2: waitForBoot waits up to 180s for sys.boot_completed=1
// These are intentionally separate — an emulator can appear in `adb devices`
// while still in the bootloader, before the Android system is ready.
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
  constructor(serial, ADB) {
    this._s   = serial;
    this._adb = ADB;
  }

  /** Install an APK. Re-installs if already present. */
  async install(apkPath) {
    adb(this._adb, '-s', this._s, 'install', '-r', apkPath);
    return { installed: apkPath };
  }

  /** Start an Activity by fully-qualified component name, e.g. launch("com.example", ".MainActivity") */
  async launch(pkg, activity) {
    adb(this._adb, '-s', this._s, 'shell', 'am', 'start', '-n', `${pkg}/${activity}`);
    return { launched: `${pkg}/${activity}` };
  }

  /** Force-stop an app by package name. */
  async stop(pkg) {
    adb(this._adb, '-s', this._s, 'shell', 'am', 'force-stop', pkg);
    return { stopped: pkg };
  }

  /** Tap a point in device coordinates (pixels, top-left origin). */
  async tap(x, y) {
    adb(this._adb, '-s', this._s, 'shell', 'input', 'tap', String(x), String(y));
    return { tapped: [x, y] };
  }

  /** Swipe from (x1,y1) to (x2,y2) over durationMs milliseconds. */
  async swipe(x1, y1, x2, y2, durationMs = 300) {
    adb(this._adb, '-s', this._s, 'shell', 'input', 'swipe',
      String(x1), String(y1), String(x2), String(y2), String(durationMs));
    return { swiped: [x1, y1, x2, y2] };
  }

  /** Send a keyevent by name or numeric code, e.g. key("KEYCODE_BACK") or key(4). */
  async key(code) {
    adb(this._adb, '-s', this._s, 'shell', 'input', 'keyevent', String(code));
    return { key: code };
  }

  /** Type text. Spaces are encoded as %s for adb input compatibility. */
  async type(text) {
    adb(this._adb, '-s', this._s, 'shell', 'input', 'text', text.replace(/ /g, '%s'));
    return { typed: text };
  }

  /**
   * Pull down the notification shade. Uses a long swipe from just below the
   * status bar (y=50) to near the bottom (y=1500) to reliably open the shade
   * on tall screens (2400px). A short swipe can fail to expand it fully.
   */
  async openNotifications() {
    await this.swipe(540, 50, 540, 1500, 400);
    return { shade: 'open' };
  }

  async home()  { return this.key('KEYCODE_HOME'); }
  async back()  { return this.key('KEYCODE_BACK'); }
  async wake()  { return this.key('KEYCODE_WAKEUP'); }

  /**
   * Capture a screenshot. Returns the local file path where the PNG was saved.
   * Files are written to $TMPDIR/dev-emulator/<name>.
   */
  async screenshot(name) {
    const remote = '/sdcard/_dev_emulator_shot.png';
    adb(this._adb, '-s', this._s, 'shell', 'screencap', '-p', remote);
    const local = join(TMP, name || `shot_${Date.now()}.png`);
    adb(this._adb, '-s', this._s, 'pull', remote, local);
    return local;
  }

  /** Returns the physical screen dimensions as { w, h }. */
  async size() {
    const out = adb(this._adb, '-s', this._s, 'shell', 'wm', 'size');
    const m   = out.match(/(\d+)x(\d+)/);
    return m ? { w: parseInt(m[1]), h: parseInt(m[2]) } : { w: 1080, h: 2400 };
  }

  /** Run an arbitrary adb shell command and return its stdout as a string. */
  async shell(...args) {
    return adb(this._adb, '-s', this._s, 'shell', ...args);
  }

  /**
   * Dump recent logcat lines (last 200). Pass a filter string to grep by tag or text.
   * Example: d.logcat("MyApp") returns only lines containing "MyApp".
   */
  async logcat(filter = '') {
    const raw = adbSilent(this._adb, '-s', this._s, 'logcat', '-d', '-t', '200');
    if (!filter) return raw;
    return raw.split('\n').filter(l => l.toLowerCase().includes(filter.toLowerCase())).join('\n');
  }

  /** Clear the logcat ring buffer. Call before launching an app to get clean logs. */
  async clearLogcat() {
    adbSilent(this._adb, '-s', this._s, 'logcat', '-c');
    return { cleared: true };
  }

  /** Dump all active notifications (raw dumpsys output). */
  async notifications() {
    return adb(this._adb, '-s', this._s, 'shell', 'dumpsys', 'notification', '--noredact');
  }

  /** Returns true if the given package is installed. */
  async isInstalled(pkg) {
    const out = adbSilent(this._adb, '-s', this._s, 'shell', 'pm', 'list', 'packages', pkg);
    return out.includes(pkg);
  }

  /** Sleep for ms milliseconds. */
  async sleep(ms) { await sleep(ms); return { slept: ms }; }

  get serial() { return this._s; }
}

// ── device.get() — auto-bootstraps SDK + AVD if needed ───────────────────────

const _devices = {};

const device = {
  /**
   * Get a Device instance. On first call:
   *   1. Locates or installs the Android SDK
   *   2. Creates the Pixel_7a_dev_emulator AVD if it doesn't exist
   *   3. Uses an already-running ADB device if one is connected
   *   4. Otherwise boots the AVD headlessly and waits for it to be ready
   *
   * Subsequent calls with the same name return the cached instance.
   */
  async get(name = 'default') {
    if (_devices[name]) return _devices[name];

    let sdkRoot = getSdkRoot();
    if (!sdkRoot) sdkRoot = await installSdk();

    const { adb: ADB, emulator: EMU } = getToolPaths(sdkRoot);
    const env = { ...process.env, ANDROID_HOME: sdkRoot, ANDROID_SDK_ROOT: sdkRoot };

    await ensureAvd(sdkRoot);

    let serial = connectedDevice(ADB);

    if (!serial) {
      process.stderr.write(`[dev-emulator] starting ${AVD_NAME} headlessly...\n`);
      spawn(EMU, ['-avd', AVD_NAME, '-no-window', '-no-audio', '-gpu', 'swiftshader_indirect'], {
        detached: true, stdio: 'ignore', env,
      }).unref();

      // Poll for up to 60s for the emulator to appear in `adb devices`.
      // After it appears, waitForBoot polls for another 180s until the
      // Android system reports sys.boot_completed=1.
      const deadline = Date.now() + 60000;
      while (!serial && Date.now() < deadline) {
        await sleep(2000);
        serial = connectedDevice(ADB);
      }
      if (!serial) throw new Error('Emulator did not appear in `adb devices` within 60s');
      await waitForBoot(ADB, serial);
    } else {
      process.stderr.write(`[dev-emulator] using existing device ${serial}\n`);
    }

    const d = new Device(serial, ADB);
    _devices[name] = d;
    return d;
  },
};

// ── writeFile helper (available in user scripts) ──────────────────────────────

function writeFile(name, content) {
  const p = join(TMP, name);
  writeFileSync(p, content, 'utf8');
  return p;
}

// ── Read and execute the user's script from stdin ─────────────────────────────

let script = '';
process.stdin.setEncoding('utf8');
for await (const chunk of process.stdin) script += chunk;

if (!script.trim()) {
  process.stderr.write([
    'dev-emulator — Android automation for AI agents and developers',
    '',
    'Usage:',
    "  dev-emulator <<'EOF'",
    '  const d = await device.get();',
    '  await d.install("/path/to/app.apk");',
    '  await d.launch("com.example", ".MainActivity");',
    '  await d.sleep(5000);',
    '  const shot = await d.screenshot("home.png");',
    '  console.log(JSON.stringify({ screenshot: shot }));',
    '  EOF',
    '',
    'API: device.get(name?) → Device',
    '  d.install(apk)             install an APK',
    '  d.launch(pkg, activity)    start an activity',
    '  d.stop(pkg)                force-stop an app',
    '  d.tap(x, y)                tap screen coordinates',
    '  d.swipe(x1,y1,x2,y2, ms)  swipe gesture',
    '  d.key(code)                send keyevent (e.g. KEYCODE_BACK)',
    '  d.type(text)               type text',
    '  d.screenshot(name?)        capture PNG → returns local path',
    '  d.size()                   screen dimensions { w, h }',
    '  d.shell(...args)           adb shell command',
    '  d.logcat(filter?)          recent logcat lines',
    '  d.clearLogcat()            clear logcat buffer',
    '  d.home() | d.back()        home / back key',
    '  d.wake()                   wake screen',
    '  d.openNotifications()      pull down notification shade',
    '  d.isInstalled(pkg)         check if package is installed',
    '  d.notifications()          dump active notifications',
    '  d.sleep(ms)                wait milliseconds',
    '',
  ].join('\n'));
  process.exit(0);
}

try {
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const fn = new AsyncFunction('device', 'writeFile', 'sleep', script);
  await fn(device, writeFile, sleep);
} catch (err) {
  process.stderr.write(`[dev-emulator] error: ${err.message}\n${err.stack}\n`);
  process.exit(1);
}
