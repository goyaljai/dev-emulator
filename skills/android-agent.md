---
name: android-agent
description: Android app automation via ADB and dev-emulator. Use when asked to: install/launch/test Android apps, tap UI elements, capture screenshots, check logcat, verify notifications, interact with emulator or device, or automate any Android testing workflow. Trigger phrases: "install and test", "tap [element]", "launch the app", "check the emulator", "screenshot the app", "verify on device", "adb", "test on Android", "check notification", "logcat".
allowed-tools: Bash, Read
---

# Android Agent

ADB-powered Android automation. Works with any connected emulator or physical device. Use `dev-emulator` for zero-setup headless testing on machines without Android Studio.

## Core Principles

- **Always check device first** — run `adb devices` before any action to confirm a device is connected.
- **One action per step** — install, launch, tap, screenshot, verify. Don't chain blind sequences.
- **Screenshot to verify** — after every interaction, screencap + pull + Read to confirm what happened.
- **Scale coordinates to real size** — always `adb shell wm size` first. Default Pixel 7a is 1080×2400. Displayed images are often scaled down — the image metadata shows "Multiply coordinates by X.XX to map to original image". Always apply that multiplier before tapping.
- **Logcat is your console.log** — use `adb logcat -d` with tag filters to debug JS bridge issues, crashes, or silent failures.

## Execution Pattern

```
1. check      → adb devices (confirm connected)
2. install    → adb install -r app.apk
3. clear log  → adb logcat -c
4. launch     → adb shell am force-stop pkg && adb shell am start -n pkg/.Activity
5. wait       → sleep 8 (WebView needs 6-8s for network content to load)
6. screenshot → adb shell screencap -p /sdcard/s.png && adb pull /sdcard/s.png /tmp/s.png
7. read       → Read /tmp/s.png (visually verify state)
8. act        → adb shell input tap X Y  (coordinates in DEVICE pixels, not display pixels)
9. verify     → repeat screenshot → Read
```

## dev-emulator (zero-setup automation)

`dev-emulator` bootstraps the entire Android SDK, creates a Pixel 7a AVD, and boots it headlessly — no Android Studio required. Works on macOS and Linux.

```bash
# Install once
npm install -g dev-emulator

# Run a script
dev-emulator <<'EOF'
const d = await device.get();
await d.install("/path/to/app.apk");
await d.launch("com.example.app", ".MainActivity");
await d.sleep(8000);
const shot = await d.screenshot("launch.png");
console.log(JSON.stringify({ screenshot: shot }));
EOF
```

Screenshots are saved to `$TMPDIR/dev-emulator/` — read them with the Read tool for visual verification.

If an emulator or device is already running when `device.get()` is called, dev-emulator uses it immediately without booting a new one.

## Key Commands

### Device & App
```bash
adb devices                                          # list connected devices
adb shell wm size                                    # get screen resolution (always do this first)
adb install -r app.apk                               # install (replace existing)
adb uninstall com.package.name                       # uninstall
adb shell pm list packages | grep keyword            # find installed package
adb shell am start -n com.pkg/.MainActivity          # launch activity
adb shell am force-stop com.pkg                      # kill app
```

### Full restart (not just relaunch)
```bash
adb logcat -c
adb shell am force-stop com.pkg
sleep 1
adb shell am start -n com.pkg/.MainActivity
```

### Screenshots
```bash
adb shell screencap -p /sdcard/s.png && adb pull /sdcard/s.png /tmp/s.png
```

### Input — coordinate rules
```bash
adb shell wm size                        # e.g. Physical size: 1080x2400

# Tap in DEVICE pixels (not the display-scaled image pixels)
adb shell input tap 540 1920

# Swipe
adb shell input swipe X1 Y1 X2 Y2 DURATION_MS

# Pull down notification shade — swipe from near top (y=50) to far bottom (y=1500+)
# Short swipes (y=0 to y=800) DO NOT reliably open the shade on 2400px screens
adb shell input swipe 540 50 540 1500 400

# Keys
adb shell input keyevent KEYCODE_BACK
adb shell input keyevent KEYCODE_HOME
adb shell input keyevent KEYCODE_WAKEUP
adb shell input text "hello%sworld"      # spaces encoded as %s
```

### Logcat
```bash
adb logcat -c                            # clear buffer before test
adb logcat -d -s AndroidRuntime:E        # crash logs only
adb logcat -d | grep -i "MyApp"          # tag filter
adb logcat -d | tail -50                 # most recent lines
```

