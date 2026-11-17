const {
  app,
  dialog,
  ipcMain,
  shell,
  autoUpdater: installer,
} = require("electron");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// Keeps a released copy of Relay up to date.
//
// A copy built with an update feed (electron-builder.config.cjs writes it into the
// app; the official release points at Relay's GitHub releases) checks that feed
// shortly after it opens and once a day while it runs. A newer version is
// downloaded in the background and checked against the SHA-512 published with it,
// then handed to macOS, which only accepts an app signed by the same developer as
// this one. It is installed when Relay next quits, or straight away if the user
// chooses to restart.
//
// Nothing here interrupts a recording: no check or download starts during one, a
// download under way is put off until it has finished, and nobody is asked to
// restart while a recording is being made or a video is still being worked on.
//
// These requests carry nothing about the user or the library. Every other copy
// (built from source, or somewhere macOS cannot replace it) only compares version
// numbers when asked, and offers the download page.
const RELEASES = "https://github.com/saassteve/relay-studio/";
const LATEST_RELEASE =
  "https://api.github.com/repos/saassteve/relay-studio/releases/latest";
const DAY = 24 * 60 * 60 * 1000;
const FIRST_CHECK = 15 * 1000;
const UNREACHABLE =
  "Couldn’t check for updates. Check your connection and try again.";

// Dotted numeric versions: newer("0.10.0", "0.9.3") is true.
function newer(a, b) {
  const x = a.split("."),
    y = b.split(".");
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (Number(x[i]) || 0) - (Number(y[i]) || 0);
    if (d) return d > 0;
  }
  return false;
}
// Only Relay's own release pages are ever opened in the browser.
function releasePage(url) {
  try {
    const href = new URL(url).href;
    return href.startsWith(RELEASES) ? href : "";
  } catch {
    return "";
  }
}

