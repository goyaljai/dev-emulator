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

    // Resolve binary by walking PATH — no subprocess, no dependency on `which`
    const inPath = name => (process.env.PATH || '').split(':').some(d => existsSync(join(d, name)));

    // Claude Code
    if (inPath('claude')) sync(join(HOME, '.claude', 'skills', 'android-agent', 'skill.md'));

    // Codex CLI
    if (inPath('codex')) {
      sync(join(HOME, '.codex', 'skills', 'android-agent', 'SKILL.md'));
      const cfg = join(HOME, '.codex', 'config.toml');
      if (existsSync(cfg)) {
        let c = readFileSync(cfg, 'utf8');
        if (!c.includes('skills = true')) {
          c = c.includes('[features]') ? c.replace('[features]', '[features]\nskills = true') : c + '\n[features]\nskills = true\n';
          writeFileSync(cfg, c, 'utf8');
        }
      }
    }

    // Gemini CLI (agy)
    if (inPath('agy')) sync(join(HOME, '.gemini', 'config', 'plugins', 'android', 'skills', 'android-agent', 'SKILL.md'));
  } catch { /* non-fatal */ }
})();

// ── Preflight checks (only runs when SDK install is needed) ──────────────────
function runPreflight() {
  const errors = [];
  const warnings = [];

  // Platform
  if (platform() === 'win32')
    errors.push('Windows is not supported. Use macOS or Linux (or WSL2).');

  // Node version
  const nodeVer = parseInt(process.version.slice(1).split('.')[0]);
  if (nodeVer < 18)
    errors.push(`Node ${process.version} is too old. Node 18+ required — install from https://nodejs.org`);

  // unzip (needed to extract SDK zip)
  const hasUnzip = (process.env.PATH || '').split(':').some(d => existsSync(join(d, 'unzip')));
  if (!hasUnzip)
    errors.push('`unzip` is not installed. Install it: macOS → `brew install unzip`, Linux → `apt install unzip`');

  // Java (needed by sdkmanager + avdmanager; warn only — may already be bundled in some envs)
  const hasJava = (process.env.PATH || '').split(':').some(d => existsSync(join(d, 'java')));
  if (!hasJava)
    warnings.push('Java not found. It is required to boot the emulator. Install from https://adoptium.net');

  if (warnings.length) {
    warnings.forEach(w => process.stderr.write(`[dev-emulator] ⚠️  ${w}\n`));
  }
  if (errors.length) {
    errors.forEach(e => process.stderr.write(`[dev-emulator] ❌ ${e}\n`));
    throw new Error('Preflight checks failed. Fix the issues above and try again.');
  }
}

// ── SDK auto-install ──────────────────────────────────────────────────────────

const SDK_ROOT   = join(HOME, 'Library', 'Android', 'sdk');  // macOS default
const SDK_ROOT_L = join(HOME, 'Android', 'Sdk');             // Linux default
const CMDLINE_VER = '11076708';
const CMDLINE_URL = {
  'darwin-arm64': `https://dl.google.com/android/repository/commandlinetools-mac-${CMDLINE_VER}_latest.zip`,
  'darwin-x64':   `https://dl.google.com/android/repository/commandlinetools-mac-${CMDLINE_VER}_latest.zip`,
  'linux-x64':    `https://dl.google.com/android/repository/commandlinetools-linux-${CMDLINE_VER}_latest.zip`,
  'linux-arm64':  `https://dl.google.com/android/repository/commandlinetools-linux-${CMDLINE_VER}_latest.zip`,
};
const AVD_NAME   = 'Pixel_7a_dev_emulator';
const AVD_DEVICE = 'pixel_7a';

// Detect the best architecture for this machine
function getAbi() {
  const a = arch();
  return (a === 'arm64' || a === 'aarch64') ? 'arm64-v8a' : 'x86_64';
}

// Scan installed system images and return all candidates sorted by preference.
// Sort: plain google_apis first (most avdmanager-compatible), then by API level descending.
function findAllSystemImages(sdkRoot) {
  const imagesDir = join(sdkRoot, 'system-images');
  if (!existsSync(imagesDir)) return [];
  const abi = getAbi();
  const candidates = [];
  try {
    const apis = execSync(`ls "${imagesDir}"`, { encoding: 'utf8' }).trim().split('\n').filter(Boolean);
    for (const api of apis) {
      const apiDir = join(imagesDir, api);
      try {
        const tags = execSync(`ls "${apiDir}"`, { encoding: 'utf8' }).trim().split('\n').filter(Boolean);
        for (const tag of tags) {
          if (existsSync(join(apiDir, tag, abi))) {
            const level = parseFloat(api.replace('android-', '')) || 0;
            const priority = tag === 'google_apis' ? 1 :
                             tag === 'google_apis_playstore' ? 2 :
                             tag.startsWith('google_apis') ? 3 : 4;
            candidates.push({ image: `system-images;${api};${tag};${abi}`, level, priority });
          }
        }
      } catch { /* skip */ }
    }
  } catch { return []; }
  candidates.sort((a, b) => a.priority - b.priority || b.level - a.level);
  return candidates.map(c => c.image);
}

