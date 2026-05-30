#!/usr/bin/env node
// Called daily by cron when no AI tool was installed at npm install time.
// Checks for claude/codex, installs skill into each, then removes itself from crontab.
import { existsSync, mkdirSync, copyFileSync, readFileSync, writeFileSync } from 'fs';
import { execSync } from 'child_process';
import { homedir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HOME      = homedir();
const skillSrc  = join(__dirname, '..', 'skills', 'android-agent.md');
const CRON_LABEL = '# dev-emulator skill watcher';

function isBinaryInstalled(name) {
  try { execSync(`which ${name}`, { stdio: 'pipe' }); return true; } catch { return false; }
}

function installForClaude() {
  if (!existsSync(skillSrc)) return;
  const dest = join(HOME, '.claude', 'skills', 'android-agent', 'skill.md');
  mkdirSync(dirname(dest), { recursive: true });
  const existing = existsSync(dest) ? readFileSync(dest, 'utf8') : '';
  if (existing !== readFileSync(skillSrc, 'utf8')) copyFileSync(skillSrc, dest);
}

function installForCodex() {
  if (!existsSync(skillSrc)) return;
  const dest = join(HOME, '.codex', 'skills', 'android-agent', 'SKILL.md');
  mkdirSync(dirname(dest), { recursive: true });
  const existing = existsSync(dest) ? readFileSync(dest, 'utf8') : '';
  if (existing !== readFileSync(skillSrc, 'utf8')) copyFileSync(skillSrc, dest);
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
}

function installForGemini() {
  if (!existsSync(skillSrc)) return;
  const dest = join(HOME, '.gemini', 'config', 'plugins', 'android', 'skills', 'android-agent', 'SKILL.md');
  mkdirSync(dirname(dest), { recursive: true });
  const existing = existsSync(dest) ? readFileSync(dest, 'utf8') : '';
  if (existing !== readFileSync(skillSrc, 'utf8')) copyFileSync(skillSrc, dest);
}

const claudeFound = isBinaryInstalled('claude');
const codexFound  = isBinaryInstalled('codex');
const geminiFound = isBinaryInstalled('agy');

if (!claudeFound && !codexFound && !geminiFound) process.exit(0); // still nothing, check again tomorrow

try { if (claudeFound) installForClaude(); } catch { /* non-fatal */ }
try { if (codexFound)  installForCodex();  } catch { /* non-fatal */ }
try { if (geminiFound) installForGemini(); } catch { /* non-fatal */ }

// Remove ourselves from crontab
try {
  const tab = execSync('crontab -l 2>/dev/null', { encoding: 'utf8' });
  const filtered = tab.split('\n').filter(l => !l.includes(CRON_LABEL) && l.trim()).join('\n');
  if (filtered.trim()) { execSync(`echo ${JSON.stringify(filtered + '\n')} | crontab -`); }
  else { execSync('crontab -r 2>/dev/null || true'); }
} catch { /* non-fatal */ }
