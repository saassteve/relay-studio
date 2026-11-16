import { _electron as electron } from "@playwright/test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { mkdtempSync, rmSync, realpathSync } from "node:fs";
const data = mkdtempSync(path.join(os.tmpdir(), "relay-desktop-test-"));
const env = { ...process.env, ELECTRON_ENABLE_LOGGING: "1" };
delete env.ELECTRON_RUN_AS_NODE;
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
  assert.equal(new URL(window.url()).port, "41730");

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
  const updates = await window.evaluate(() =>
    window.relayDesktop.checkForUpdates(),
  );
  assert.match(
    updates.status,
    /packaged|feed|latest|available|check for updates/,
  );
  await window.evaluate(() => {
    window.__desktopActions = [];
    window.relayDesktop.onControl((a) => window.__desktopActions.push(a));
  });
  const floatingPromise = app.waitForEvent("window");
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
  let countdownWindow = app.waitForEvent("window");
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
  countdownWindow = app.waitForEvent("window");
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
  console.log(
    "Desktop smoke passed: stable library port, resumable onboarding, permission checklist, native countdown, hide/restore, recording shortcuts, floating controls, teleprompter and update/permission APIs.",
  );
} finally {
  await app.close();
  rmSync(data, { recursive: true, force: true });
}