// Return the single best system image string, or null if none installed.
function findBestSystemImage(sdkRoot) {
  const all = findAllSystemImages(sdkRoot);
  return all.length ? all[0] : null;
}

// Build the sdkmanager package string for a fresh install
function getTargetSystemImage() {
  const abi = getAbi();
  return `system-images;android-34;google_apis;${abi}`;
}

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

  const env = { ...process.env, ANDROID_HOME: sdkRoot, ANDROID_SDK_ROOT: sdkRoot };

  // Install platform-tools (adb) first — small ~10MB download.
  // After adb is available, check if a device is already connected.
  // If one is found, skip the large emulator + system image download entirely.
  process.stderr.write('[dev-emulator] Installing platform-tools (adb)...\n');
  execSync(
    `yes | "${sdkman}" --sdk_root="${sdkRoot}" "platform-tools"`,
    { env, stdio: ['pipe', 'pipe', 'pipe'] }
  );

  const { adb: ADB } = getToolPaths(sdkRoot);
  const earlyDevice = connectedDevice(ADB);
  if (earlyDevice) {
    process.stderr.write(`[dev-emulator] Found connected device ${earlyDevice} — skipping emulator install.\n`);
    return sdkRoot;
  }

  // No device connected — need the full emulator + system image
  const targetImage = getTargetSystemImage();
  process.stderr.write(`[dev-emulator] Installing emulator and system image (${targetImage})...\n`);
  execSync(
    `yes | "${sdkman}" --sdk_root="${sdkRoot}" "emulator" "${targetImage}"`,
    { env, stdio: ['pipe', 'pipe', 'pipe'] }
  );

  process.stderr.write('[dev-emulator] SDK installed.\n');
  return sdkRoot;
}

// Install cmdline-tools into an existing SDK root that is missing them.
async function installCmdlineTools(sdkRoot) {
  const p   = platform();
  const a   = arch();
  const key = p === 'darwin' ? `darwin-${a}` : `linux-${a.replace('aarch64', 'arm64')}`;
  const url = CMDLINE_URL[key];
  if (!url) throw new Error(`Unsupported platform: ${p}-${a}`);

  process.stderr.write(`[dev-emulator] Installing command-line tools into ${sdkRoot}...\n`);
  const zipPath = join(TMP, 'cmdline-tools.zip');
  if (!existsSync(zipPath)) await downloadFile(url, zipPath, 'Downloading command-line tools');

  const extractDir = join(sdkRoot, 'cmdline-tools');
  mkdirSync(extractDir, { recursive: true });
  execSync(`unzip -q -o "${zipPath}" -d "${extractDir}"`);
  const toolsDir  = join(extractDir, 'cmdline-tools');
  const latestDir = join(extractDir, 'latest');
  if (existsSync(toolsDir) && !existsSync(latestDir)) execSync(`mv "${toolsDir}" "${latestDir}"`);
  chmodSync(join(latestDir, 'bin', 'sdkmanager'), 0o755);
  process.stderr.write('[dev-emulator] Command-line tools installed.\n');
}

