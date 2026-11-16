const path = require("node:path");

// Shared by Relay's auxiliary windows (recording surfaces, toolbar, region picker,
// engine setup). They get a restricted preload and no Node access.
exports.secure = (preload) => ({
  preload: path.join(__dirname, preload),
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: true,
});

// They never navigate away or open further windows.
exports.lock = (win) => {
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (e) => e.preventDefault());
};

// Recording surfaces must float above other apps' full-screen spaces. While one is
// showing, macOS treats Relay as an accessory app and hides its Dock icon; the icon
// is put back when the surfaces are closed.
exports.onAllSpaces = (win) =>
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
