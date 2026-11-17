import { test, expect } from "@playwright/test";
test("capture, edit, export, share, comment, revoke; responsive library", async ({
  page,
  browser,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.addInitScript(() => {
    function videoStream() {
      const c = document.createElement("canvas");
      c.width = 640;
      c.height = 360;
      const ctx = c.getContext("2d")!;
      let t = 0;
      setInterval(() => {
        ctx.fillStyle = "#173e32";
        ctx.fillRect(0, 0, 640, 360);
        ctx.fillStyle = "#d6f475";
        ctx.font = "30px sans-serif";
        ctx.fillText(`Relay capture ${t++}`, 60, 170);
      }, 40);
      return c.captureStream(25);
    }
    Object.defineProperty(navigator.mediaDevices, "getDisplayMedia", {
      value: async () => videoStream(),
    });
    Object.defineProperty(navigator.mediaDevices, "getUserMedia", {
      value: async (c: MediaStreamConstraints) => {
        const s = c.video ? videoStream() : new MediaStream();
        if (c.audio) {
          const a = new AudioContext();
          const o = a.createOscillator();
          const d = a.createMediaStreamDestination();
          o.connect(d);
          o.start();
          s.addTrack(d.stream.getAudioTracks()[0]);
        }
        return s;
      },
    });
  });
  await page.request.put("/api/preferences", {
    data: { onboarded: null, onboardingStep: null },
  });
  await page.goto("/");
  // First run: the guided setup opens over the library.
  const setup = page.getByRole("dialog", { name: "Set up Relay" });
  await expect(setup).toBeVisible();
  await expect(
    setup.getByRole("heading", { name: /Say it once/ }),
  ).toBeVisible();
  await page.screenshot({ path: "test-results/onboarding-welcome.png" });
  await setup.getByRole("button", { name: /Let’s get set up/ }).click();
  await setup.getByLabel("Your name").fill("Avery Quinn");
  await expect(setup.locator(".name-preview .avatar")).toHaveText("A");
  await setup.getByRole("button", { name: "Continue" }).click();
  await expect(
    setup.getByRole("heading", { name: "Looking good. Sounding good?" }),
  ).toBeVisible();
  await expect(setup.locator(".check-status")).toHaveText(/Sounds great|loud/, {
    timeout: 15000,
  });
  await page.screenshot({ path: "test-results/onboarding-check.png" });
  await setup.getByRole("button", { name: "Continue" }).click();
  await expect(
    setup.getByRole("heading", { name: "Make it yours." }),
  ).toBeVisible();
  // On this computer there is no link to copy, so setup just says what happens.
  await expect(
    setup.getByText("Open the editor", { exact: true }),
  ).toBeVisible();
  await setup.getByRole("radio", { name: "3 sec" }).click();
  await page.screenshot({ path: "test-results/onboarding-prefs.png" });
  await setup.getByRole("button", { name: "Looks good" }).click();
  await expect(
    setup.getByRole("heading", { name: /You’re all set, Avery/ }),
  ).toBeVisible();
  // Reloading mid-way is safe; finishing persists on the server.
  const prefs = await (await page.request.get("/api/preferences")).json();
  expect(prefs).toMatchObject({
    countdown: 3,
    onboardingStep: "ready",
  });
  await setup.getByRole("button", { name: "Take me to my library" }).click();
  await expect(setup).toBeHidden();
  expect(
    (await (await page.request.get("/api/preferences")).json()).onboarded,
  ).toBe(true);
  await expect(page.locator(".profile-row")).toContainText("Avery");
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Library", level: 1 }),
  ).toBeVisible();
  await expect(setup).toBeHidden();
  await page.screenshot({
    path: "test-results/library-desktop.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "New recording" }).first().click();
  await page.getByRole("radio", { name: "Screen only", exact: true }).click();
  // A slow native source list must show progress immediately, and Back must
  // keep a late response from reopening the picker.
  await page.evaluate(() => {
    Object.defineProperty(window, "relayDesktop", {
      configurable: true,
      value: {
        sources: () =>
          new Promise((resolve) => {
            Object.assign(window, { __resolveSources: resolve });
          }),
      },
    });
  });
  await page.getByRole("button", { name: "Start recording" }).click();
  await expect(
    page.getByText("Finding your screens and windows…"),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Start recording" }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Back", exact: true }).click();
  await page.evaluate(() => {
    Reflect.get(
      window,
      "__resolveSources",
    )([{ id: "screen:0:0", name: "Screen", thumbnail: "" }]);
  });
  await expect(page.locator(".source-picker")).toHaveCount(0);
  await page.evaluate(() => {
    Reflect.deleteProperty(window, "relayDesktop");
  });
  await page.getByRole("button", { name: "Start recording" }).click();
  await expect(page.locator(".recorder-countdown")).toBeVisible();
  await expect(page.locator(".rec-live")).toContainText("Recording");
  await expect(page.locator(".rec-live b")).toHaveText("0:02", {
    timeout: 10000,
  });
  await page.getByRole("button", { name: "Pause", exact: true }).click();
  await expect(page.locator(".rec-live")).toContainText("Paused");
  await page.getByRole("button", { name: "Resume", exact: true }).click();
  await expect(page.locator(".rec-live b")).toHaveText("0:03", {
    timeout: 10000,
  });
  await page.getByRole("button", { name: "Finish recording" }).click();
  await page
    .getByRole("textbox", { name: "Video title" })
    .fill("A real capture test");
  await page.getByRole("button", { name: "Open in editor" }).click();
  await expect(page.getByRole("textbox", { name: "Video title" })).toHaveValue(
    "A real capture test",
    { timeout: 15000 },
  );
  // The editor opens on a live preview of the video, straight from the recording.
  await expect
    .poll(() =>
      page
        .locator(".draft-box video")
        .first()
        .evaluate((v: HTMLVideoElement) => v.readyState),
    )
    .toBeGreaterThan(1);
  await expect(page.locator(".save-state")).toHaveText("Video is up to date");
  await page.getByRole("tab", { name: "Notes", exact: true }).click();
  await page
    .getByRole("textbox", { name: "Video notes" })
    .fill("Clear context, without the meeting.");
  // Notes save themselves when you click away.
  await page.getByRole("textbox", { name: "Video notes" }).blur();
  await expect(
    page.getByText(/^Saved\. Viewers see these notes/),
  ).toBeVisible();
  // Trim the start: it saves by itself, and one button puts it in the video.
  await page.getByLabel("Section start").fill("0.5");
  await expect(page.locator(".save-state")).toHaveText(
    /^Edits saved\. Update the video/,
  );
  await page.getByRole("button", { name: "Play", exact: true }).click();
  await expect
    .poll(() =>
      page
        .locator(".draft-box video")
        .first()
        .evaluate((v: HTMLVideoElement) => v.currentTime),
    )
    .toBeGreaterThan(0.7);
  await page.getByRole("button", { name: "Pause", exact: true }).click();
  await page.getByRole("button", { name: "Update video" }).click();
  await expect(page.getByText(/Video updated/)).toBeVisible({ timeout: 60000 });
  await expect(page.locator(".save-state")).toHaveText("Video is up to date");
  await page.getByRole("button", { name: "Save as new video" }).click();
  await expect(
    page.getByText("Saved as a new video in your library"),
  ).toBeVisible({ timeout: 60000 });
  await page.getByRole("button", { name: "Send", exact: true }).click();
  // On this computer the dialog leads with downloading; the share page sits below.
  const send = page.getByRole("dialog", { name: "Send this video" });
  await expect(send).toBeVisible();
  await expect(
    send.getByRole("link", { name: "Download video" }),
  ).toBeVisible();
  await send.getByText("Share page on this computer").click();
  const link = await page
    .getByRole("textbox", { name: "Share link" })
    .inputValue();
  const guest = await browser.newContext();
  const watch = await guest.newPage();
  await watch.goto(link);
  await expect(
    watch.getByRole("heading", { name: "A real capture test" }),
  ).toBeVisible();
  await watch
    .locator(".video-player video")
    .evaluate(async (v: HTMLVideoElement) => {
      await v.play();
    });
  await expect
    .poll(() =>
      watch
        .locator(".video-player video")
        .evaluate((v: HTMLVideoElement) => v.currentTime),
    )
    .toBeGreaterThan(0.5);
  await watch
    .locator(".video-player video")
    .evaluate((v: HTMLVideoElement) => v.pause());
  await expect
    .poll(() =>
      watch
        .locator(".video-player video")
        .evaluate((v: HTMLVideoElement) => Number.isFinite(v.duration)),
    )
    .toBe(true);
  await watch.getByRole("textbox", { name: "Your name" }).fill("A teammate");
  await watch
    .getByRole("textbox", { name: "Comment", exact: true })
    .fill("This works end to end.");
  await watch.getByRole("button", { name: "Post comment" }).click();
  await expect(watch.getByText("This works end to end.")).toBeVisible();
  await watch.getByRole("button", { name: /React with 💡/ }).click();
  await watch.screenshot({
    path: "test-results/shared-review.png",
    fullPage: true,
  });
  // Turning a link off asks first.
  await page.getByRole("button", { name: "Turn off this page" }).click();
  await page
    .getByRole("alertdialog", { name: "Turn off this link?" })
    .getByRole("button", { name: "Turn off link" })
    .click();
  await watch.reload();
  await expect(
    watch.getByRole("heading", { name: "This video is no longer shared" }),
  ).toBeVisible();
  await guest.close();
  await page.getByRole("button", { name: "Library", exact: true }).click();
  await expect(page.locator(".video-card")).toHaveCount(2);
  await page.getByRole("textbox", { name: "Search videos" }).fill("unfindable");
  await expect(
    page.getByRole("heading", { name: "No videos match that search" }),
  ).toBeVisible();
  await page.getByRole("textbox", { name: "Search videos" }).fill("");
  await page.setViewportSize({ width: 390, height: 844 });
  await expect
    .poll(() =>
      page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    )
    .toBe(true);
  await expect
    .poll(() =>
      page
        .locator(".sidebar")
        .evaluate((el) => el.getBoundingClientRect().right),
    )
    .toBeLessThanOrEqual(0);
  await page.screenshot({
    path: "test-results/library-mobile.png",
    fullPage: true,
  });
  expect(errors).toEqual([]);
});
