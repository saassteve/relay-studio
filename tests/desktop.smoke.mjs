import { _electron as electron } from "@playwright/test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import net from "node:net";
import http from "node:http";
import { randomBytes } from "node:crypto";
import {
  mkdtempSync,
  rmSync,
  realpathSync,
  existsSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { describe, serialize } from "../scripts/update-manifest.mjs";
const data = mkdtempSync(path.join(os.tmpdir(), "relay-desktop-test-"));
const version = JSON.parse(readFileSync("package.json", "utf8")).version;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// A stand-in for Relay's releases, on this computer: latest-mac.yml and the two
// ZIPs it lists. Relay only reads such a feed when run from source
// (RELAY_UPDATE_TEST_FEED in desktop/updates.cjs), so this part is skipped for a
// packaged app. It follows a check and a download as far as an unsigned app can
// go: macOS only installs an update signed like the app it replaces.
const feed = process.env.RELAY_TEST_APP
  ? null
  : { version, mode: "good", requests: [] };
const feedFiles = mkdtempSync(path.join(os.tmpdir(), "relay-feed-test-"));
const updateCache = path.join(
  os.homedir(),
  "Library",
  "Caches",
  "relay-video-updater-test",
);
// Pass or fail, nothing is left behind.
process.on("exit", () => {
  for (const folder of [data, feedFiles, ...(feed ? [updateCache] : [])])
    rmSync(folder, { recursive: true, force: true });
});
let feedServer;
if (feed) {
  const zips = ["Relay-mac-arm64.zip", "Relay-mac-x64.zip"].map((name) => {
    const file = path.join(feedFiles, name);
    writeFileSync(file, randomBytes(300_000));
    return file;
  });
  feedServer = http.createServer(async (req, res) => {
    const { pathname } = new URL(req.url, "http://127.0.0.1");
    feed.requests.push({ path: pathname, headers: req.headers });
    if (pathname === "/latest-mac.yml")
      return res.end(serialize(await describe(feed.version, zips)));
    const zip = zips.find((file) => `/${path.basename(file)}` === pathname);
    if (!zip) return res.writeHead(404).end();
    const bytes = readFileSync(zip);
    res.setHeader("Content-Length", bytes.length);
    // Not the file the manifest describes.
    if (feed.mode === "tampered") return res.end(Buffer.alloc(bytes.length, 7));
    // A download that never finishes by itself.
    if (feed.mode === "stalled") return res.write(bytes.subarray(0, 50_000));
    res.end(bytes);
  });
  await new Promise((r) => feedServer.listen(0, "127.0.0.1", r));
}
// An installed Relay that is open holds the usual port, so the test takes 41730
// only when it is free, and any other free port otherwise.
const freePort = (preferred) =>
  new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", (error) =>
      preferred && error.code === "EADDRINUSE"
        ? resolve(freePort(0))
        : reject(error),
    );
    probe.listen(preferred, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(String(port)));
    });
  });
const port = await freePort(41730);
const env = { ...process.env, ELECTRON_ENABLE_LOGGING: "1", RELAY_PORT: port };
delete env.ELECTRON_RUN_AS_NODE;
delete env.RELAY_UPDATE_TEST_FEED;
const plainEnv = { ...env };
if (feed)
  env.RELAY_UPDATE_TEST_FEED = `http://127.0.0.1:${feedServer.address().port}`;