### Notifications
```bash
adb shell dumpsys notification --noredact | grep -A10 "com.pkg"
adb shell input swipe 540 50 540 1500 400   # open shade (long swipe required)
sleep 1
adb shell screencap -p /sdcard/shade.png && adb pull /sdcard/shade.png /tmp/shade.png
```

## Common Gotchas

- **Tap coordinates are wrong**: Images in Claude are often scaled down 2-4x. The image metadata says "Multiply coordinates by X.XX" — always apply that multiplier. Use `adb shell wm size` to confirm device resolution.
- **Notification shade doesn't open**: `swipe 540 0 540 800` is too short on 2400px screens. Use `swipe 540 50 540 1500 400`.
- **WebView taps miss**: Content starts below the status bar (~100px on 2400px screen). Adjust Y coordinates accordingly.
- **WebView loads slowly**: Always sleep 6-8s after launching a WebView app. SPA frameworks (React/Next.js) need extra time to hydrate.
- **JS bridge not firing**: Inject bridge JS 3s after `onPageFinished` — SPAs replace the DOM after the initial load event. Verify with `adb logcat -d | grep "typeof AndroidBridge"`.
- **Notification not showing**: Check `adb shell dumpsys notification`. Media notifications require `MediaSession` active AND `NotificationChannel` created.
- **Spurious pause events**: WebView audio fires `pause` on init. Guard: ignore pause events within 2s of `onPageFinished`.
- **`am start` reuses existing task**: Always `am force-stop` before `am start` for a clean relaunch.

## Android 13+ Media Notification — Play/Pause Button Fix

Raw `ACTION_MEDIA_BUTTON` broadcasts do NOT route to `MediaSession.Callback` on Android 13+. Notification buttons silently do nothing.

**Fix — AndroidManifest.xml:**
```xml
<receiver android:name="androidx.media.session.MediaButtonReceiver" android:exported="true">
    <intent-filter>
        <action android:name="android.intent.action.MEDIA_BUTTON" />
    </intent-filter>
</receiver>
```

**Fix — Kotlin:**
```kotlin
import androidx.media.session.MediaButtonReceiver

val actionIntent = MediaButtonReceiver.buildMediaButtonPendingIntent(
    this,
    if (isPlaying) PlaybackStateCompat.ACTION_PAUSE else PlaybackStateCompat.ACTION_PLAY
)
```

## WebView JS Bridge Pattern

```kotlin
// Register bridge before loadUrl()
addJavascriptInterface(MyBridge(), "AndroidBridge")

// Inject 3s after page load (SPA hydration delay)
override fun onPageFinished(view: WebView, url: String) {
    view.postDelayed({ view.evaluateJavascript(bridgeJs, null) }, 3000)
}
```

```javascript
(function() {
    var pageLoadTime = Date.now();
    var lastState = null;
    function attach(el) {
        if (el._wired) return; el._wired = true;
        el.addEventListener('play', () => AndroidBridge.onPlay());
        el.addEventListener('pause', () => {
            if (Date.now() - pageLoadTime < 2000) return;
            if (el.paused && !el.ended) AndroidBridge.onPause();
        });
    }
    document.querySelectorAll('audio,video').forEach(attach);
    new MutationObserver(() => document.querySelectorAll('audio,video').forEach(attach))
        .observe(document.documentElement, { childList: true, subtree: true });
    setInterval(() => {
        var el = document.querySelector('audio,video');
        if (!el) return;
        var playing = !el.paused && !el.ended && el.readyState > 2;
        if (playing && lastState !== 'play') { lastState='play'; AndroidBridge.onPlay(); }
        else if (!playing && lastState === 'play') { lastState='pause'; AndroidBridge.onPause(); }
    }, 2000);
})();
```

## Build & Deploy Loop (Android Gradle)

```bash
# Debug APK
./gradlew assembleDebug 2>&1 | tail -8
adb install -r app/build/outputs/apk/debug/app-debug.apk
adb logcat -c
adb shell am force-stop com.example.app
sleep 1
adb shell am start -n com.example.app/.MainActivity
sleep 8
adb shell screencap -p /sdcard/test.png && adb pull /sdcard/test.png /tmp/test.png

# Release AAB (signed, for Play Store)
./gradlew bundleRelease
# Output: app/build/outputs/bundle/release/app-release.aab
```
