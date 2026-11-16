const {
  BrowserWindow,
  ipcMain,
  screen,
  systemPreferences,
  Notification,
  powerSaveBlocker,
  app,
} = require("electron");
const path = require("node:path");
const os = require("node:os");

// Auxiliary windows have a dedicated, restricted preload. They never load remote content.
module.exports = function attachStudio({
  trusted,
  window,
  captureBounds,
  onActive = () => {},
  onState = () => {},
  onAction = () => false,
}) {
  let toolbar,
    regionWindow,
    timer,
    blocker,
    state = { active: false },
    extras = {},
    region;
  const send = (action) => window()?.webContents.send("relay:control", action);
  const dispose = () => {
    clearInterval(timer);
    timer = undefined;
    toolbar?.destroy();
    toolbar = undefined;
    if (blocker !== undefined && powerSaveBlocker.isStarted(blocker))
      powerSaveBlocker.stop(blocker);
    blocker = undefined;
  };
  const secure = {
    preload: path.join(__dirname, "controls-preload.cjs"),
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
  };
  function openToolbar() {
    const display = screen.getDisplayNearestPoint(
      screen.getCursorScreenPoint(),
    );
    toolbar = new BrowserWindow({
      width: 420,
      height: 205,
      x: display.workArea.x + display.workArea.width - 400,
      y: display.workArea.y + 24,
      frame: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      resizable: false,
      show: false,
      backgroundColor: "#20281d",
      webPreferences: secure,
    });
    toolbar.setAlwaysOnTop(true, "screen-saver", 3);
    toolbar.setContentProtection(true);
    toolbar.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    toolbar.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    toolbar.webContents.on("will-navigate", (e) => e.preventDefault());
    void toolbar.loadFile(path.join(__dirname, "controls.html")).then(() => {
      toolbar?.webContents.send("relay:state", { ...state, ...extras });
      toolbar?.showInactive();
    });
    toolbar.on("closed", () => {
      toolbar = undefined;
    });
  }
  ipcMain.on("relay:capture-state", (event, value) => {
    if (!trusted(event) || !value || typeof value.active !== "boolean") return;
    const wasActive = state.active;
    state = {
      active: value.active,
      paused: !!value.paused,
      seconds: Math.max(0, Number(value.seconds) || 0),
      notes: String(value.notes || "").slice(0, 10000),
    };
    onState(state);
    // "Inactive" always runs the teardown, so a failed or abandoned start can
    // never leave the studio hidden or the camera bubble on.
    if (wasActive !== state.active || !state.active) onActive(state.active);
    if (!state.active) {
      extras = {};
      return dispose();
    }
    if (!toolbar) openToolbar();
    toolbar?.webContents.send("relay:state", { ...state, ...extras });
    if (blocker === undefined)
      blocker = powerSaveBlocker.start("prevent-display-sleep");
    if (!timer)
      timer = setInterval(() => {
        if (state.paused) return;
        const bounds = captureBounds();
        if (!bounds) return;
        const p = screen.getCursorScreenPoint();
        const r = region || { x: 0, y: 0, w: 1, h: 1 };
        const x = ((p.x - bounds.x) / bounds.width - r.x) / r.w;
        const y = ((p.y - bounds.y) / bounds.height - r.y) / r.h;
        if (x >= 0 && x <= 1 && y >= 0 && y <= 1)
          window()?.webContents.send("relay:pointer", { x, y });
      }, 150);
  });
  ipcMain.on("relay:control-action", (event, action) => {
    if (
      event.sender !== toolbar?.webContents ||
      !["pause", "stop", "retake", "studio", "cancel", "draw"].includes(action)
    )
      return;
    if (onAction(action)) return;
    if (action === "studio") {
      window()?.show();
      window()?.focus();
    } else send(action);
  });
  ipcMain.handle("relay:region", async (event, sourceId) => {
    if (!trusted(event)) throw new Error("Untrusted capture request");
    if (!String(sourceId).startsWith("screen:"))
      throw new Error(
        "Choose an entire display to select a region. Window capture already records just that window.",
      );
    const bounds = captureBounds();
    if (!bounds) throw new Error("Select a display first.");
    if (regionWindow) throw new Error("A region selector is already open.");
    return new Promise((resolve) => {
      let result = null;
      regionWindow = new BrowserWindow({
        ...bounds,
        frame: false,
        transparent: true,
        alwaysOnTop: true,
        skipTaskbar: true,
        resizable: false,
        hasShadow: false,
        // Cover the whole display, menu bar included, so fractions match the capture.
        enableLargerThanScreen: true,
        webPreferences: secure,
      });
      regionWindow.setAlwaysOnTop(true, "screen-saver");
      regionWindow.setBounds(bounds);
      regionWindow.setContentProtection(true);
      const choose = (e, value) => {
        if (e.sender !== regionWindow?.webContents) return;
        if (
          value &&
          ["x", "y", "w", "h"].every((k) => Number.isFinite(value[k])) &&
          value.x >= 0 &&
          value.y >= 0 &&
          value.w >= 0.01 &&
          value.h >= 0.01 &&
          value.x + value.w <= 1.001 &&
          value.y + value.h <= 1.001
        )
          result = value;
        regionWindow?.close();
      };
      ipcMain.on("relay:region-result", choose);
      regionWindow.once("closed", () => {
        ipcMain.removeListener("relay:region-result", choose);
        regionWindow = undefined;
        region = result;
        resolve(result);
      });
      void regionWindow.loadFile(path.join(__dirname, "region.html"));
    });
  });
  ipcMain.handle("relay:permissions", (event) => {
    if (!trusted(event)) throw new Error("Untrusted request");
    const darwin = process.platform === "darwin";
    const version = Number(os.release().split(".")[0]);
    return {
      screen: darwin
        ? systemPreferences.getMediaAccessStatus("screen")
        : "unknown",
      camera: darwin
        ? systemPreferences.getMediaAccessStatus("camera")
        : "unknown",
      microphone: darwin
        ? systemPreferences.getMediaAccessStatus("microphone")
        : "unknown",
      systemAudio: process.platform === "win32" || (darwin && version >= 23),
    };
  });
  ipcMain.on("relay:notify", (event, message) => {
    if (trusted(event) && Notification.isSupported())
      new Notification({
        title: "Relay",
        body: String(message).slice(0, 250),
      }).show();
  });
  ipcMain.handle("relay:updates", async (event) => {
    if (!trusted(event)) throw new Error("Untrusted request");
    if (!app.isPackaged)
      return { status: "Updates are available in packaged releases." };
    const feed = process.env.RELAY_UPDATE_URL;
    if (!feed || !feed.startsWith("https://"))
      return { status: "Set RELAY_UPDATE_URL to your HTTPS release feed." };
    const { autoUpdater } = require("electron-updater");
    autoUpdater.autoDownload = false;
    autoUpdater.setFeedURL({ provider: "generic", url: feed });
    const result = await autoUpdater.checkForUpdates();
    if (!result || result.updateInfo.version === app.getVersion())
      return { status: "You have the latest release." };
    const answer = await require("electron").dialog.showMessageBox(window(), {
      type: "info",
      message: `Relay ${result.updateInfo.version} is available.`,
      detail: "Download the signed update and install it when Relay quits?",
      buttons: ["Download update", "Later"],
      defaultId: 0,
      cancelId: 1,
    });
    if (answer.response !== 0) return { status: "Update postponed." };
    await autoUpdater.downloadUpdate();
    autoUpdater.autoInstallOnAppQuit = true;
    return { status: "Update downloaded. Quit Relay to install it." };
  });
  app.on("before-quit", () => {
    regionWindow?.destroy();
    dispose();
  });
  return {
    resetRegion: () => {
      region = undefined;
    },
    region: () => region,
    reset() {
      const wasActive = state.active;
      state = { active: false };
      extras = {};
      onState(state);
      onActive(false);
      if (wasActive) dispose();
    },
    patch(next) {
      extras = { ...extras, ...next };
      toolbar?.webContents.send("relay:state", { ...state, ...extras });
    },
    state: () => state,
    send,
    dispose,
  };
};
