# dev-emulator

**Run and test Android apps from a script. No Android Studio, no phone, no setup.**

`dev-emulator` gives AI agents and developers a simple scripting interface to a real Android emulator. Install an APK, tap the screen, find UI elements, take screenshots, read logs — all from a heredoc. The Android SDK, emulator, and virtual device are bootstrapped automatically on first use.

Works on macOS and Linux. Supports Apple Silicon (arm64) and Intel/AMD (x86_64).

---

## Installation

```bash
npm install -g dev-emulator
```

**On install**, dev-emulator automatically copies the `android-agent` skill into any AI coding tool it finds:
- **Claude Code** → `~/.claude/skills/android-agent/skill.md`
- **Codex CLI** → `~/.codex/skills/android-agent/SKILL.md`
- **Gemini CLI** → `~/.gemini/config/plugins/android/skills/android-agent/SKILL.md`

If no AI tool is installed yet, a lightweight daily check is scheduled — it installs the skill automatically once a tool appears, then removes itself. The skill is also re-synced on every `dev-emulator` run, so reinstalling Claude/Codex/Gemini never leaves you without it.

**On first run**, if the Android SDK is not found, dev-emulator:
1. Runs preflight checks (Node 18+, `unzip` available, Java present)
2. Downloads Android command-line tools
3. Installs `platform-tools` (adb, ~10 MB) and checks if a device is already connected
4. If a device is found — starts immediately, skips the large image download
5. If no device — scans existing system images and picks the best one for your machine, or installs a fresh one

Every subsequent run is instant.

**Requirements:** Node.js 18+, macOS or Linux.

---

## Usage

Pipe a script via heredoc:

```bash
dev-emulator <<'EOF'
const d = await device.get();
await d.install("/path/to/app.apk");
await d.launch("com.example.app", ".MainActivity");
await d.sleep(8000);
const shot = await d.screenshot("home.png");
console.log(JSON.stringify({ screenshot: shot }));
EOF
```

Run `dev-emulator` with no input to see the full API reference.

---

## API

### `device.get(name?)`

Returns a `Device` instance. Checks for a running ADB device first — if one is connected, it's used immediately with no SDK setup. Only bootstraps the SDK when no device is found.

```js
const d = await device.get(); // optional name for caching multiple devices
```

### Device methods

| Method | Description |
|--------|-------------|
| `d.install(apkPath)` | Install an APK (re-installs if already present) |
| `d.launch(pkg, activity)` | Start an activity, e.g. `launch("com.example", ".MainActivity")` |
| `d.stop(pkg)` | Force-stop an app |
| `d.tap(x, y)` | Tap at device pixel coordinates |
| `d.swipe(x1, y1, x2, y2, ms?)` | Swipe gesture over optional duration in ms |
| `d.key(keycode)` | Send a keyevent, e.g. `"KEYCODE_BACK"` or `4` |
| `d.type(text)` | Type text (spaces auto-encoded) |
| `d.screenshot(name?)` | Capture a PNG — returns the local file path |
| `d.size()` | Screen dimensions `{ w, h }` in device pixels |
| `d.shell(...args)` | Run an adb shell command, returns stdout |
| `d.logcat(filter?, {lines?})` | Recent logcat lines (default 200), optionally filtered |
| `d.clearLogcat()` | Clear the logcat ring buffer |
| `d.getUI()` | UIAutomator dump → `[{text, contentDesc, bounds}]` |
| `d.findAndTap(text)` | Find element by text/desc and tap its center |
| `d.waitForElement(text, {timeout?, interval?})` | Poll until element appears, then return it |
| `d.isCrashed(pkg)` | Check for app crash → `{ crashed, error? }` |
| `d.notifications()` | Dump active notifications (raw dumpsys output) |
| `d.isInstalled(pkg)` | Returns `true` if a package is installed |
| `d.home()` | Press home |
| `d.back()` | Press back |
| `d.wake()` | Wake the screen |
| `d.openNotifications()` | Pull down the notification shade |
| `d.sleep(ms)` | Wait milliseconds |

> **Note:** `getUI()`, `findAndTap()`, and `waitForElement()` use Android UIAutomator and work on **native apps only**. WebView content (HTML rendered inside an app) is not visible to UIAutomator. For WebView apps, use `screenshot()` + visual inspection to find coordinates, then `tap(x, y)`.

---

## Examples

### Install, launch, and screenshot

```bash
dev-emulator <<'EOF'
const d = await device.get();
await d.install("/Users/me/app/app-debug.apk");
await d.launch("com.example.app", ".MainActivity");
await d.sleep(8000);
const shot = await d.screenshot("launch.png");
console.log(JSON.stringify({ screenshot: shot }));
EOF
```

### Find and tap a button by name (native apps)

```bash
dev-emulator <<'EOF'
const d = await device.get();
await d.launch("com.example.app", ".MainActivity");
await d.sleep(4000);

// Find "Sign In" button and tap it — no coordinates needed
await d.findAndTap("Sign In");
await d.sleep(3000);

const shot = await d.screenshot("after_signin.png");
console.log(JSON.stringify({ screenshot: shot }));
EOF
```

