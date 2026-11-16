const path = require("node:path");
module.exports = {
  appId: "org.relayvideo.studio",
  productName: "Relay",
  asar: false,
  directories: { output: "release" },
  files: [
    "dist/**/*",
    "server/**/*",
    "desktop/**/*",
    "package.json",
    "LICENSE",
    "THIRD_PARTY_NOTICES.md",
    "public/fonts/**/*",
    "vendor/ffmpeg/NOTICE.md",
    // FFmpeg is downloaded on first launch, never bundled (see desktop/engine.cjs).
    "!vendor/ffmpeg/*/**",
    "!node_modules/ffmpeg-static/ffmpeg",
    // Transformers' Node build embeds what it needs from onnxruntime-web.
    "!node_modules/onnxruntime-web/**",
    "!node_modules/onnxruntime-node/bin/napi-v*/{linux,win32}/**",
    // Prebuilt add-ons for other systems are never loaded on a Mac.
    "!node_modules/**/prebuilds/{ios,android,linux,win32}*/**",
    "!**/*.map",
    "!node_modules/ffmpeg-static/ffmpeg.exe",
  ],
  mac: {
    category: "public.app-category.productivity",
    icon: "desktop/icon.icns",
    target: [
      { target: "dmg", arch: ["arm64", "x64"] },
      { target: "zip", arch: ["arm64", "x64"] },
    ],
    // A version-free name gives a permanent "latest" download link.
    artifactName: "Relay-mac-${arch}.${ext}",
    identity: process.env.RELAY_SIGN_IDENTITY || "-",
    hardenedRuntime: true,
    entitlements: "desktop/entitlements/mac.plist",
    entitlementsInherit: "desktop/entitlements/mac.plist",
    extendInfo: {
      NSCameraUsageDescription:
        "Relay records your camera when you choose camera capture.",
      NSMicrophoneUsageDescription:
        "Relay records your microphone when you turn it on.",
      NSScreenCaptureUsageDescription:
        "Relay records the display, window or region you select.",
      NSAudioCaptureUsageDescription:
        "Relay captures system audio only when you enable it.",
    },
  },
  dmg: {
    title: "Install Relay",
    format: "ULFO",
    background: "desktop/dmg/background.png",
    iconSize: 96,
    window: { width: 600, height: 400 },
    contents: [
      { x: 160, y: 200, type: "file" },
      { x: 440, y: 200, type: "link", path: "/Applications" },
    ],
  },
  win: { target: ["nsis"] },
  nsis: { oneClick: false, allowToChangeInstallationDirectory: true },
  linux: { target: ["AppImage"], category: "AudioVideo" },
  publish: process.env.RELAY_UPDATE_URL
    ? [{ provider: "generic", url: process.env.RELAY_UPDATE_URL }]
    : undefined,
  afterPack: async (context) => {
    const fs = require("node:fs");
    const base =
      context.electronPlatformName === "darwin"
        ? path.join(context.appOutDir, "Relay.app", "Contents", "Resources", "app")
        : path.join(context.appOutDir, "resources", "app");
    const engines = path.join(base, "vendor", "ffmpeg");
    const bundled =
      fs.existsSync(engines) &&
      fs.readdirSync(engines, { withFileTypes: true }).some((e) => e.isDirectory());
    if (bundled || fs.existsSync(path.join(base, "node_modules", "ffmpeg-static", "ffmpeg")))
      throw new Error("Packages must not bundle an FFmpeg binary; Relay downloads it on first launch.");
  },
};
