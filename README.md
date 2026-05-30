# dev-emulator

**Run and test Android apps from a script. No Android Studio, no phone, no setup.**

`dev-emulator` gives AI agents and developers a simple scripting interface to a real Android emulator. Install an APK, tap the screen, take screenshots, read logs — all from a one-liner heredoc. The Android SDK, emulator, and virtual device are bootstrapped automatically on first use.

Works on macOS and Linux.

---

## Installation

```bash
npm install -g dev-emulator
```

On first install:
- If **Claude Code** is installed, the `android-agent` skill is automatically added to `~/.claude/skills/` so Claude can drive Android apps immediately.
- If Claude Code is **not** installed, you'll see a note with the install link. Run `npm install -g dev-emulator` again after installing Claude to get the skill.

On first **run**, if the Android SDK is not found on your machine, dev-emulator downloads and installs it automatically (command-line tools, platform-tools, emulator, Android 14 system image). This takes a few minutes once — every subsequent run is instant.

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

Run `dev-emulator` with no input to print the full usage reference.

---

## API

### `device.get(name?)`

Returns a `Device` instance. On first call, bootstraps the SDK and AVD if needed, then boots the emulator headlessly. If an emulator or physical device is already connected via ADB, it's used immediately — no new emulator is started.

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
| `d.logcat(filter?)` | Last 200 logcat lines, optionally filtered by tag/text |
| `d.clearLogcat()` | Clear the logcat ring buffer |
| `d.notifications()` | Dump active notifications (raw dumpsys output) |
| `d.isInstalled(pkg)` | Returns `true` if a package is installed |
| `d.home()` | Press home |
| `d.back()` | Press back |
| `d.wake()` | Wake the screen |
| `d.openNotifications()` | Pull down the notification shade |
| `d.sleep(ms)` | Wait milliseconds |

---

## Examples

### Install, launch, and screenshot

```bash
dev-emulator <<'EOF'
const d = await device.get();

await d.install("/Users/me/app/app-debug.apk");
await d.launch("com.example.app", ".MainActivity");
await d.sleep(8000); // wait for app + network content to load

const shot = await d.screenshot("launch.png");
console.log(JSON.stringify({ screenshot: shot }));
EOF
```

### Tap a button and verify

```bash
dev-emulator <<'EOF'
const d = await device.get();
await d.launch("com.example.app", ".MainActivity");
await d.sleep(6000);

const { w, h } = await d.size(); // always check actual screen size first
await d.tap(w * 0.5, h * 0.8);   // tap at 50% width, 80% height
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
await d.sleep(10000); // wait for audio to start

await d.openNotifications();
await d.sleep(1000);

const shot = await d.screenshot("notification.png");
console.log(JSON.stringify({ screenshot: shot }));
EOF
```

### Read logcat for debugging

```bash
dev-emulator <<'EOF'
const d = await device.get();
await d.clearLogcat();
await d.launch("com.example.app", ".MainActivity");
await d.sleep(8000);

const logs = await d.logcat("MyApp"); // filter by tag
console.log(logs);
EOF
```

### Check if app is installed before testing

```bash
dev-emulator <<'EOF'
const d = await device.get();

const installed = await d.isInstalled("com.example.app");
if (!installed) {
  await d.install("/path/to/app.apk");
}

await d.launch("com.example.app", ".MainActivity");
await d.sleep(6000);

const shot = await d.screenshot("state.png");
console.log(JSON.stringify({ screenshot: shot }));
EOF
```

---

## How it works

1. `device.get()` checks `ANDROID_HOME`, `ANDROID_SDK_ROOT`, and the default SDK paths (`~/Library/Android/sdk` on macOS, `~/Android/Sdk` on Linux).
2. If no SDK is found, it downloads the Android command-line tools and installs platform-tools, the emulator, and the Android 14 x86_64 system image.
3. If the `Pixel_7a_dev_emulator` AVD doesn't exist, it creates one.
4. If a device is already connected (emulator or physical), it's used directly.
5. Otherwise, it starts the AVD headlessly (no window, software GPU) and waits for `sys.boot_completed=1`.
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

## Claude Code integration

When `dev-emulator` is installed, it automatically copies the `android-agent` skill into `~/.claude/skills/android-agent/skill.md`. Claude Code picks this up and gains full knowledge of the ADB command set, coordinate scaling rules, WebView JS bridge patterns, Android 13+ media notification fixes, and the complete dev-emulator API.

To use it, just describe what you want in Claude:

> "Install and test the APK at ~/app-debug.apk"

> "Check if the notification shows 'Now playing' after audio starts"

> "Tap the play button and screenshot the result"

Claude handles the full loop: install → launch → wait → screenshot → act → verify.

If Claude Code is not yet installed: https://claude.ai/code

---

## License

MIT © [goyaljai](https://github.com/goyaljai)