### Wait for a screen to load, then act

```bash
dev-emulator <<'EOF'
const d = await device.get();
await d.launch("com.example.app", ".MainActivity");

// Wait up to 15s for "Dashboard" to appear
const el = await d.waitForElement("Dashboard", { timeout: 15000 });
console.log(JSON.stringify({ found: "Dashboard", at: el.bounds }));

await d.tap(el.bounds.cx, el.bounds.cy);
await d.sleep(2000);

const shot = await d.screenshot("dashboard.png");
console.log(JSON.stringify({ screenshot: shot }));
EOF
```

### Check for crash after launch

```bash
dev-emulator <<'EOF'
const d = await device.get();
await d.clearLogcat();
await d.launch("com.example.app", ".MainActivity");
await d.sleep(5000);

const result = await d.isCrashed("com.example.app");
if (result.crashed) {
  console.log(JSON.stringify({ crashed: true, error: result.error }));
} else {
  const shot = await d.screenshot("running.png");
  console.log(JSON.stringify({ crashed: false, screenshot: shot }));
}
EOF
```

### Tap a button and verify (WebView or unknown coordinates)

```bash
dev-emulator <<'EOF'
const d = await device.get();
await d.launch("com.example.app", ".MainActivity");
await d.sleep(8000);

const { w, h } = await d.size();
await d.tap(w * 0.5, h * 0.8); // tap at 50% width, 80% height
await d.sleep(2000);

const shot = await d.screenshot("after_tap.png");
console.log(JSON.stringify({ screenshot: shot }));
EOF
```

### Check media notification after audio plays

```bash
dev-emulator <<'EOF'
const d = await device.get();
await d.launch("com.example.app", ".MainActivity");
await d.sleep(10000);

await d.openNotifications();
await d.sleep(1000);

const shot = await d.screenshot("notification.png");
console.log(JSON.stringify({ screenshot: shot }));
EOF
```

### Login to an app, then automate

```bash
dev-emulator <<'EOF'
const d = await device.get();

const installed = await d.isInstalled("com.example.app");
if (!installed) await d.install("/path/to/app.apk");

await d.launch("com.example.app", ".MainActivity");
await d.sleep(5000);

// For native apps: find fields by name
await d.findAndTap("Email");
await d.type("user@example.com");
await d.findAndTap("Password");
await d.type("yourpassword");
await d.findAndTap("Sign In");
await d.sleep(5000);

const shot = await d.screenshot("home_after_login.png");
console.log(JSON.stringify({ screenshot: shot }));
EOF
```

> **Tip for AI agent users:** You don't need to write scripts yourself. Just describe the goal — "log into the app and check the dashboard" — and Claude (or Codex/Gemini) will write and run the script, screenshot each step, and verify the result.

### Read logcat for debugging

```bash
dev-emulator <<'EOF'
const d = await device.get();
await d.clearLogcat();
await d.launch("com.example.app", ".MainActivity");
await d.sleep(8000);

const logs = await d.logcat("MyApp", { lines: 500 }); // filter by tag, last 500 lines
console.log(logs);
EOF
```

---

## How it works

1. `device.get()` checks for a running ADB device first — if one is connected (any emulator or physical device), it's used immediately.
2. If no device is connected, it checks `ANDROID_HOME`, `ANDROID_SDK_ROOT`, and default SDK paths.
3. If no SDK is found, it downloads command-line tools, installs `adb`, checks for a device again.
4. If still no device, installs the full emulator + Android 14 system image and creates a `Pixel_7a_dev_emulator` AVD.
5. Boots the AVD headlessly (no window, software GPU) and waits for `sys.boot_completed=1`.
6. Your script runs against the live device via ADB.

Screenshots are saved to `$TMPDIR/dev-emulator/` and can be read back with any file tool.

---

## Default emulator profile

| Property | Value |
|----------|-------|
| Device | Pixel 7a |
| API Level | 34 (Android 14) |
| Architecture | x86_64 |
| Screen | 1080 × 2400 |
| GPU | swiftshader (software, no host GPU required) |

---

## AI coding tool integration

When `dev-emulator` is installed, the `android-agent` skill is automatically copied into every supported AI coding tool on your machine. The skill gives the AI full knowledge of the ADB command set, coordinate scaling rules, the complete dev-emulator API, and common gotchas (WebView limitations, notification shade swipe distances, JS bridge timing).

Supported tools:
- **Claude Code** — `~/.claude/skills/android-agent/skill.md`
- **Codex CLI** — `~/.codex/skills/android-agent/SKILL.md`
- **Gemini CLI** — `~/.gemini/config/plugins/android/skills/android-agent/SKILL.md`

The skill is also re-synced on every `dev-emulator` run, so reinstalling Claude/Codex/Gemini never leaves you without it.

---

## License

MIT © [goyaljai](https://github.com/goyaljai)
