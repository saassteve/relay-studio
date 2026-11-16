const {
  app,
  BrowserWindow,
  desktopCapturer,
  ipcMain,
  session,
  globalShortcut,
  systemPreferences,
  shell,
  Menu,
  screen,
  Tray,
  nativeImage,
  dialog,
} = require("electron");
const { pathToFileURL } = require("node:url");
const { spawn } = require("node:child_process");
const path = require("node:path");
const fs = require("node:fs");
let mainWindow,
  server,
  baseURL,
  selectedSource,
  selectedBounds,
  nativeStudio,
  captureUI,
  tray,
  hiddenForRecording = false;
const STABLE_PORT = process.env.RELAY_PORT || "41730";
const RECORDING_SHORTCUTS = {
  "Alt+Shift+P": "pause",
  "Alt+Shift+C": "cancel",
  "Alt+Shift+D": "draw",
};
app.setName("Relay");
if (!app.requestSingleInstanceLock()) app.quit();
app.on("second-instance", () => {
  mainWindow?.show();
  mainWindow?.focus();
});
async function startServer() {
  const ffmpeg = await require("./engine.cjs")();
  const data = path.join(app.getPath("userData"), "library");
  fs.mkdirSync(data, { recursive: true });
  const root = path.resolve(__dirname, "..");
  // An ephemeral port keeps the desktop library separate from an existing web instance.
  const entry = path.join(root, "server", "desktop-server.mjs");
  server = spawn(process.execPath, [entry], {
    cwd: root,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1",
      NODE_ENV: "production",
      RELAY_DATA_DIR: data,
      RELAY_PORT: STABLE_PORT,
      ...(ffmpeg ? { FFMPEG_BIN: ffmpeg } : {}),
      PUBLIC_URL: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stderr.on("data", (d) => console.error(d.toString()));
  return new Promise((resolve, reject) => {
    let output = "";
    const timer = setTimeout(
      () =>
        reject(
          new Error(
            "Relay’s library server did not start. Run npm run build first.",
          ),
        ),
      20000,
    );
    server.stdout.on("data", (d) => {
      output += d.toString();
      const m = output.match(/RELAY_READY:(http:\/\/127\.0\.0\.1:\d+)/);
      if (m) {
        clearTimeout(timer);
        resolve(m[1]);
      }
    });
    server.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`Library server exited (${code}).`));
    });
  });
}
const bubblePage = pathToFileURL(path.join(__dirname, "bubble.html")).href;
const isBubble = (webContents) => {
  try {
    return webContents.getURL().split("?")[0] === bubblePage;
  } catch {
    return false;
  }
};
function showStudio() {
  if (!mainWindow) return void createWindow();
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}
function trusted(event) {
  return (
    event.sender === mainWindow?.webContents &&
    event.senderFrame === mainWindow?.webContents.mainFrame &&
    studioURL(event.senderFrame?.url)
  );
}
function studioURL(url) {
  try {
    const u = new URL(url);
    return (
      u.origin === baseURL &&
      (u.pathname === "/" || u.pathname.startsWith("/video/"))
    );
  } catch {
    return false;
  }
}
async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1450,
    height: 980,
    minWidth: 850,
    minHeight: 650,
    backgroundColor: "#fbfcf8",
    title: "Relay",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith(baseURL + "/s/")) void shell.openExternal(url);
    return { action: "deny" };
  });
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (new URL(url).origin !== baseURL) {
      event.preventDefault();
      if (/^https?:/.test(url)) void shell.openExternal(url);
    }
  });
  await mainWindow.loadURL(baseURL);
  mainWindow.on("closed", () => (mainWindow = null));
}
app
  .whenReady()
  .then(async () => {
    if (process.env.RELAY_SERVER_URL) {
      const url = new URL(process.env.RELAY_SERVER_URL);
      if (
        url.protocol !== "https:" &&
        !(
          url.protocol === "http:" &&
          ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
        )
      )
        throw new Error(
          "RELAY_SERVER_URL must use HTTPS, or HTTP on localhost.",
        );
      baseURL = url.origin;
    } else baseURL = await startServer();
    session.defaultSession.setPermissionRequestHandler(
      async (webContents, permission, callback, details) => {
        if (isBubble(webContents))
          return callback(
            permission === "media" &&
              (details.mediaTypes || []).every((t) => t === "video") &&
              systemPreferences.getMediaAccessStatus("camera") !== "denied",
          );
        if (
          webContents !== mainWindow?.webContents ||
          !studioURL(webContents.getURL()) ||
          !["media", "display-capture", "fullscreen"].includes(permission)
        )
          return callback(false);
        if (permission === "media" && process.platform === "darwin") {
          for (const mediaType of details.mediaTypes || []) {
            const type =
              mediaType === "video"
                ? "camera"
                : mediaType === "audio"
                  ? "microphone"
                  : null;
            if (
              type &&
              systemPreferences.getMediaAccessStatus(type) ===
                "not-determined" &&
              !(await systemPreferences.askForMediaAccess(type))
            )
              return callback(false);
          }
        }
        callback(true);
      },
    );
    session.defaultSession.setPermissionCheckHandler(
      (webContents, permission, origin) => {
        try {
          if (isBubble(webContents)) return permission === "media";
          return (
            webContents === mainWindow?.webContents &&
            studioURL(webContents.getURL()) &&
            new URL(origin).origin === baseURL &&
            ["media", "display-capture"].includes(permission)
          );
        } catch {
          return false;
        }
      },
    );
    session.defaultSession.setDisplayMediaRequestHandler(
      async (request, callback) => {
        try {
          if (
            request.frame.url !== baseURL + "/" &&
            !request.frame.url.startsWith(baseURL + "/video/")
          )
            return callback({});
          const sources = await desktopCapturer.getSources({
            types: ["screen", "window"],
          });
          const source = sources.find((s) => s.id === selectedSource);
          selectedSource = undefined;
          if (!source) return callback({});
          // Current Chromium uses CoreAudio Tap on supported macOS releases.
          callback(
            request.audioRequested &&
              (process.platform === "win32" ||
                (process.platform === "darwin" &&
                  Number(require("node:os").release().split(".")[0]) >= 23))
              ? { video: source, audio: "loopback" }
              : { video: source },
          );
        } catch (e) {
          console.error(e);
          callback({});
        }
      },
    );
    ipcMain.handle("relay:sources", async (event) => {
      if (!trusted(event)) throw new Error("Untrusted capture request");
      const sources = await desktopCapturer.getSources({
        types: ["screen", "window"],
        thumbnailSize: { width: 360, height: 210 },
        fetchWindowIcons: false,
      });
      return sources.map((s) => ({
        id: s.id,
        name: s.name,
        thumbnail: s.thumbnail.toDataURL(),
        displayId: s.display_id,
      }));
    });
    ipcMain.handle("relay:select-source", async (event, id) => {
      if (!trusted(event) || typeof id !== "string")
        throw new Error("Untrusted capture request");
      selectedSource = id;
      const sources = await desktopCapturer.getSources({
        types: ["screen", "window"],
        thumbnailSize: { width: 0, height: 0 },
      });
      const source = sources.find((s) => s.id === id);
      selectedBounds = source?.id.startsWith("screen:")
        ? screen
            .getAllDisplays()
            .find((d) => String(d.id) === source.display_id)?.bounds
        : undefined;
      nativeStudio?.resetRegion();
    });
    const confirmDiscard = async () => {
      const { response } = await dialog.showMessageBox({
        type: "warning",
        message: "Discard this recording?",
        detail: "The take and its saved chunks will be deleted.",
        buttons: ["Discard", "Keep recording"],
        defaultId: 1,
        cancelId: 1,
      });
      if (response === 0) nativeStudio.send("cancel");
    };
    const toggleDraw = () => {
      const on = captureUI.toggleDraw();
      nativeStudio.patch({ draw: on, canDraw: captureUI.canDraw() });
    };
    nativeStudio = require("./studio.cjs")({
      trusted,
      window: () => mainWindow,
      captureBounds: () => selectedBounds,
      onAction(action) {
        if (action === "cancel") return void confirmDiscard(), true;
        if (action === "draw") return toggleDraw(), true;
        return false;
      },
      onActive(active) {
        for (const [accelerator, action] of Object.entries(
          RECORDING_SHORTCUTS,
        )) {
          if (!active) globalShortcut.unregister(accelerator);
          else
            globalShortcut.register(accelerator, () => {
              if (action === "cancel") void confirmDiscard();
              else if (action === "draw") toggleDraw();
              else nativeStudio.send(action);
            });
        }
        if (!active) {
          captureUI.dispose();
          if (hiddenForRecording) showStudio();
          hiddenForRecording = false;
        }
        updateTray();
      },
      onState: (state) => updateTray(state),
    });
    captureUI = require("./capture-ui.cjs")({
      captureBounds: () => selectedBounds,
      region: () => nativeStudio.region(),
    });
    ipcMain.handle("relay:info", (event) => {
      if (!trusted(event)) throw new Error("Untrusted request");
      return {
        version: app.getVersion(),
        packaged: app.isPackaged,
        platform: process.platform,
        osRelease: require("node:os").release(),
        stablePort: new URL(baseURL).port === STABLE_PORT,
      };
    });
    ipcMain.handle("relay:permission-request", async (event, kind) => {
      if (!trusted(event)) throw new Error("Untrusted request");
      if (process.platform !== "darwin") return "granted";
      if (kind === "camera" || kind === "microphone") {
        if (systemPreferences.getMediaAccessStatus(kind) === "not-determined")
          await systemPreferences.askForMediaAccess(kind);
        return systemPreferences.getMediaAccessStatus(kind);
      }
      if (kind === "screen") {
        // Asking for sources registers Relay in the Screen Recording list and,
        // on first use, shows the macOS prompt.
        await desktopCapturer
          .getSources({ types: ["screen"], thumbnailSize: { width: 1, height: 1 } })
          .catch(() => []);
        return systemPreferences.getMediaAccessStatus("screen");
      }
      throw new Error("Unknown permission");
    });
    ipcMain.handle("relay:permission-settings", async (event, kind) => {
      if (!trusted(event)) throw new Error("Untrusted request");
      const pane = {
        camera: "Privacy_Camera",
        microphone: "Privacy_Microphone",
        screen: "Privacy_ScreenCapture",
        audio: "Privacy_ScreenCapture",
      }[kind];
      if (!pane || process.platform !== "darwin") return false;
      await shell.openExternal(
        `x-apple.systempreferences:com.apple.preference.security?${pane}`,
      );
      return true;
    });
    ipcMain.handle("relay:relaunch", (event) => {
      if (!trusted(event)) throw new Error("Untrusted request");
      globalShortcut.unregisterAll();
      server?.kill();
      app.relaunch();
      app.exit(0);
    });
    ipcMain.handle("relay:prepare-recording", async (event, options = {}) => {
      if (!trusted(event)) throw new Error("Untrusted request");
      const screenCapture = options.screen === true;
      if (screenCapture && options.hideWindow !== false && mainWindow) {
        hiddenForRecording = true;
        mainWindow.hide();
      }
      const result = await captureUI.prepare({
        countdownSeconds: [0, 3, 5].includes(options.countdown)
          ? options.countdown
          : 3,
        bubble:
          screenCapture && options.bubble
            ? {
                deviceId: String(options.cameraId || ""),
                size: options.bubbleSize,
              }
            : null,
        draw: screenCapture && Boolean(selectedBounds),
      });
      if (result.cancelled && hiddenForRecording) {
        hiddenForRecording = false;
        showStudio();
      }
      nativeStudio.patch({ draw: false, canDraw: captureUI.canDraw() });
      return result;
    });
    ipcMain.handle("relay:camera-layout", (event) => {
      if (!trusted(event)) throw new Error("Untrusted request");
      return captureUI.cameraLayout();
    });
    await createWindow();
    const startRecording = async () => {
      if (nativeStudio.state().active) return nativeStudio.send("stop");
      showStudio();
      mainWindow?.webContents.send("relay:record");
    };
    const trayIcon = (recording) => {
      const image = nativeImage.createFromPath(
        path.join(
          __dirname,
          recording ? "trayRecordingTemplate.png" : "trayTemplate.png",
        ),
      );
      image.setTemplateImage(true);
      return image;
    };
    let trayKey = "";
    function updateTray(state = nativeStudio.state()) {
      if (!tray) return;
      const n = Math.floor(state.seconds || 0);
      const time = `${Math.floor(n / 60)}:${String(n % 60).padStart(2, "0")}`;
      if (process.platform === "darwin")
        tray.setTitle(state.active ? ` ${time}` : "", { fontType: "monospacedDigit" });
      const key = `${!!state.active}:${!!state.paused}`;
      if (key === trayKey) return;
      trayKey = key;
      tray.setImage(trayIcon(state.active));
      tray.setToolTip(state.active ? "Relay is recording" : "Relay");
      tray.setContextMenu(
        Menu.buildFromTemplate(
          state.active
            ? [
                {
                  label: state.paused ? "Resume recording" : "Pause recording",
                  accelerator: "Alt+Shift+P",
                  click: () => nativeStudio.send("pause"),
                },
                {
                  label: "Finish recording",
                  accelerator: "CommandOrControl+Shift+R",
                  click: () => nativeStudio.send("stop"),
                },
                {
                  label: "Discard recording…",
                  accelerator: "Alt+Shift+C",
                  click: () => void confirmDiscard(),
                },
                { type: "separator" },
                { label: "Show Relay", click: showStudio },
              ]
            : [
                {
                  label: "New recording",
                  accelerator: "CommandOrControl+Shift+R",
                  click: startRecording,
                },
                { label: "Open library", click: showStudio },
                { type: "separator" },
                { label: "Quit Relay", role: "quit" },
              ],
        ),
      );
    }
    tray = new Tray(trayIcon(false));
    updateTray();
    globalShortcut.register("CommandOrControl+Shift+R", startRecording);
    const template = [
      ...(process.platform === "darwin" ? [{ role: "appMenu" }] : []),
      {
        label: "File",
        submenu: [
          {
            label: "New recording",
            accelerator: "CommandOrControl+Shift+R",
            click: startRecording,
          },
          {
            label: "Setup guide",
            click: () => {
              showStudio();
              mainWindow?.webContents.send("relay:control", "onboarding");
            },
          },
          { type: "separator" },
          { role: process.platform === "darwin" ? "close" : "quit" },
        ],
      },
      { role: "editMenu" },
      { role: "viewMenu" },
      { role: "windowMenu" },
    ];
    Menu.setApplicationMenu(Menu.buildFromTemplate(template));
  })
  .catch((error) => {
    require("electron").dialog.showErrorBox(
      "Relay could not start",
      error.message,
    );
    app.quit();
  });
app.on("activate", () => {
  if (!baseURL) return;
  if (!mainWindow) void createWindow();
  else if (!nativeStudio?.state().active) showStudio();
});
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
app.on("before-quit", () => {
  globalShortcut.unregisterAll();
  server?.kill();
});
