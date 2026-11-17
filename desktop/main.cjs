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
  nativeTheme,
} = require("electron");
const { spawn, execFile } = require("node:child_process");
const { randomBytes } = require("node:crypto");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");
let mainWindow,
  server,
  baseURL,
  selectedSource,
  pickerSources = [],
  selectedDisplay,
  nativeStudio,
  captureUI,
  updates,
  tray,
  hiddenForRecording = false,
  // A countdown is on screen, and when the last one ended.
  preparing = false,
  prepared = 0,
  // Whether a recording was running, and when the last one stopped.
  wasRecording = false,
  recordingEnded = 0,
  quitting = false,
  // The recording may end without asking: Relay is relaunching, or the user has
  // already agreed to it for the quit under way.
  leaving = false;
const STABLE_PORT = process.env.RELAY_PORT || "41730";
const RECORDING_SHORTCUTS = {
  "Alt+Shift+P": "pause",
  "Alt+Shift+C": "cancel",
  "Alt+Shift+D": "draw",
};
app.setName("Relay");
app.setAboutPanelOptions({ credits: "Built by brep · brep.ai" });
if (!app.requestSingleInstanceLock()) app.exit(0);
const localSecret = randomBytes(32).toString("hex");
app.on("second-instance", () => {
  if (baseURL) showStudio();
});
async function startServer() {
  const ffmpeg = await require("./engine.cjs")();
  const data = path.join(app.getPath("userData"), "library");
  fs.mkdirSync(data, { recursive: true });
  const root = path.resolve(__dirname, "..");
  // A stable port keeps local share links valid across restarts. The server falls
  // back to any free port if this one is taken.
  const entry = path.join(root, "server", "desktop-server.mjs");
  server = spawn(process.execPath, [entry], {
    cwd: root,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1",
      NODE_ENV: "production",
      RELAY_DATA_DIR: data,
      RELAY_PORT: STABLE_PORT,
      RELAY_LOCAL_SECRET: localSecret,
      ...(ffmpeg ? { FFMPEG_BIN: ffmpeg } : {}),
      PUBLIC_URL: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stderr.on("data", (d) => console.error(d.toString()));
  return new Promise((resolve, reject) => {
    let output = "",
      ready = false;
    const timer = setTimeout(
      () =>
        reject(
          new Error(
            app.isPackaged
              ? "Relay’s library did not start. Try opening Relay again."
              : "Relay’s library server did not start. Run npm run build first.",
          ),
        ),
      20000,
    );
    server.stdout.on("data", (d) => {
      if (ready) return;
      output += d.toString();
      const m = output.match(/RELAY_READY:(http:\/\/127\.0\.0\.1:\d+)/);
      if (m) {
        ready = true;
        clearTimeout(timer);
        resolve(m[1]);
      }
    });
    server.on("exit", (code) => {
      clearTimeout(timer);
      if (ready) void serverStopped();
      else reject(new Error(`Library server exited (${code}).`));
    });
  });
}
// Once it is up, the library server should only stop when Relay does. Nothing in
// the studio works without it, so offer a clean restart.
async function serverStopped() {
  // Ctrl-C in a terminal, or a shutdown, stops the server and Relay together.
  // Let Relay's own quit arrive first.
  await new Promise((r) => setTimeout(r, 300));
  if (quitting) return;
  server = undefined;
  nativeStudio?.reset();
  const { response } = await dialog.showMessageBox({
    type: "error",
    message: "Relay’s library stopped unexpectedly",
    detail:
      "Relay has to reopen before it can show or save recordings. Recordings already in your library are not affected.",
    buttons: ["Reopen Relay", "Quit"],
    defaultId: 0,
    cancelId: 1,
  });
  if (response === 0) app.relaunch();
  app.exit(0);
}
// Looked up on every use: the chosen display can be unplugged or re-scaled between
// picking it and recording. If it has gone, the primary display stands in.
function captureBounds() {
  if (selectedDisplay === undefined) return undefined;
  return (
    screen.getAllDisplays().find((d) => d.id === selectedDisplay) ||
    screen.getPrimaryDisplay()
  ).bounds;
}
const isBubble = (webContents) => {
  try {
    return (
      Boolean(baseURL) &&
      webContents.getURL().split("?")[0] === `${baseURL}/bubble.html`
    );
  } catch {
    return false;
  }
};
// Asked before a close, reload or quit ends the take. It blocks until answered:
// the events that lead here need the answer before they return.
function confirmEndRecording() {
  const options = {
    type: "warning",
    message: "A recording is in progress",
    detail:
      "Closing now ends the recording. What has been captured so far is kept and can be recovered.",
    buttons: ["Keep recording", "Close anyway"],
    defaultId: 0,
    cancelId: 0,
  };
  app.focus({ steal: true });
  // The studio is hidden during a screen recording; a sheet attached to it
  // could not be seen or answered.
  const choice = mainWindow?.isVisible()
    ? dialog.showMessageBoxSync(mainWindow, options)
    : dialog.showMessageBoxSync(options);
  return choice === 1;
}
// A recording is being set up or made, or its last pieces are still being saved.
// Nothing may ask for attention or restart Relay meanwhile (desktop/updates.cjs).
function recordingBusy() {
  return (
    Boolean(nativeStudio?.state().active) ||
    hiddenForRecording ||
    preparing ||
    Date.now() - Math.max(prepared, recordingEnded) < 60000
  );
}
// Whether the library is still rendering or processing a video. null when that
// can't be found out.
async function libraryBusy() {
  // A library on a server carries on without this app.
  if (process.env.RELAY_SERVER_URL) return false;
  if (!server) return null;
  try {
    const response = await fetch(`${baseURL}/api/jobs`, {
      headers: { Cookie: `relay_local=${localSecret}` },
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) return null;
    return (await response.json()).some((job) =>
      ["queued", "running"].includes(job.status),
    );
  } catch {
    return null;
  }
}
function showStudio() {
  if (quitting) return;
  if (!mainWindow) return void createWindow();
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}
// Small choices the shell needs before any window exists (desktop/updates.cjs
// keeps its own there too).
const THEMES = ["system", "light", "dark"];
const desktopSettings = () =>
  path.join(app.getPath("userData"), "desktop-settings.json");
function savedSettings() {
  try {
    const saved = JSON.parse(fs.readFileSync(desktopSettings(), "utf8"));
    return saved && typeof saved === "object" ? saved : {};
  } catch {
    return {};
  }
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
  if (quitting) return;
  const theme = savedSettings().theme;
  if (THEMES.includes(theme)) nativeTheme.themeSource = theme;
  mainWindow = new BrowserWindow({
    width: 1450,
    height: 980,
    minWidth: 850,
    minHeight: 650,
    // The page's own colour in each theme (--paper in src/styles.css), so a
    // dark system doesn't open the window on a white flash.
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#0f1814" : "#fbfcf8",
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
  const win = mainWindow;
  // If the studio goes away mid-recording, end the native recording state so
  // the controls, shortcuts and tray don't get stuck.
  const reset = () => nativeStudio?.reset();
  win.on("closed", () => {
    if (mainWindow === win) mainWindow = null;
    // Nothing is left to bring back, so ending the recording must not reopen it.
    hiddenForRecording = false;
    reset();
  });
  win.webContents.on("render-process-gone", reset);
  // While recording, the studio objects to being unloaded (the beforeunload handler
  // in src/Recorder.tsx). Unhandled, Electron would silently refuse to close the
  // window. preventDefault() here overrules the page and lets the unload go ahead.
  win.webContents.on("will-prevent-unload", (event) => {
    if (leaving || confirmEndRecording()) event.preventDefault();
    // Keeping the recording also calls off a quit that was closing this window.
    else quitting = false;
  });
  win.webContents.on("did-start-navigation", (e, url, inPlace, isMainFrame) => {
    if (isMainFrame && !inPlace) reset();
  });
  if (!process.env.RELAY_SERVER_URL)
    await session.defaultSession.cookies.set({
      url: baseURL,
      name: "relay_local",
      value: localSecret,
      httpOnly: true,
      sameSite: "strict",
    });
  await win.loadURL(baseURL);
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
          const source = selectedSource;
          selectedSource = undefined;
          pickerSources = [];
          if (!source) return callback({});
          // Current Chromium uses CoreAudio Tap on supported macOS releases.
          callback(
            request.audioRequested &&
              (process.platform === "win32" ||
                (process.platform === "darwin" &&
                  Number(os.release().split(".")[0]) >= 23))
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
      selectedSource = undefined;
      pickerSources = [];
      let sources;
      try {
        sources = await desktopCapturer.getSources({
          types: ["screen", "window"],
          thumbnailSize: { width: 360, height: 210 },
          fetchWindowIcons: false,
        });
      } catch {
        // On a Mac this is what a missing or out-of-date permission looks like.
        throw new Error("screen-permission");
      }
      pickerSources = sources;
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
      // The picker already obtained these sources from macOS. Keep the chosen
      // object for getDisplayMedia instead of enumerating every window again.
      selectedSource = undefined;
      const source = pickerSources.find((s) => s.id === id);
      if (!source)
        throw new Error("Choose a screen or window from the picker again.");
      selectedSource = source;
      selectedDisplay = source?.id.startsWith("screen:")
        ? screen
            .getAllDisplays()
            .find((d) => String(d.id) === source.display_id)?.id
        : undefined;
      nativeStudio?.resetRegion();
    });
    // One "discard?" prompt at a time, and it belongs to the recording it was
    // opened for: it is aborted when that recording ends.
    let discardPrompt;
    const confirmDiscard = async () => {
      if (discardPrompt || !nativeStudio.state().active) return;
      const prompt = (discardPrompt = new AbortController());
      const options = {
        type: "warning",
        message: "Discard this recording?",
        detail: "The take and its saved chunks will be deleted.",
        buttons: ["Discard", "Keep recording"],
        defaultId: 1,
        cancelId: 1,
        signal: prompt.signal,
      };
      try {
        // A prompt left open after its recording ends is ignored when answered.
        const { response } = await dialog.showMessageBox(options);
        if (
          response === 0 &&
          !prompt.signal.aborted &&
          nativeStudio.state().active
        )
          nativeStudio.send("cancel");
      } finally {
        if (discardPrompt === prompt) discardPrompt = undefined;
      }
    };
    const toggleDraw = () => {
      const on = captureUI.toggleDraw();
      nativeStudio.patch({ draw: on, canDraw: captureUI.canDraw() });
    };
    nativeStudio = require("./studio.cjs")({
      trusted,
      window: () => mainWindow,
      captureBounds,
      onAction(action) {
        if (action === "cancel") return (void confirmDiscard(), true);
        if (action === "draw") return (toggleDraw(), true);
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
        if (wasRecording && !active) recordingEnded = Date.now();
        wasRecording = active;
        updates?.recordingChanged(active);
        if (!active) {
          discardPrompt?.abort();
          captureUI.dispose();
          // The recording surfaces must never leave Relay without its Dock icon.
          if (app.dock && !app.dock.isVisible()) void app.dock.show();
          if (hiddenForRecording) showStudio();
          hiddenForRecording = false;
        }
        updateTray();
      },
      onState: (state) => updateTray(state),
    });
    captureUI = require("./capture-ui.cjs")({
      captureBounds,
      region: () => nativeStudio.region(),
      baseURL: () => baseURL,
    });
    updates = require("./updates.cjs")({
      trusted,
      window: () => mainWindow,
      recording: recordingBusy,
      working: libraryBusy,
      // Restarting into an update: nothing objects to the windows closing, and
      // nothing reopens them. If the restart fails, the studio comes back.
      onRestart(going) {
        quitting = leaving = going;
        if (!going) showStudio();
      },
    });
    ipcMain.handle("relay:info", (event) => {
      if (!trusted(event)) throw new Error("Untrusted request");
      return {
        version: app.getVersion(),
        packaged: app.isPackaged,
        platform: process.platform,
        osRelease: os.release(),
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
          .getSources({
            types: ["screen"],
            thumbnailSize: { width: 1, height: 1 },
          })
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
    const relaunch = () => {
      quitting = leaving = true;
      globalShortcut.unregisterAll();
      server?.kill();
      app.relaunch();
      app.exit(0);
    };
    ipcMain.handle("relay:relaunch", (event) => {
      if (!trusted(event)) throw new Error("Untrusted request");
      relaunch();
    });
    // macOS ties Screen Recording access to how an app is signed. A grant given to
    // an older copy of Relay can still show as switched on in System Settings while
    // being refused for this one. Clearing Relay's entry makes macOS ask again.
    // Light, dark or the system's choice, picked in Settings. The app's page
    // keeps its own copy; this one makes the window, its menus and its dialogs
    // match, from the first moment of the next launch too.
    ipcMain.handle("relay:theme", (event, theme) => {
      if (!trusted(event)) throw new Error("Untrusted request");
      if (!THEMES.includes(theme)) return;
      nativeTheme.themeSource = theme;
      try {
        fs.writeFileSync(
          desktopSettings(),
          JSON.stringify({ ...savedSettings(), theme }, null, 2),
        );
      } catch (error) {
        console.error(error);
      }
    });
    ipcMain.handle("relay:reset-screen-permission", async (event) => {
      if (!trusted(event)) throw new Error("Untrusted request");
      if (process.platform !== "darwin" || !app.isPackaged) return false;
      await new Promise((done) =>
        execFile(
          "/usr/bin/tccutil",
          ["reset", "ScreenCapture", "org.relayvideo.studio"],
          () => done(),
        ),
      );
      relaunch();
      return true;
    });
    ipcMain.handle("relay:prepare-recording", async (event, options = {}) => {
      if (!trusted(event)) throw new Error("Untrusted request");
      const screenCapture = options.screen === true;
      preparing = true;
      updates.recordingChanged(true);
      if (screenCapture && options.hideWindow !== false && mainWindow) {
        hiddenForRecording = true;
        mainWindow.hide();
      }
      const countdown = captureUI.prepare({
        countdownSeconds: [0, 3, 5].includes(options.countdown)
          ? options.countdown
          : 3,
        bubble:
          screenCapture && options.bubble
            ? {
                deviceId: String(options.cameraId || ""),
                size: options.bubbleSize,
                filter: options.filter,
                background: options.background,
              }
            : null,
        draw: screenCapture && Boolean(captureBounds()),
      });
      const result = await countdown.finally(() => {
        preparing = false;
        prepared = Date.now();
      });
      if (result.cancelled) updates.recordingChanged(false);
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
    const whenStudioReady = async (channel, ...args) => {
      if (!mainWindow) {
        await createWindow();
        // Give the freshly loaded studio a moment to start listening.
        await new Promise((r) => setTimeout(r, 900));
      }
      showStudio();
      mainWindow?.webContents.send(channel, ...args);
    };
    const startRecording = async () => {
      if (nativeStudio.state().active) return nativeStudio.send("stop");
      await whenStudioReady("relay:record");
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
        tray.setTitle(state.active ? ` ${time}` : "", {
          fontType: "monospacedDigit",
        });
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
                  accelerator: "Alt+Shift+R",
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
                  accelerator: "Alt+Shift+R",
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
    if (!globalShortcut.register("Alt+Shift+R", startRecording))
      console.warn("The ⌥⇧R shortcut is in use by another app.");
    const template = [
      ...(process.platform === "darwin" ? [{ role: "appMenu" }] : []),
      {
        label: "File",
        submenu: [
          {
            label: "New recording",
            accelerator: "Alt+Shift+R",
            click: startRecording,
          },
          {
            label: "Setup guide",
            click: () => void whenStudioReady("relay:control", "onboarding"),
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
    dialog.showErrorBox("Relay could not start", error.message);
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
app.on("before-quit", (event) => {
  // Ask before anything is torn down: quitting closes the recording surfaces
  // (camera bubble, controls) before the studio gets to object.
  if (nativeStudio?.state().active && !leaving) {
    if (!confirmEndRecording()) return event.preventDefault();
    leaving = true;
  }
  quitting = true;
});
// The studio can still call a quit off after before-quit (see will-prevent-unload),
// so the library server and shortcuts stay until the quit is certain.
app.on("will-quit", () => {
  globalShortcut.unregisterAll();
  server?.kill();
});
