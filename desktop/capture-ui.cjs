const { BrowserWindow, ipcMain, screen } = require("electron");
const path = require("node:path");

// Native recording surfaces: a countdown, a floating camera bubble and a drawing layer.
// The countdown and bubble are excluded from capture (the camera is its own track and is
// composited at render time using the bubble's on-screen position). The drawing layer is
// deliberately captured so annotations appear in the recording.
const SIZES = { s: 150, m: 210, l: 300 };
const SNAP = 48;
const MARGIN = 24;

module.exports = function attachCaptureUI({ captureBounds, region }) {
  let bubble, countdown, overlay, drawing = false, bubbleSize = "m";
  const secure = {
    preload: path.join(__dirname, "overlay-preload.cjs"),
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
  };
  const lock = (win) => {
    win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    win.webContents.on("will-navigate", (e) => e.preventDefault());
  };
  const displayFor = () => {
    const bounds = captureBounds();
    return bounds
      ? screen.getDisplayMatching(bounds)
      : screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  };
  const isOwn = (event, win) => win && event.sender === win.webContents;

  function showCountdown(seconds) {
    if (!seconds) return Promise.resolve(true);
    countdown?.destroy();
    const area = displayFor().workArea;
    const size = 260;
    countdown = new BrowserWindow({
      width: size,
      height: size,
      x: Math.round(area.x + (area.width - size) / 2),
      y: Math.round(area.y + (area.height - size) / 2),
      frame: false,
      transparent: true,
      resizable: false,
      movable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      hasShadow: false,
      alwaysOnTop: true,
      show: false,
      webPreferences: secure,
    });
    countdown.setAlwaysOnTop(true, "screen-saver", 2);
    countdown.setContentProtection(true);
    countdown.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    lock(countdown);
    const win = countdown;
    return new Promise((resolve) => {
      let settled = false;
      const done = (value) => {
        if (settled) return;
        settled = true;
        ipcMain.removeListener("relay:countdown-result", listener);
        if (!win.isDestroyed()) win.destroy();
        if (countdown === win) countdown = undefined;
        resolve(value);
      };
      const listener = (event, value) => {
        if (isOwn(event, win)) done(value === "go");
      };
      ipcMain.on("relay:countdown-result", listener);
      win.once("closed", () => done(false));
      void win
        .loadFile(path.join(__dirname, "countdown.html"), {
          query: { seconds: String(seconds) },
        })
        .then(() => {
          win.show();
          win.focus();
        });
    });
  }

  function placeBubble(win, size) {
    const area = displayFor().workArea;
    win.setBounds({
      width: size,
      height: size,
      x: area.x + MARGIN,
      y: area.y + area.height - size - MARGIN,
    });
  }
  function snapBubble() {
    if (!bubble) return;
    const b = bubble.getBounds();
    const area = screen.getDisplayMatching(b).workArea;
    let { x, y } = b;
    if (x - area.x < SNAP) x = area.x + MARGIN;
    if (area.x + area.width - (x + b.width) < SNAP)
      x = area.x + area.width - b.width - MARGIN;
    if (y - area.y < SNAP) y = area.y + MARGIN;
    if (area.y + area.height - (y + b.height) < SNAP)
      y = area.y + area.height - b.height - MARGIN;
    if (x !== b.x || y !== b.y) bubble.setPosition(x, y, true);
  }
  function openBubble({ deviceId = "", size = "m" } = {}) {
    closeBubble();
    bubbleSize = SIZES[size] ? size : "m";
    bubble = new BrowserWindow({
      width: SIZES[bubbleSize],
      height: SIZES[bubbleSize],
      frame: false,
      transparent: true,
      resizable: false,
      maximizable: false,
      minimizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      hasShadow: false,
      alwaysOnTop: true,
      show: false,
      webPreferences: secure,
    });
    bubble.setAlwaysOnTop(true, "screen-saver", 1);
    bubble.setContentProtection(true);
    bubble.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    lock(bubble);
    placeBubble(bubble, SIZES[bubbleSize]);
    bubble.on("moved", snapBubble);
    bubble.on("closed", () => (bubble = undefined));
    const win = bubble;
    void bubble.loadFile(path.join(__dirname, "bubble.html")).then(() => {
      if (win.isDestroyed()) return;
      win.webContents.send("relay:bubble-config", {
        deviceId: String(deviceId).slice(0, 300),
        size: bubbleSize,
      });
      win.showInactive();
    });
  }
  function closeBubble() {
    bubble?.destroy();
    bubble = undefined;
  }
  ipcMain.on("relay:bubble-size", (event, size) => {
    if (!isOwn(event, bubble) || !SIZES[size]) return;
    const b = bubble.getBounds(),
      next = SIZES[size],
      area = screen.getDisplayMatching(b).workArea;
    // Grow from the centre, then keep the bubble on screen.
    const x = Math.min(
        Math.max(area.x, Math.round(b.x + (b.width - next) / 2)),
        area.x + area.width - next,
      ),
      y = Math.min(
        Math.max(area.y, Math.round(b.y + (b.height - next) / 2)),
        area.y + area.height - next,
      );
    bubbleSize = size;
    bubble.setBounds({ x, y, width: next, height: next }, true);
    bubble.webContents.send("relay:bubble-config", { size });
  });
  ipcMain.on("relay:bubble-hide", (event) => {
    if (isOwn(event, bubble)) closeBubble();
  });

  function openOverlay() {
    closeOverlay();
    const bounds = captureBounds();
    if (!bounds) return;
    overlay = new BrowserWindow({
      ...bounds,
      frame: false,
      transparent: true,
      resizable: false,
      movable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      hasShadow: false,
      focusable: false,
      alwaysOnTop: true,
      show: false,
      webPreferences: secure,
    });
    overlay.setAlwaysOnTop(true, "screen-saver", 0);
    overlay.setIgnoreMouseEvents(true);
    overlay.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    lock(overlay);
    overlay.on("closed", () => {
      overlay = undefined;
      drawing = false;
    });
    const win = overlay;
    void overlay.loadFile(path.join(__dirname, "draw.html")).then(() => {
      if (!win.isDestroyed()) win.showInactive();
    });
  }
  function closeOverlay() {
    overlay?.destroy();
    overlay = undefined;
    drawing = false;
  }
  function setDrawing(on) {
    if (!overlay) return false;
    drawing = on;
    overlay.setIgnoreMouseEvents(!on);
    overlay.setFocusable(on);
    if (on) overlay.focus();
    overlay.webContents.send("relay:draw-mode", on);
    return drawing;
  }
  ipcMain.on("relay:draw-exit", (event) => {
    if (isOwn(event, overlay)) setDrawing(false);
  });

  return {
    async prepare({ countdownSeconds = 3, bubble: bubbleOptions, draw }) {
      if (bubbleOptions) openBubble(bubbleOptions);
      const go = await showCountdown(countdownSeconds);
      if (!go) {
        closeBubble();
        return { cancelled: true };
      }
      if (draw) openOverlay();
      return { cancelled: false };
    },
    toggleDraw: () => setDrawing(!drawing),
    canDraw: () => Boolean(overlay),
    // Camera position, as fractions of the captured frame, for the first render.
    cameraLayout() {
      const bounds = captureBounds();
      if (!bubble || !bounds) return null;
      const b = bubble.getBounds(),
        r = region() || { x: 0, y: 0, w: 1, h: 1 };
      const fw = bounds.width * r.w,
        fh = bounds.height * r.h,
        fx = bounds.x + bounds.width * r.x,
        fy = bounds.y + bounds.height * r.y;
      const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
      const size = clamp(b.width / fw, 0.05, 0.6);
      return {
        visible: true,
        shape: "circle",
        size,
        x: clamp((b.x - fx) / fw, 0, 1 - size),
        y: clamp((b.y - fy) / fh, 0, 1 - (b.height / fh)),
      };
    },
    dispose() {
      countdown?.destroy();
      countdown = undefined;
      closeBubble();
      closeOverlay();
    },
  };
};
