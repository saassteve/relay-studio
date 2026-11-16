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
  await expect(setup.getByRole("heading", { name: /Say it once/ })).toBeVisible();
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
  await expect(setup.getByRole("heading", { name: "Make it yours." })).toBeVisible();
  await setup.getByRole("radio", { name: "Just open editor" }).click();
  await setup.getByRole("radio", { name: "3 sec" }).click();
  await page.screenshot({ path: "test-results/onboarding-prefs.png" });
  await setup.getByRole("button", { name: "Looks good" }).click();
  await expect(setup.getByRole("heading", { name: /You’re all set, Avery/ })).toBeVisible();
  // Reloading mid-way is safe; finishing persists on the server.
  const prefs = await (await page.request.get("/api/preferences")).json();
  expect(prefs).toMatchObject({
    afterRecording: "open-editor",
    countdown: 3,
    onboardingStep: "ready",
  });
  await setup.getByRole("button", { name: "Take me to my library" }).click();
  await expect(setup).toBeHidden();
  expect((await (await page.request.get("/api/preferences")).json()).onboarded).toBe(true);
  await expect(page.locator(".workspace-picker")).toContainText("Avery’s workspace");
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Ideas worth sharing." }),
  ).toBeVisible();
  await expect(setup).toBeHidden();
  await page.screenshot({
    path: "test-results/library-desktop.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "New recording" }).click();
  await page.getByRole("button", { name: "Screen only", exact: true }).click();
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
  await page.getByRole("button", { name: "Save & edit" }).click();
  await expect(page.getByRole("textbox", { name: "Video title" })).toHaveValue(
    "A real capture test",
    { timeout: 15000 },
  );
  await expect
    .poll(() =>
      page
        .locator(".video-player video")
        .evaluate((v: HTMLVideoElement) => v.readyState),
    )
    .toBeGreaterThan(1);
  await page.getByRole("button", { name: "Notes", exact: true }).click();
  await page
    .getByRole("textbox", { name: "Video notes" })
    .fill("Clear context, without the meeting.");
  await page.getByRole("button", { name: "Save notes" }).click();
  await expect(page.getByRole("button", { name: "Save notes" })).toBeDisabled();
  await page.getByRole("button", { name: "Trim video" }).click();
  await page.getByRole("spinbutton", { name: "Start seconds" }).fill(".5");
  await page.getByRole("spinbutton", { name: "End seconds" }).fill("2");
  await page.getByRole("button", { name: "Save trimmed copy" }).click();
  await expect(
    page.getByText("Trimmed copy saved to your library"),
  ).toBeVisible({ timeout: 20000 });
  await page.getByRole("button", { name: "Share video" }).click();
  await expect(
    page.getByRole("dialog", { name: "Share your video" }),
  ).toBeVisible();
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
  await watch.getByRole("button", { name: "💡", exact: true }).click();
  await watch.screenshot({
    path: "test-results/shared-review.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "Revoke link" }).click();
  await watch.reload();
  await expect(
    watch.getByRole("heading", { name: "That link has left the chat." }),
  ).toBeVisible();
  await guest.close();
  await page.getByRole("button", { name: "Your library" }).click();
  await expect(
    page.getByRole("button", { name: "Watch A real capture test (trimmed)" }),
  ).toBeVisible();
  await page.getByRole("textbox", { name: "Search videos" }).fill("unfindable");
  await expect(
    page.getByRole("heading", { name: "No videos found." }),
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
