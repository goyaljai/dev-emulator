#!/usr/bin/env node
import { existsSync, mkdirSync, copyFileSync, readFileSync } from 'fs';
import { execSync } from 'child_process';
import { homedir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HOME = homedir();

const skillSrc  = join(__dirname, '..', 'skills', 'android-agent.md');
const claudeDir = join(HOME, '.claude');
const skillDir  = join(claudeDir, 'skills', 'android-agent');
const skillDest = join(skillDir, 'skill.md');

function installSkill() {
  if (!existsSync(skillSrc)) return false;
  mkdirSync(skillDir, { recursive: true });
  const existing = existsSync(skillDest) ? readFileSync(skillDest, 'utf8') : '';
  const incoming = readFileSync(skillSrc, 'utf8');
  if (existing !== incoming) {
    copyFileSync(skillSrc, skillDest);
    return 'installed';
  }
  return 'uptodate';
}

// Label used to identify our cron entry so we can remove it later
const CRON_LABEL = '# dev-emulator skill watcher';

function hasCron() {
  try {
    const tab = execSync('crontab -l 2>/dev/null', { encoding: 'utf8' });
    return tab.includes(CRON_LABEL);
  } catch { return false; }
}

function addCron() {
  try {
    const checker = join(__dirname, 'skill-checker.js');
    const existing = (() => { try { return execSync('crontab -l 2>/dev/null', { encoding: 'utf8' }); } catch { return ''; } })();
    // Runs once per day at 9am — checks if Claude appeared, installs skill, then removes itself
    const entry = `0 9 * * * node "${checker}" ${CRON_LABEL}\n`;
    execSync(`(echo "${existing.trim()}" ; echo "${entry.trim()}") | crontab -`);
  } catch { /* non-fatal */ }
}

function removeCron() {
  try {
    const existing = execSync('crontab -l 2>/dev/null', { encoding: 'utf8' });
    const filtered = existing.split('\n')
      .filter(l => !l.includes(CRON_LABEL) && l.trim() !== '')
      .join('\n');
    if (filtered.trim()) {
      execSync(`echo "${filtered}" | crontab -`);
    } else {
      execSync('crontab -r 2>/dev/null || true');
    }
  } catch { /* non-fatal */ }
}

if (existsSync(claudeDir)) {
  // Claude is installed — install skill, remove watcher if it was running
  const result = installSkill();
  if (result === 'installed') console.log('✅ android-agent skill installed → ~/.claude/skills/android-agent/skill.md\n');
  else if (result === 'uptodate') console.log('✅ android-agent skill is already up to date.\n');
  removeCron(); // clean up watcher if it was set
} else {
  // Claude not installed yet — set a daily watcher that self-destructs once Claude appears
  console.log('ℹ️  Claude Code is not installed yet.');
  console.log('   Install it at: https://claude.ai/code');
  console.log('   The android-agent skill will be installed automatically once Claude is detected.\n');
  if (!hasCron()) {
    addCron();
    console.log('   (A daily check has been scheduled — it removes itself once Claude is found.)\n');
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