const app = await electron.launch({
  ...(process.env.RELAY_TEST_APP
    ? {
        executablePath: process.env.RELAY_TEST_APP,
        args: [`--user-data-dir=${data}`],
      }
    : { args: [".", `--user-data-dir=${data}`] }),
  cwd: process.cwd(),
  env,
  timeout: 180000,
});
try {
  assert.equal(
    realpathSync(await app.evaluate(({ app }) => app.getPath("userData"))),
    realpathSync(data),
    "Desktop test must use its isolated application-data folder",
  );
  // A packaged first launch shows the video-engine setup window before the studio.
  const first = await app.firstWindow({ timeout: 180000 });
  let window = first;
  if (!first.url().startsWith("http")) {
    assert.match(await first.title(), /Setting up Relay/);
    await first.waitForSelector("#bar");
    console.log("Engine setup window shown on first launch.");
    window =
      app.windows().find((w) => w.url().startsWith("http")) ||
      (await app.waitForEvent("window", {
        predicate: (w) => w.url().startsWith("http"),
        timeout: 180000,
      }));
  }
  window.setDefaultTimeout(60000);
  await window.waitForSelector(".app-shell");
  await window.waitForFunction(() => document.title.endsWith("· Relay"));
  const info = await window.evaluate(() => window.relayDesktop.info());
  assert.equal(info.stablePort, true, "Library should use its stable port");
  assert.equal(new URL(window.url()).port, port);

  // First run: guided setup, resumable after a reload or relaunch.
  const setup = window.getByRole("dialog", { name: "Set up Relay" });
  await setup.waitFor();
  await setup.getByRole("button", { name: /Let’s get set up/ }).click();
  await setup.getByLabel("Your name").fill("Morgan Lee");
  await setup.getByRole("button", { name: "Continue" }).click();
  await setup
    .getByRole("heading", { name: "A few quick permissions." })
    .waitFor();
  for (const kind of ["screen", "camera", "microphone", "audio"])
    await setup.locator(`[data-permission="${kind}"]`).waitFor();
  await window.screenshot({
    path: "test-results/desktop-onboarding-permissions.png",
  });
  await window.reload();
  await setup
    .getByRole("heading", { name: "A few quick permissions." })
    .waitFor();
  await window.keyboard.press("Escape");
  await setup.waitFor({ state: "hidden" });
  await window.waitForFunction(() =>
    document
      .querySelector(".profile-row .avatar")
      ?.textContent?.startsWith("M"),
  );
  assert.ok(
    await app.evaluate(({ Menu }) =>
      Menu.getApplicationMenu()
        .items.flatMap((i) => i.submenu?.items || [])
        .some((i) => i.label === "Setup guide"),
    ),
  );
  assert.equal(
    await window.evaluate(() => window.relayDesktop.platform),
    process.platform,
  );
  const registered = await app.evaluate(({ globalShortcut }) =>
    globalShortcut.isRegistered("Alt+Shift+R"),
  );
  assert.equal(registered, true);
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].webContents.send("relay:record"),
  );
  await window.waitForSelector('[aria-label="New recording"]');
  const permissions = await window.evaluate(() =>
    window.relayDesktop.permissionStatus(),
  );
  assert.ok(permissions.screen);
  // The update check asks the library whether it is busy, from the main process.
  const jobs = await app.evaluate(async ({ session }, base) => {
    const [cookie] = await session.defaultSession.cookies.get({
      url: base,
      name: "relay_local",
    });
    const response = await fetch(`${base}/api/jobs`, {
      headers: { Cookie: `relay_local=${cookie.value}` },
    });
    return { status: response.status, jobs: await response.json() };
  }, new URL(window.url()).origin);
  assert.equal(jobs.status, 200);
  assert.ok(Array.isArray(jobs.jobs));
  const updateState = () =>
    window.evaluate(() => window.relayDesktop.updateState());
  const checkForUpdates = () =>
    window.evaluate(() => window.relayDesktop.checkForUpdates());
  const untilUpdate = async (check, message, seconds = 30) => {
    let state;
    for (let i = 0; i < seconds * 5; i++) {
      state = await updateState();
      if (check(state)) return state;
      await sleep(200);
    }
    assert.fail(`${message} (update state: ${JSON.stringify(state)})`);
  };
  if (!feed) {
    const state = await updateState();
    assert.match(state.mode, /^(auto|manual)$/);
    assert.equal(typeof state.automatic, "boolean");
    assert.match(
      (await checkForUpdates()).status,
      /latest|available|ready|downloading|check for updates/,
    );
  } else {
    // Any question Relay would ask is answered "Later", and noted.
    await app.evaluate(({ dialog }) => {
      globalThis.__relayAsked = [];
      dialog.showMessageBox = async (...args) => {
        globalThis.__relayAsked.push(args.at(-1).message);
        return { response: 1, checkboxChecked: false };
      };
    });
    const asked = () => app.evaluate(() => globalThis.__relayAsked);
    await window.evaluate(() => {
      window.__updateSteps = [];
      window.relayDesktop.onUpdateState((s) =>
        window.__updateSteps.push(s.status),
      );
    });
    const steps = () => window.evaluate(() => window.__updateSteps.splice(0));
    const fetched = (file) =>
      feed.requests.filter((r) => r.path === file).length;

    // By itself, shortly after opening: nothing newer is published.
    let state = await untilUpdate(
      (s) => s.status === "current",
      "Relay checks for updates shortly after it opens",
      45,
    );
    assert.equal(state.mode, "auto");
    assert.equal(state.automatic, true);
    assert.equal(state.version, version);
    assert.equal(fetched("/latest-mac.yml"), 1);
    assert.equal(feed.requests.length, 1);
    assert.match(
      (await checkForUpdates()).status,
      new RegExp(`latest version \\(${version.replaceAll(".", "\\.")}\\)`),
    );

    // A newer version whose download is not the file that was published.
    feed.version = "99.0.0";
    feed.mode = "tampered";
    await steps();
    assert.match(
      (await checkForUpdates()).status,
      /Relay 99\.0\.0 is downloading/,
    );
    state = await untilUpdate(
      (s) => s.status === "failed",
      "A download that does not match its SHA-512 is refused",
    );
    assert.equal(state.latest, "99.0.0");
    let seen = await steps();
    assert.ok(seen.includes("downloading"), `Steps: ${seen}`);
    assert.ok(!seen.includes("preparing"), `Steps: ${seen}`);
    assert.ok(!seen.includes("ready"), `Steps: ${seen}`);
    // The user asked for it, so they are pointed to the download page instead.
    assert.deepEqual(await asked(), ["Relay 99.0.0 is available."]);
    // It is not downloaded a second time.
    const before = feed.requests.length;
    assert.equal(
      (await checkForUpdates()).status,
      "Relay 99.0.0 is available.",
    );
    assert.equal(feed.requests.length, before + 1);
    assert.equal((await asked()).length, 2);

    // A newer version, downloaded whole and matched to its SHA-512. Handing it
    // to macOS is as far as an unsigned app gets.
    feed.version = "99.0.1";
    feed.mode = "good";
    await steps();
    assert.match(
      (await checkForUpdates()).status,
      /Relay 99\.0\.1 is downloading/,
    );
    state = await untilUpdate(
      (s) => s.status === "ready" || s.status === "failed",
      "A good download is checked and handed to macOS",
      90,
    );
    seen = await steps();
    assert.ok(
      seen.indexOf("downloading") >= 0 &&
        seen.indexOf("preparing") > seen.indexOf("downloading"),
      `Steps: ${seen}`,
    );
    const arch = process.arch === "arm64" ? "arm64" : "x64";
    const other = arch === "arm64" ? "x64" : "arm64";
    assert.equal(fetched(`/Relay-mac-${arch}.zip`), 2);
    assert.equal(fetched(`/Relay-mac-${other}.zip`), 0);
    console.log(
      state.status === "ready"
        ? "Update check: macOS accepted the test update."
        : "Update check: download verified; macOS declined to install it into this unsigned app, as expected.",
    );

    // The choice to look for updates is kept with the app's own settings.
    const settings = () =>
      JSON.parse(
        readFileSync(path.join(data, "desktop-settings.json"), "utf8"),
      );
    state = await window.evaluate(() =>
      window.relayDesktop.setAutomaticUpdates(false),
    );
    assert.equal(state.automatic, false);
    assert.deepEqual(settings(), { autoUpdate: false });
    state = await window.evaluate(() =>
      window.relayDesktop.setAutomaticUpdates(true),
    );
    assert.equal(state.automatic, true);
    assert.deepEqual(settings(), { autoUpdate: true });
    if (state.status !== "ready")
      assert.equal(
        (await window.evaluate(() => window.relayDesktop.restartToUpdate())).ok,
        false,
      );

    // A download under way when a recording starts (just below).
    feed.version = "99.0.2";
    feed.mode = "stalled";
    assert.match(
      (await checkForUpdates()).status,
      /Relay 99\.0\.2 is downloading/,
    );
    for (let i = 0; i < 100 && fetched(`/Relay-mac-${arch}.zip`) < 3; i++)
      await sleep(100);
    assert.equal(fetched(`/Relay-mac-${arch}.zip`), 3);
    assert.equal((await updateState()).status, "downloading");
  }
  await window.evaluate(() => {
    window.__desktopActions = [];
    window.relayDesktop.onControl((a) => window.__desktopActions.push(a));
  });
  // A new window can take a while to load on a busy machine or a hosted runner.
  const newWindow = () => app.waitForEvent("window", { timeout: 120000 });
  const floatingPromise = newWindow();
  await window.evaluate(() =>
    window.relayDesktop.captureState({
      active: true,
      paused: false,
      seconds: 42,
      notes: "Explain the next step.",
    }),
  );
  const floating = await floatingPromise;
  await floating.waitForSelector("#retake");
  assert.equal(await floating.title(), "Relay recording controls");
  await floating.waitForFunction(
    () => document.getElementById("time").textContent === "0:42",
  );
  assert.match(
    await floating.locator("#notes").innerText(),
    /Explain the next step/,
  );
  await floating.locator("#retake").click();
  await window.waitForFunction(() =>
    window.__desktopActions.includes("retake"),
  );
  if (feed) {
    // Updates keep out of the way of a recording: the download stops, nothing
    // new is fetched, and Relay will not restart.
    const state = await untilUpdate(
      (s) => s.status === "idle",
      "A download stops when a recording starts",
    );
    assert.equal(state.latest, "99.0.2");
    const before = feed.requests.length;
    assert.match(
      (await checkForUpdates()).status,
      /once the recording has finished/,
    );
    assert.equal(
      (await window.evaluate(() => window.relayDesktop.restartToUpdate())).ok,
      false,
    );
    assert.equal(feed.requests.length, before);
    // Nothing Relay sent says who or what is asking.
    for (const { headers } of feed.requests) {
      assert.equal(headers["x-user-staging-id"], undefined);
      assert.equal(headers.cookie, undefined);
      assert.equal(headers.authorization, undefined);
      assert.equal(headers["user-agent"], "electron-builder");
    }
    assert.equal(existsSync(path.join(data, ".updaterId")), false);
  }
  await window.evaluate(() =>
    window.relayDesktop.captureState({
      active: false,
      paused: false,
      seconds: 0,
      notes: "",
    }),
  );
  // Native recording surfaces: countdown, hide-and-restore, recording-only shortcuts.
  const isVisible = () =>
    app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()
        .find((w) => w.webContents.getURL().startsWith("http"))
        .isVisible(),
    );
  let countdownWindow = newWindow();
  const cancelled = window.evaluate(() =>
    window.relayDesktop.prepareRecording({
      screen: true,
      hideWindow: true,
      countdown: 5,
      bubble: false,
      bubbleSize: "m",
      cameraId: "",
    }),
  );
  let countdown = await countdownWindow;
  await countdown.waitForSelector("#n");
  // Escape closes the countdown on key-down, before Playwright sends key-up.
  await countdown.keyboard.press("Escape").catch(() => {});
  assert.deepEqual(await cancelled, { cancelled: true });
  // The window was hidden for the countdown and comes straight back on cancel.
  assert.equal(await isVisible(), true, "Studio returns after cancelling");
  countdownWindow = newWindow();
  const started = window.evaluate(() =>
    window.relayDesktop.prepareRecording({
      screen: true,
      hideWindow: true,
      countdown: 5,
      bubble: false,
      bubbleSize: "m",
      cameraId: "",
    }),
  );
  countdown = await countdownWindow;
  await countdown.waitForSelector("#dial");
  assert.equal(await isVisible(), false, "Studio hides during capture");
  await countdown
    .locator("#dial")
    .click()
    .catch(() => {});
  assert.deepEqual(await started, { cancelled: false });
  assert.equal(await isVisible(), false);
  assert.equal(
    await window.evaluate(() => window.relayDesktop.cameraLayout()),
    null,
  );
  const shortcut = (key) =>
    app.evaluate(
      ({ globalShortcut }, k) => globalShortcut.isRegistered(k),
      key,
    );
  assert.equal(await shortcut("Alt+Shift+P"), false);
  await window.evaluate(() =>
    window.relayDesktop.captureState({
      active: true,
      paused: false,
      seconds: 3,
      notes: "",
    }),
  );
  const until = async (check, message) => {
    for (let i = 0; i < 50; i++) {
      if (await check()) return;
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.fail(message);
  };
  await until(() => shortcut("Alt+Shift+P"), "Pause shortcut while recording");
  assert.equal(await shortcut("Alt+Shift+C"), true);
  await window.evaluate(() =>
    window.relayDesktop.captureState({
      active: false,
      paused: false,
      seconds: 0,
      notes: "",
    }),
  );
  await until(
    async () => !(await shortcut("Alt+Shift+P")),
    "Shortcut released",
  );
  await until(isVisible, "Studio returns after recording");
  await window.screenshot({ path: "test-results/desktop-studio.png" });
  const fixture = await window.request.post(
    new URL("/api/videos", window.url()).href,
    {
      multipart: {
        title: "Playback and scrolling",
        duration: "15",
        video: {
          name: "presenter.mp4",
          mimeType: "video/mp4",
          buffer: readFileSync("scripts/assets/presenter.mp4"),
        },
      },
    },
  );
  assert.ok(fixture.ok(), await fixture.text());
  const { id } = await fixture.json();
  await window.goto(new URL(`/video/${id}`, window.url()).href);
  await window.setViewportSize({ width: 1240, height: 720 });
  await window.getByRole("button", { name: "Play", exact: true }).click();
  const stage = window.locator(".stage");
  const box = await stage.boundingBox();
  const scroll = await window.evaluate(() => scrollY);
  await window.mouse.move(box.x + box.width / 2, Math.max(30, box.y + 160));
  await window.mouse.wheel(0, 450);
  await window.waitForFunction((from) => scrollY > from + 100, scroll);
  const video = stage.locator("video").first();
  await until(
    () => video.evaluate((clip) => !clip.paused && clip.currentTime > 0.1),
    "Editor playback continues while the window scrolls",
  );
  assert.equal((await stage.boundingBox()).height, box.height);
  console.log(
    "Desktop smoke passed: stable library port, resumable onboarding, permission checklist, native countdown, hide/restore, recording shortcuts, floating controls, teleprompter, update/permission APIs and scrolling during editor playback.",
  );
} finally {
  // A failure part-way can leave a recording marked active. Relay would then ask
  // before quitting, with nobody there to answer: choose "Close anyway" for it.
  await app
    .evaluate(({ dialog }) => {
      dialog.showMessageBoxSync = () => 1;
    })
    .catch(() => {});
  await app.close();
}
// Run from source without a feed, Relay does not look for updates at all, and it
// remembers that it was told not to.
let plain;
try {
  if (feed) {
    const before = feed.requests.length;
    // A folder of its own. Opened a second time on the first one, the page's
    // offline helper starts before the page does, and the test driver holds
    // every helper at its start: the window would wait on it for ever. Relay
    // opened by hand has no such driver and reopens on the same folder as usual.
    const fresh = mkdtempSync(path.join(os.tmpdir(), "relay-desktop-test-"));
    writeFileSync(
      path.join(fresh, "desktop-settings.json"),
      JSON.stringify({ autoUpdate: false }),
    );
    plain = await electron.launch({
      args: [".", `--user-data-dir=${fresh}`],
      cwd: process.cwd(),
      env: plainEnv,
      timeout: 180000,
    });
    const window = await plain.firstWindow({ timeout: 180000 });
    window.setDefaultTimeout(60000);
    await window.waitForSelector(".app-shell");
    const state = await window.evaluate(() =>
      window.relayDesktop.updateState(),
    );
    assert.equal(state.mode, "none");
    assert.equal(state.automatic, false);
    assert.equal(state.status, "idle");
    assert.equal(
      (await window.evaluate(() => window.relayDesktop.checkForUpdates()))
        .status,
      "Updates are available in packaged releases.",
    );
    assert.equal(
      (await window.evaluate(() => window.relayDesktop.restartToUpdate())).ok,
      false,
    );
    assert.equal(feed.requests.length, before);
    console.log(
      "Update checks passed: automatic check after launch, SHA-512 refusal, verified download, right ZIP for this Mac, saved setting, no identifying headers, nothing during a recording, nothing when run from source.",
    );
  }
} finally {
  await plain?.close();
  feedServer?.closeAllConnections();
  feedServer?.close();
}
