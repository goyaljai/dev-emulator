#!/usr/bin/env node
import { existsSync, mkdirSync, copyFileSync, readFileSync } from 'fs';
import { execSync } from 'child_process';
import { homedir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HOME = homedir();

const skillSrc  = join(__dirname, '..', 'skills', 'android-agent.md');
const skillDir  = join(HOME, '.claude', 'skills', 'android-agent');
const skillDest = join(skillDir, 'skill.md');

// Detect Claude Code by looking for the `claude` binary — NOT by checking ~/.claude
// because mkdirSync would create that directory, making the check meaningless.
function claudeInstalled() {
  try { execSync('which claude', { stdio: 'pipe' }); return true; } catch { return false; }
}

function installSkill() {
  if (!existsSync(skillSrc)) return false;
  mkdirSync(skillDir, { recursive: true });
  const existing = existsSync(skillDest) ? readFileSync(skillDest, 'utf8') : '';
  const incoming = readFileSync(skillSrc, 'utf8');
  if (existing !== incoming) { copyFileSync(skillSrc, skillDest); return 'installed'; }
  return 'uptodate';
}

const CRON_LABEL = '# dev-emulator skill watcher';

function hasCron() {
  try { return execSync('crontab -l 2>/dev/null', { encoding: 'utf8' }).includes(CRON_LABEL); }
  catch { return false; }
}

function addCron() {
  try {
    const checker = join(__dirname, 'skill-checker.js');
    const existing = (() => { try { return execSync('crontab -l 2>/dev/null', { encoding: 'utf8' }); } catch { return ''; } })();
    const entry = `0 9 * * * node "${checker}" ${CRON_LABEL}`;
    const newTab = [existing.trim(), entry].filter(Boolean).join('\n') + '\n';
    execSync(`echo ${JSON.stringify(newTab)} | crontab -`);
  } catch { /* non-fatal */ }
}

function removeCron() {
  try {
    const existing = execSync('crontab -l 2>/dev/null', { encoding: 'utf8' });
    const filtered = existing.split('\n').filter(l => !l.includes(CRON_LABEL) && l.trim()).join('\n');
    if (filtered.trim()) { execSync(`echo ${JSON.stringify(filtered + '\n')} | crontab -`); }
    else { execSync('crontab -r 2>/dev/null || true'); }
  } catch { /* non-fatal */ }
}

if (claudeInstalled()) {
  const result = installSkill();
  if (result === 'installed') console.log('✅ android-agent skill installed → ~/.claude/skills/android-agent/skill.md\n');
  else if (result === 'uptodate') console.log('✅ android-agent skill is already up to date.\n');
  removeCron();
} else {
  console.log('ℹ️  Claude Code is not installed yet.');
  console.log('   Install it at: https://claude.ai/code');
  console.log('   The android-agent skill will be installed automatically once Claude is detected.\n');
  if (!hasCron()) {
    addCron();
    console.log('   (A daily check has been scheduled — it self-destructs once Claude is found.)\n');
  }
}

console.log('✅ dev-emulator installed.\n');
console.log('Usage:');
console.log("  dev-emulator <<'EOF'");
console.log('  const d = await device.get();');
console.log('  await d.install("/path/to/app.apk");');
console.log('  await d.launch("com.example", ".MainActivity");');
console.log('  await d.sleep(8000);');
console.log('  const shot = await d.screenshot("home.png");');
console.log('  console.log(JSON.stringify({ screenshot: shot }));');
console.log('  EOF\n');
console.log('On first use, Android SDK is downloaded automatically if not found.\n');
