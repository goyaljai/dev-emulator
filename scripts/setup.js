#!/usr/bin/env node
import { existsSync, mkdirSync, copyFileSync, readFileSync } from 'fs';
import { homedir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HOME = homedir();

// Install android-agent skill into ~/.claude/skills/android-agent/
// so Claude Code picks it up automatically.
const skillSrc  = join(__dirname, '..', 'skills', 'android-agent.md');
const skillDir  = join(HOME, '.claude', 'skills', 'android-agent');
const skillDest = join(skillDir, 'skill.md');

try {
  if (existsSync(skillSrc)) {
    mkdirSync(skillDir, { recursive: true });
    // Only install if the file doesn't exist or the new version is different
    const existing = existsSync(skillDest) ? readFileSync(skillDest, 'utf8') : '';
    const incoming = readFileSync(skillSrc, 'utf8');
    if (existing !== incoming) {
      copyFileSync(skillSrc, skillDest);
      console.log('✅ dev-emulator: installed android-agent skill into ~/.claude/skills/android-agent/skill.md');
    }
  }
} catch (e) {
  // Non-fatal — skill install is best-effort
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
