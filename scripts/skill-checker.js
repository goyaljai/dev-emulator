#!/usr/bin/env node
// Called daily by cron when Claude was not installed at npm install time.
// Once Claude binary is detected, installs the skill and removes itself from crontab.
import { existsSync, mkdirSync, copyFileSync, readFileSync } from 'fs';
import { execSync } from 'child_process';
import { homedir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HOME      = homedir();
const skillSrc  = join(__dirname, '..', 'skills', 'android-agent.md');
const skillDir  = join(HOME, '.claude', 'skills', 'android-agent');
const skillDest = join(skillDir, 'skill.md');
const CRON_LABEL = '# dev-emulator skill watcher';

// Check for claude binary, not ~/.claude directory
function claudeInstalled() {
  try { execSync('which claude', { stdio: 'pipe' }); return true; } catch { return false; }
}

if (!claudeInstalled()) process.exit(0); // not yet, check again tomorrow

// Claude is now installed — copy skill
try {
  if (existsSync(skillSrc)) {
    mkdirSync(skillDir, { recursive: true });
    const existing = existsSync(skillDest) ? readFileSync(skillDest, 'utf8') : '';
    const incoming = readFileSync(skillSrc, 'utf8');
    if (existing !== incoming) copyFileSync(skillSrc, skillDest);
  }
} catch { /* non-fatal */ }

// Remove ourselves from crontab
try {
  const tab = execSync('crontab -l 2>/dev/null', { encoding: 'utf8' });
  const filtered = tab.split('\n').filter(l => !l.includes(CRON_LABEL) && l.trim()).join('\n');
  if (filtered.trim()) { execSync(`echo ${JSON.stringify(filtered + '\n')} | crontab -`); }
  else { execSync('crontab -r 2>/dev/null || true'); }
} catch { /* non-fatal */ }