// The feed this copy was built with, if any.
function builtInFeed() {
  let text;
  try {
    text = fs.readFileSync(
      path.join(process.resourcesPath, "app-update.yml"),
      "utf8",
    );
  } catch {
    return null;
  }
  const field = (name) =>
    text
      .match(new RegExp(`^${name}:\\s*(.+)$`, "m"))?.[1]
      .trim()
      .replace(/^(["'])(.*)\1$/, "$2") || "";
  if (!field("provider")) return null;
  return {
    official:
      field("provider") === "github" &&
      RELEASES === `https://github.com/${field("owner")}/${field("repo")}/`,
    cache: field("updaterCacheDirName"),
  };
}

// macOS replaces the app where it stands, so it must be somewhere this user may
// write. A copy opened straight from the disk image or the Downloads folder runs
// from a read-only place instead.
function replaceable() {
  const bundle = path.resolve(process.execPath, "..", "..", "..");
  if (!bundle.endsWith(".app") || bundle.includes("/AppTranslocation/"))
    return false;
  try {
    fs.accessSync(bundle, fs.constants.W_OK);
    fs.accessSync(path.dirname(bundle), fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

// Development only: a feed on this computer, so the tests can follow a check and a
// download from start to finish. A packaged app never reads this.
function testFeed() {
  const url = process.env.RELAY_UPDATE_TEST_FEED || "";
  return !app.isPackaged && /^http:\/\/127\.0\.0\.1:\d+$/.test(url) ? url : "";
}

module.exports = function attachUpdates({
  trusted,
  window,
  // A recording is being set up, made or saved.
  recording = () => false,
  // Videos are still being rendered or processed: true, false, or null when that
  // can't be found out.
  working = async () => false,
  // Relay is about to restart into the update (true), or could not (false).
  onRestart = () => {},
}) {
  const settingsFile = path.join(
    app.getPath("userData"),
    "desktop-settings.json",
  );
  const readSettings = () => {
    try {
      const saved = JSON.parse(fs.readFileSync(settingsFile, "utf8"));
      return saved && typeof saved === "object" ? saved : {};
    } catch {
      return {};
    }
  };
  const local = testFeed();
  const feed = app.isPackaged ? builtInFeed() : null;
  // Whether Relay's own download page is where this copy's updates come from. A
  // copy that updates from somewhere else is never sent there.
  const official = !feed || feed.official;
  const placed = process.platform === "darwin" && replaceable();
  // "auto": installs updates itself. "manual": can only point to the download
  // page. "none": not a packaged copy.
  const mode = local
    ? "auto"
    : !app.isPackaged
      ? "none"
      : feed && placed
        ? "auto"
        : "manual";
  let state = {
      mode,
      // It would update itself if it were somewhere macOS could replace it.
      misplaced: Boolean(
        app.isPackaged && feed && process.platform === "darwin" && !placed,
      ),
      automatic: readSettings().autoUpdate !== false,
      version: app.getVersion(),
      // idle, checking, current, downloading, preparing, ready or failed.
      status: "idle",
    },
    updater,
    run,
    lastCheck = 0,
    token,
    // A download put off for a recording, to start again afterwards.
    postponed = false,
    resumeTimer,
    // The user asked for the update under way, so they hear if it fails.
    asked = false,
    // A version that would not download or install. It is not tried twice.
    refused = "",
    prompted = "",
    prompt,
    promptTimer,
    restarting = false,
    restartTimer;

  const publish = (next) => {
    state = { ...state, ...next };
    const target = window();
    if (target && !target.isDestroyed())
      target.webContents.send("relay:update-state", state);
  };
  const ready = () => `Relay ${state.latest} is ready. Restart to update.`;

  function engine() {
    if (updater) return updater;
    const { autoUpdater } = require("electron-updater");
    if (local) {
      const config = path.join(app.getPath("userData"), "update-test.yml");
      fs.writeFileSync(
        config,
        `provider: generic\nurl: ${local}\nupdaterCacheDirName: relay-video-updater-test\n`,
      );
      autoUpdater.forceDevUpdateConfig = true;
      autoUpdater.updateConfigPath = config;
    }
    // Relay decides when a download may start (never during a recording).
    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.allowPrerelease = false;
    autoUpdater.allowDowngrade = false;
    // Releases carry whole ZIPs, no block maps for partial downloads.
    autoUpdater.disableDifferentialDownload = true;
    // electron-updater would otherwise make an identifier for this installation,
    // keep it on disk and send it with every check (it is meant for staged
    // rollouts, which Relay does not use). No identifier is made or sent.
    autoUpdater.getOrCreateStagingUserId = async () =>
      "00000000-0000-0000-0000-000000000000";
    const headers = autoUpdater.computeFinalHeaders.bind(autoUpdater);
    autoUpdater.computeFinalHeaders = (given) => {
      const result = headers(given);
      delete result["x-user-staging-id"];
      return result;
    };
    autoUpdater.on("download-progress", (progress) => {
      const percent = Math.max(
        0,
        Math.min(99, Math.floor(progress.percent || 0)),
      );
      if (state.status === "downloading" && percent !== state.percent)
        publish({ percent });
    });
    // Downloaded and matched to its published SHA-512. macOS now unpacks it and
    // checks its signature.
    autoUpdater.on("update-downloaded", () => {
      if (state.status === "downloading")
        publish({ status: "preparing", percent: 100 });
    });
    autoUpdater.on("error", failed);
    updater = autoUpdater;
    return updater;
  }
  // macOS has accepted the update and will install it when Relay quits.
  installer.on("update-downloaded", () => {
    if (!state.latest) return;
    asked = false;
    publish({ status: "ready", percent: undefined });
    removeDownload();
    offerRestart();
  });

  // Failures are quiet: the status in Settings changes and nothing else, unless
  // the user asked for this update, who is then pointed to the download page.
  function failed(error) {
    console.error(`Update: ${error?.message || error}`);
    if (restarting) return restartFailed();
    // A later check that fails takes nothing away from an update already waiting.
    if (state.status === "ready") return;
    const lost = ["downloading", "preparing"].includes(state.status);
    if (lost) refused = state.latest;
    publish({ status: "failed", percent: undefined });
    if (lost && asked && official && !recording())
      void offerDownloadPage(state.latest);
    asked = false;
  }

  // The ZIP is no longer needed once macOS has its own copy, or after a restart.
  function removeDownload() {
    const name = local ? "relay-video-updater-test" : feed?.cache;
    if (!name || !/^[a-z0-9-]+-updater(-test)?$/.test(name)) return;
    fs.rm(
      path.join(os.homedir(), "Library", "Caches", name, "pending"),
      { recursive: true, force: true },
      () => {},
    );
  }

  function check(manual = false) {
    return (run ??= look(manual).finally(() => (run = undefined)));
  }
  // Resolves to "current", "started", "ready", "postponed" or "failed".
  async function look(manual) {
    lastCheck = Date.now();
    const waiting = state.status === "ready";
    if (!waiting) publish({ status: "checking", percent: undefined });
    let result;
    try {
      result = await engine().checkForUpdates();
    } catch {
      // Already reported through the updater's "error" event.
      return "failed";
    }
    const latest = String(result?.updateInfo?.version || "");
    if (!result?.isUpdateAvailable || !latest) {
      if (!waiting) publish({ status: "current", latest: undefined });
      return waiting ? "ready" : "current";
    }
    if (waiting && state.latest === latest) return "ready";
    if (refused === latest) {
      publish({ status: "failed", latest });
      return "failed";
    }
    if (recording()) {
      postponed = true;
      publish({ status: "idle", latest });
      return "postponed";
    }
    asked = manual;
    token = result.cancellationToken;
    publish({ status: "downloading", latest, percent: 0 });
    const mine = token;
    engine()
      .downloadUpdate(mine)
      .catch((error) => {
        // Stopped for a recording. Real failures arrive as "error" events.
        if (mine.cancelled && state.status === "downloading") {
          postponed = true;
          publish({ status: "idle", percent: undefined });
        } else if (!mine.cancelled) failed(error);
      });
    return "started";
  }

  // Picks up a download that was put off for a recording.
  function resume() {
    resumeTimer = undefined;
    if (!postponed) return;
    if (recording()) return void (resumeTimer = setTimeout(resume, 60000));
    postponed = false;
    void check(asked);
  }
  function tick() {
    if (mode !== "auto" || !state.automatic || recording()) return;
    if (lastCheck && Date.now() - lastCheck < DAY) return;
    void check();
  }

  // Asked once for each update, and only when Relay is in front of the user with
  // nothing under way. Until then, and after "Later", the update simply waits for
  // the next quit.
  async function offerRestart() {
    clearTimeout(promptTimer);
    if (state.status !== "ready" || prompted === state.latest || prompt) return;
    const again = () => {
      promptTimer = setTimeout(offerRestart, 30000);
    };
    const target = window();
    if (
      recording() ||
      !target ||
      target.isDestroyed() ||
      !target.isVisible() ||
      target.isMinimized() ||
      (await working()) !== false ||
      recording()
    )
      return again();
    const mine = (prompt = new AbortController());
    try {
      const { response } = await dialog.showMessageBox(target, {
        type: "info",
        message: ready(),
        detail:
          "Your library stays as it is. If you choose Later, Relay updates the next time you quit it.",
        buttons: ["Restart", "Later"],
        defaultId: 0,
        cancelId: 1,
        signal: mine.signal,
      });
      // Closed because a recording began: ask again when it is over.
      if (mine.signal.aborted) return again();
      prompted = state.latest;
      if (response === 0 && !(await restart()).ok) {
        // Something began in the meantime. Ask again when it is over.
        prompted = "";
        again();
      }
    } catch {
      again();
    } finally {
      if (prompt === mine) prompt = undefined;
    }
  }

  async function restart() {
    if (state.status !== "ready" || restarting)
      return { ok: false, status: "No update is ready yet." };
    if (recording())
      return {
        ok: false,
        status: "Finish the recording first. Relay updates when it restarts.",
      };
    if ((await working()) === true)
      return {
        ok: false,
        status:
          "Relay is still working on a video. Restart once it has finished.",
      };
    if (recording() || state.status !== "ready" || restarting)
      return { ok: false, status: "Relay can’t restart just now." };
    restarting = true;
    onRestart(true);
    // If Relay is somehow still here, give the studio back.
    restartTimer = setTimeout(restartFailed, 30000);
    setImmediate(() => {
      try {
        engine().quitAndInstall();
      } catch (error) {
        failed(error);
      }
    });
    return { ok: true, status: `Restarting to install Relay ${state.latest}…` };
  }
  function restartFailed() {
    if (!restarting) return;
    restarting = false;
    clearTimeout(restartTimer);
    publish({ status: "failed" });
    onRestart(false);
  }

  async function offerDownloadPage(latest, url = `${RELEASES}releases/latest`) {
    const status = `Relay ${latest} is available.`;
    const page = releasePage(url);
    if (!page) return { status };
    const answer = await dialog.showMessageBox(window(), {
      type: "info",
      message: status,
      detail: `You have ${state.version}. The new version is on Relay’s download page; your library stays as it is.`,
      buttons: ["Open download page", "Later"],
      defaultId: 0,
      cancelId: 1,
    });
    if (answer.response === 0) void shell.openExternal(page);
    return { status, url: page };
  }
  // For copies that cannot update themselves, and when updating fails: compare
  // with the latest GitHub release and point to its download page.
  async function comparePublished() {
    let release, latest;
    try {
      const response = await fetch(LATEST_RELEASE, {
        headers: {
          "User-Agent": "Relay",
          Accept: "application/vnd.github+json",
        },
        redirect: "error",
        signal: AbortSignal.timeout(10000),
      });
      if (!response.ok) throw new Error(`GitHub answered ${response.status}.`);
      release = await response.json();
      latest = String(release.tag_name).replace(/^v/, "");
      if (!/^\d+(\.\d+)*$/.test(latest))
        throw new Error("Unreadable release version.");
    } catch (error) {
      console.error(error);
      return { status: UNREACHABLE };
    }
    if (!newer(latest, state.version))
      return { status: `You have the latest version (${state.version}).` };
    return offerDownloadPage(latest, release.html_url);
  }

  ipcMain.handle("relay:updates", async (event) => {
    if (!trusted(event)) throw new Error("Untrusted request");
    if (mode === "none")
      return { status: "Updates are available in packaged releases." };
    if (state.status === "ready") return { status: ready() };
    if (["downloading", "preparing"].includes(state.status))
      return { status: `Relay ${state.latest} is downloading.` };
    if (recording())
      return { status: "Check again once the recording has finished." };
    if (mode === "manual")
      return official ? comparePublished() : { status: UNREACHABLE };
    const stuck = () => ({
      status: `Relay ${refused} couldn’t be installed automatically.`,
    });
    const outcome = await check(true);
    if (outcome === "current")
      return { status: `You have the latest version (${state.version}).` };
    if (outcome === "started")
      return {
        status: `Relay ${state.latest} is downloading. You can keep working.`,
      };
    if (outcome === "ready") return { status: ready() };
    if (outcome === "postponed")
      return {
        status: `Relay ${state.latest} downloads once the recording has finished.`,
      };
    // This version would not install by itself, or the check failed.
    if (refused) return official ? offerDownloadPage(refused) : stuck();
    return official && !local ? comparePublished() : { status: UNREACHABLE };
  });
  ipcMain.handle("relay:update-state", (event) => {
    if (!trusted(event)) throw new Error("Untrusted request");
    return state;
  });
  ipcMain.handle("relay:update-automatic", (event, on) => {
    if (!trusted(event)) throw new Error("Untrusted request");
    const automatic = on === true;
    try {
      fs.writeFileSync(
        settingsFile,
        JSON.stringify({ ...readSettings(), autoUpdate: automatic }, null, 2),
      );
    } catch (error) {
      console.error(error);
      throw new Error("Relay couldn’t save that setting.");
    }
    publish({ automatic });
    if (automatic) tick();
    return state;
  });
  ipcMain.handle("relay:update-restart", (event) => {
    if (!trusted(event)) throw new Error("Untrusted request");
    return restart();
  });

  if (mode === "auto") {
    // Left over from an update that has since been installed.
    removeDownload();
    setTimeout(tick, FIRST_CHECK);
    setInterval(tick, 10 * 60 * 1000);
  }
  app.on("before-quit", () => {
    clearTimeout(promptTimer);
    clearTimeout(resumeTimer);
  });
  return {
    state: () => state,
    // Called whenever a recording starts or ends. It runs in the middle of starting
    // a recording, so nothing it does may get in that recording's way.
    recordingChanged(active) {
      try {
        if (active) {
          clearTimeout(resumeTimer);
          resumeTimer = undefined;
          prompt?.abort();
          if (state.status === "downloading" && token && !token.cancelled) {
            postponed = true;
            token.cancel();
          }
          return;
        }
        // Told more than once while nothing is recording: one timer is enough.
        if (postponed && !resumeTimer) resumeTimer = setTimeout(resume, 90000);
      } catch (error) {
        console.error(`Update: ${error?.message || error}`);
      }
    },
  };
};
