#!/usr/bin/env node
// Called daily by cron when Claude was not installed at npm install time.
// Once Claude is detected, installs the skill and removes the cron entry.
import { existsSync, mkdirSync, copyFileSync, readFileSync } from 'fs';
import { execSync } from 'child_process';
import { homedir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HOME      = join(homedir());
const claudeDir = join(HOME, '.claude');
const skillSrc  = join(__dirname, '..', 'skills', 'android-agent.md');
const skillDir  = join(claudeDir, 'skills', 'android-agent');
const skillDest = join(skillDir, 'skill.md');
const CRON_LABEL = '# dev-emulator skill watcher';

if (!existsSync(claudeDir)) process.exit(0); // Claude still not installed, check again tomorrow

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
  const filtered = tab.split('\n')
    .filter(l => !l.includes(CRON_LABEL) && l.trim() !== '')
    .join('\n');
  if (filtered.trim()) {
    execSync(`echo "${filtered}" | crontab -`);
  } else {
    execSync('crontab -r 2>/dev/null || true');
  }
} catch { /* non-fatal */ }
