# dev-emulator

**Android emulator automation for AI agents and developers.**

Run Android apps, tap UI elements, capture screenshots, and validate behaviour — all from a simple scripting interface. Works on any machine, even with no Android tooling installed. The SDK and emulator are bootstrapped automatically on first use.

---

## Why dev-emulator?

Testing Android apps typically requires Android Studio, a physical device, or careful SDK setup. dev-emulator removes all of that friction:

- **Zero setup** — no Android Studio, no SDK pre-installed. Everything downloads automatically.
- **Scriptable** — write plain JavaScript to drive any app.
- **AI-native** — designed for Claude and other agents to test, validate, and debug Android apps autonomously.
- **Headless** — runs silently in the background, no window needed.
- **Pixel 7a baseline** — consistent device profile across all runs.

---

## Installation

```bash
npm install -g dev-emulator
```

On first run, if Android SDK tools are not found, dev-emulator downloads and installs them automatically (command-line tools, platform-tools, emulator, system image). This takes a few minutes once, then all subsequent runs are instant.

**Requirements:** Node.js 18+, macOS or Linux (Windows coming soon).

---

## Usage

Scripts are piped via stdin using a heredoc:

```bash
dev-emulator <<'EOF'
const d = await device.get();
await d.install("/path/to/app.apk");
await d.launch("com.example.app", ".MainActivity");
await d.sleep(5000);
const shot = await d.screenshot("home.png");
console.log(JSON.stringify({ screenshot: shot }));
EOF
```

---

## API

### `device.get(name?)`

Returns a `Device` instance. Boots the emulator if not already running. Installs the SDK if not found.

```js
const d = await device.get("pixel7a"); // name is optional label for caching
```

### Device methods

| Method | Description |
|--------|-------------|
| `d.install(apkPath)` | Install an APK |
| `d.launch(pkg, activity)` | Start an activity |
| `d.stop(pkg)` | Force-stop an app |
| `d.tap(x, y)` | Tap screen coordinates |
| `d.swipe(x1, y1, x2, y2, ms?)` | Swipe gesture |
| `d.key(keycode)` | Send a keyevent (e.g. `KEYCODE_BACK`) |
| `d.type(text)` | Type text |
| `d.screenshot(name?)` | Take a screenshot, returns local file path |
| `d.size()` | Get screen size `{ w, h }` |
| `d.shell(...args)` | Run an adb shell command |
| `d.logcat(filter?)` | Read logcat, optionally filtered |
| `d.clearLogcat()` | Clear logcat buffer |
| `d.notifications()` | Dump active notifications |
| `d.isInstalled(pkg)` | Check if a package is installed |
| `d.home()` | Press home |
| `d.back()` | Press back |
| `d.wake()` | Wake the screen |
| `d.openNotifications()` | Pull down notification shade |
| `d.sleep(ms)` | Wait milliseconds |

---

## Examples

### Install and test an app

```bash
dev-emulator <<'EOF'
const d = await device.get();

// Install
await d.install("/Users/me/myapp/app-debug.apk");

// Launch
await d.launch("com.myapp", ".MainActivity");
await d.sleep(6000); // wait for network content

// Screenshot
const shot = await d.screenshot("launch.png");
console.log(JSON.stringify({ screenshot: shot }));

// Tap a button
const size = await d.size();
await d.tap(size.w * 0.5, size.h * 0.4);
await d.sleep(2000);

const shot2 = await d.screenshot("after_tap.png");
console.log(JSON.stringify({ screenshot: shot2 }));
EOF
```

### Check notification after audio plays

```bash
dev-emulator <<'EOF'
const d = await device.get();
await d.launch("com.fitoor.fm", ".MainActivity");
await d.sleep(8000);
await d.openNotifications();
await d.sleep(1000);
const shot = await d.screenshot("notifications.png");
console.log(JSON.stringify({ screenshot: shot }));
EOF
```

### Read logcat for debugging

```bash
dev-emulator <<'EOF'
const d = await device.get();
await d.clearLogcat();
await d.launch("com.myapp", ".MainActivity");
await d.sleep(5000);
const logs = await d.logcat("MyApp");
console.log(logs);
EOF
```

---

## How it works

1. On `device.get()`, dev-emulator checks for an existing ADB device or running emulator.
2. If none found, it starts the `Pixel_7a_dev_emulator` AVD headlessly.
3. If the AVD doesn't exist, it creates one.
4. If the Android SDK isn't installed, it downloads command-line tools and installs the required packages automatically.
5. Your script then runs against the device via ADB.

---

## Emulator spec

The default emulator profile is:

| Property | Value |
|----------|-------|
| Device | Pixel 7a |
| API Level | 34 (Android 14) |
| Architecture | x86_64 |
| Screen | 1080 × 2400 |
| GPU | swiftshader (software, no host GPU needed) |

---

## For AI agents (Claude)

Add this to your Claude skill or CLAUDE.md to enable Android testing:

```bash
dev-emulator <<'EOF'
const d = await device.get();
// ... your test script
EOF
```

Screenshots are saved to `$TMPDIR/dev-emulator/` and can be read back with the `Read` tool for visual verification.

---

## License

MIT © [goyaljai](https://github.com/goyaljai)