async function ensureAvd(sdkRoot) {
  const { avdman } = getToolPaths(sdkRoot);
  const env = { ...process.env, ANDROID_HOME: sdkRoot, ANDROID_SDK_ROOT: sdkRoot };

  // If avdmanager is missing (cmdline-tools not installed), install them now
  if (!existsSync(avdman)) {
    process.stderr.write(`[dev-emulator] avdmanager not found — installing cmdline-tools...\n`);
    await installCmdlineTools(sdkRoot);
  }

  // Check if AVD already exists
  let avdList = '';
  try { avdList = execSync(`"${avdman}" list avd`, { env, encoding: 'utf8' }); } catch { avdList = ''; }
  if (avdList.includes(AVD_NAME)) {
    process.stderr.write(`[dev-emulator] AVD ${AVD_NAME} already exists\n`);
    return;
  }

  // Ask avdmanager what system images it actually accepts — this is the ground truth.
  // Some images (e.g. android-37.0 ps16k) require newer cmdline-tools and are rejected.
  let validImages = new Set();
  try {
    const imgOut = execSync(`"${avdman}" list target`, { env, encoding: 'utf8', stdio: ['pipe','pipe','pipe'] });
    const matches = imgOut.matchAll(/system-images;[^\s"]+/g);
    for (const m of matches) validImages.add(m[0]);
  } catch { /* list target not always available — fall back to directory scan */ }

  // Find the best available system image that avdmanager accepts
  let sysImage = null;
  const candidates = findBestSystemImage(sdkRoot);
  if (candidates) {
    // findBestSystemImage returns the top pick — check if it's in validImages
    if (validImages.size === 0 || validImages.has(candidates)) {
      sysImage = candidates;
    } else {
      // Top pick rejected — find first candidate avdmanager accepts
      // Re-scan all installed images and filter against validImages
      const allCandidates = findAllSystemImages(sdkRoot);
      sysImage = allCandidates.find(img => validImages.has(img)) || allCandidates[0] || null;
    }
  }

  if (!sysImage) {
    // No image installed yet — install one now
    const { sdkman } = getToolPaths(sdkRoot);
    const targetImage = getTargetSystemImage();
    process.stderr.write(`[dev-emulator] No system image found — installing ${targetImage}...\n`);
    execSync(`yes | "${sdkman}" --sdk_root="${sdkRoot}" "${targetImage}"`, { env, stdio: ['pipe', 'pipe', 'pipe'] });
    sysImage = targetImage;
  }

  process.stderr.write(`[dev-emulator] Creating AVD ${AVD_NAME} (${sysImage})...\n`);
  // Try device profiles in order — older avdmanager versions don't know pixel_7a
  const deviceFallbacks = [AVD_DEVICE, 'pixel_6', 'pixel_4', 'medium_phone', 'pixel'];
  let created = false;
  for (const dev of deviceFallbacks) {
    try {
      execSync(
        `echo no | "${avdman}" create avd -n "${AVD_NAME}" -k "${sysImage}" -d "${dev}" --force`,
        { env, stdio: ['pipe', 'pipe', 'pipe'] }
      );
      created = true;
      break;
    } catch { /* try next device */ }
  }
  if (!created) {
    // Last resort: create without --device flag (avdmanager picks a default)
    execSync(
      `echo no | "${avdman}" create avd -n "${AVD_NAME}" -k "${sysImage}" --force`,
      { env, stdio: ['pipe', 'pipe', 'pipe'] }
    );
  }
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

  async openNotifications() {
    adb(this._adb, '-s', this._s, 'shell', 'cmd', 'statusbar', 'expand-notifications');
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
   * Dump the current UI hierarchy via UIAutomator.
   * Returns an array of elements: { text, contentDesc, bounds: { x1,y1,x2,y2,cx,cy } }
   * Useful for finding elements by label without knowing their coordinates.
   */
  async getUI() {
    const remote = '/sdcard/_dev_emulator_ui.xml';
    const local  = join(TMP, `ui_${Date.now()}.xml`);
    adbSilent(this._adb, '-s', this._s, 'shell', 'uiautomator', 'dump', remote);
    adb(this._adb, '-s', this._s, 'pull', remote, local);
    const xml = readFileSync(local, 'utf8');
    const elements = [];
    const nodeRe = /<node[^>]*>/g;
    let match;
    while ((match = nodeRe.exec(xml)) !== null) {
      const node   = match[0];
      const text   = (node.match(/text="([^"]*)"/)       || [])[1] || '';
      const desc   = (node.match(/content-desc="([^"]*)"/) || [])[1] || '';
      const bounds = node.match(/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/);
      if (bounds) {
        const x1 = parseInt(bounds[1]), y1 = parseInt(bounds[2]);
        const x2 = parseInt(bounds[3]), y2 = parseInt(bounds[4]);
        elements.push({ text, contentDesc: desc, bounds: { x1, y1, x2, y2, cx: Math.floor((x1+x2)/2), cy: Math.floor((y1+y2)/2) } });
      }
    }
    return elements;
  }

  /**
   * Find an element by visible text or content-desc and tap its center.
   * Throws if no matching element is found.
   * Example: await d.findAndTap("Sign In")
   */
  async findAndTap(text) {
    const els = await this.getUI();
    const target = els.find(e =>
      e.text.toLowerCase() === text.toLowerCase() ||
      e.contentDesc.toLowerCase() === text.toLowerCase()
    );
    if (!target) throw new Error(`findAndTap: no element found with text/desc "${text}"`);
    await this.tap(target.bounds.cx, target.bounds.cy);
    return { tapped: text, at: [target.bounds.cx, target.bounds.cy] };
  }

  /**
   * Poll the UI until an element with the given text/desc appears, then return it.
   * Throws if the element is not found within the timeout.
   * Options: { timeout: 10000, interval: 1000 }
   */
  async waitForElement(text, opts = {}) {
    const timeout  = opts.timeout  || 10000;
    const interval = opts.interval || 1000;
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const els = await this.getUI();
      const found = els.find(e =>
        e.text.toLowerCase() === text.toLowerCase() ||
        e.contentDesc.toLowerCase() === text.toLowerCase()
      );
      if (found) return found;
      await sleep(interval);
    }
    throw new Error(`waitForElement: "${text}" not found after ${timeout}ms`);
  }

  /**
   * Dump recent logcat lines. Pass a filter to grep by tag or text.
   * Options: lines (default 200) — how many recent lines to return.
   * Example: d.logcat("MyApp", { lines: 500 })
   */
  async logcat(filter = '', opts = {}) {
    const lines = String(opts.lines || 200);
    const raw = adbSilent(this._adb, '-s', this._s, 'logcat', '-d', '-t', lines);
    if (!filter) return raw;
    return raw.split('\n').filter(l => l.toLowerCase().includes(filter.toLowerCase())).join('\n');
  }

  /** Clear the logcat ring buffer. Call before launching an app to get clean logs. */
  async clearLogcat() {
    adbSilent(this._adb, '-s', this._s, 'logcat', '-c');
    return { cleared: true };
  }

  /**
   * Check if the app has crashed. Scans AndroidRuntime:E logcat for the package name.
   * Returns { crashed: true, error: "..." } or { crashed: false }.
   */
  async isCrashed(pkg) {
    const raw = adbSilent(this._adb, '-s', this._s, 'logcat', '-d', '-s', 'AndroidRuntime:E');
    const lines = raw.split('\n').filter(l => l.includes(pkg));
    if (lines.length > 0) return { crashed: true, error: lines.join('\n') };
    return { crashed: false };
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

    // ── Fast path: ADB already knows about a live device ─────────────────────
    // Check BEFORE touching the SDK or AVD manager.
    // Works even when cmdline-tools / avdmanager are missing.
    try {
      const quickAdb = (() => {
        const r = getSdkRoot();
        return r ? getToolPaths(r).adb : 'adb';
      })();
      const serial = connectedDevice(quickAdb);
      if (serial) {
        process.stderr.write(`[dev-emulator] using existing device ${serial}\n`);
        const d = new Device(serial, quickAdb);
        _devices[name] = d;
        return d;
      }
    } catch { /* adb not available — fall through to SDK install */ }

    // ── Slow path: no device connected ───────────────────────────────────────
    // Run preflight first so users get clear errors (missing unzip, Java, etc.)
    // before we attempt any download.
    runPreflight();

    let sdkRoot = getSdkRoot();
    if (!sdkRoot) sdkRoot = await installSdk();

    const { adb: ADB, emulator: EMU } = getToolPaths(sdkRoot);
    const env = { ...process.env, ANDROID_HOME: sdkRoot, ANDROID_SDK_ROOT: sdkRoot };

    // ensureAvd auto-installs cmdline-tools if missing, picks the best
    // available system image, and creates the AVD if it doesn't exist yet.
    await ensureAvd(sdkRoot);

    process.stderr.write(`[dev-emulator] starting ${AVD_NAME} headlessly...\n`);
    spawn(EMU, ['-avd', AVD_NAME, '-no-window', '-no-audio', '-gpu', 'swiftshader_indirect'], {
      detached: true, stdio: 'ignore', env,
    }).unref();

    // Phase 1: wait up to 60s for emulator to appear in `adb devices`
    let serial = null;
    const deadline = Date.now() + 60000;
    while (!serial && Date.now() < deadline) {
      await sleep(2000);
      serial = connectedDevice(ADB);
    }
    if (!serial) throw new Error('Emulator did not appear in `adb devices` within 60s — try running dev-emulator again');

    // Phase 2: wait up to 180s for Android to finish booting
    await waitForBoot(ADB, serial);

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
    '  d.logcat(filter?, {lines?}) recent logcat lines (default 200)',
    '  d.clearLogcat()            clear logcat buffer',
    '  d.getUI()                  dump UI hierarchy → [{text, contentDesc, bounds}]',
    '  d.findAndTap(text)         find element by text/desc and tap it',
    '  d.waitForElement(text, {timeout?, interval?})  poll until element appears',
    '  d.isCrashed(pkg)           check for app crash → { crashed, error? }',
    '  d.home() | d.back()        home / back key',
    '  d.wake()                   wake screen',
    '  d.openNotifications()      pull down notification shade (adapts to screen height)',
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
