#!/usr/bin/env node
import { existsSync, mkdirSync, copyFileSync, readFileSync, writeFileSync } from 'fs';
import { execSync } from 'child_process';
import { homedir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HOME = homedir();
const skillSrc = join(__dirname, '..', 'skills', 'android-agent.md');

// ── Tool detection ─────────────────────────────────────────────────────────────
// Search PATH directories directly in Node — avoids depending on `which` being available
function isBinaryInstalled(name) {
  const dirs = (process.env.PATH || '').split(':');
  return dirs.some(dir => existsSync(join(dir, name)));
}

// ── Skill installers ──────────────────────────────────────────────────────────
function installForClaude() {
  if (!existsSync(skillSrc)) return false;
  const dest = join(HOME, '.claude', 'skills', 'android-agent', 'skill.md');
  mkdirSync(dirname(dest), { recursive: true });
  const existing = existsSync(dest) ? readFileSync(dest, 'utf8') : '';
  const incoming = readFileSync(skillSrc, 'utf8');
  if (existing === incoming) return 'uptodate';
  copyFileSync(skillSrc, dest);
  return 'installed';
}

function installForCodex() {
  if (!existsSync(skillSrc)) return false;
  const dest = join(HOME, '.codex', 'skills', 'android-agent', 'SKILL.md');
  mkdirSync(dirname(dest), { recursive: true });
  const existing = existsSync(dest) ? readFileSync(dest, 'utf8') : '';
  const incoming = readFileSync(skillSrc, 'utf8');
  if (existing !== incoming) copyFileSync(skillSrc, dest);
  const cfg = join(HOME, '.codex', 'config.toml');
  if (existsSync(cfg)) {
    let content = readFileSync(cfg, 'utf8');
    if (!content.includes('skills = true')) {
      content = content.includes('[features]')
        ? content.replace('[features]', '[features]\nskills = true')
        : content + '\n[features]\nskills = true\n';
      writeFileSync(cfg, content, 'utf8');
    }
  }
  return existing === incoming ? 'uptodate' : 'installed';
}

function installForGemini() {
  // Gemini CLI (agy) uses ~/.gemini/config/plugins/<plugin>/skills/<skill>/SKILL.md
  if (!existsSync(skillSrc)) return false;
  const dest = join(HOME, '.gemini', 'config', 'plugins', 'android', 'skills', 'android-agent', 'SKILL.md');
  mkdirSync(dirname(dest), { recursive: true });
  const existing = existsSync(dest) ? readFileSync(dest, 'utf8') : '';
  const incoming = readFileSync(skillSrc, 'utf8');
  if (existing !== incoming) copyFileSync(skillSrc, dest);
  return existing === incoming ? 'uptodate' : 'installed';
}

// ── Cron (self-destructing watcher when no AI tool installed yet) ─────────────
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

// ── Main ──────────────────────────────────────────────────────────────────────
const claudeFound = isBinaryInstalled('claude');
const codexFound  = isBinaryInstalled('codex');
const geminiFound = isBinaryInstalled('agy');
const anyFound    = claudeFound || codexFound || geminiFound;

if (anyFound) {
  removeCron();
  if (claudeFound) {
    const r = installForClaude();
    if (r === 'installed')  console.log('✅ android-agent skill installed → ~/.claude/skills/android-agent/skill.md');
    if (r === 'uptodate')   console.log('✅ android-agent skill up to date (Claude Code)');
  }
  if (codexFound) {
    const r = installForCodex();
    if (r === 'installed')  console.log('✅ android-agent skill installed → ~/.codex/skills/android-agent/SKILL.md');
    if (r === 'uptodate')   console.log('✅ android-agent skill up to date (Codex CLI)');
  }
  if (geminiFound) {
    const r = installForGemini();
    if (r === 'installed')  console.log('✅ android-agent skill installed → ~/.gemini/config/plugins/android/skills/android-agent/SKILL.md');
    if (r === 'uptodate')   console.log('✅ android-agent skill up to date (Gemini CLI)');
  }
  console.log('');
} else {
  console.log('ℹ️  No AI coding tool detected (Claude Code, Codex CLI, or Gemini CLI).');
  console.log('   Install one to get the android-agent skill automatically:');
  console.log('   Claude Code → https://claude.ai/code');
  console.log('   Codex CLI   → https://github.com/openai/codex');
  console.log('   Gemini CLI  → https://github.com/google-gemini/gemini-cli');
  console.log('   The skill will be installed the next time dev-emulator runs.\n');
  if (!hasCron()) {
    addCron();
    console.log('   (A daily check has been scheduled — it self-destructs once a tool is found.)\n');
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
