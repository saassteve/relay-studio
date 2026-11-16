import { test, expect } from "@playwright/test";
test("reversible sections, captions, presentation, access and offline shell", async ({
  page,
  browser,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  for (const v of await (await page.request.get("/api/videos")).json())
    expect(
      (await page.request.delete(`/api/videos/${v.id}`)).ok(),
    ).toBeTruthy();
  await page.request.put("/api/preferences", {
    data: { onboarded: true, countdown: 0 },
  });
  await page.goto("/");
  await page
    .getByRole("button", { name: "Try a sample video", exact: true })
    .click();
  await expect(page.locator(".studio-workbench")).toBeVisible({
    timeout: 120000,
  });
  const videoId = new URL(page.url()).pathname.slice(7);
  // Move the playhead into the video, split there, then undo and redo it.
  await page.getByLabel("Position in video").fill("3");
  await page.getByRole("button", { name: "Split here", exact: true }).click();
  await expect(page.locator(".tl-clips>button")).toHaveCount(2);
  await expect(page.locator(".save-state")).toHaveText(
    /^Edits saved\. Update the video/,
  );
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(page.locator(".tl-clips>button")).toHaveCount(1);
  await page.getByRole("button", { name: "Redo", exact: true }).click();
  await expect(page.locator(".tl-clips>button")).toHaveCount(2);
  const tab = page.locator(".studio-tabs");
  await tab.getByRole("tab", { name: /Transcript/ }).click();
  await expect(
    page.getByRole("button", { name: "Create transcript" }),
  ).toBeVisible();
  const imported = await page.request.put(`/api/videos/${videoId}/transcript`, {
    data: {
      words: [
        { text: "Hello", start: 0.1, end: 0.8 },
        { text: "Relay", start: 1, end: 1.5 },
      ],
    },
  });
  expect(imported.ok()).toBeTruthy();
  await page.reload();
  await tab.getByRole("tab", { name: /Transcript/ }).click();
  await expect(page.locator(".transcript-words")).toContainText("Hello");
  await page
    .locator(".transcript-words")
    .getByRole("button", { name: "Hello", exact: true })
    .click();
  await page.getByRole("button", { name: "Cut 1 selected word" }).click();
  await expect(page.locator(".studio-workbench .error")).toHaveCount(0);
  await tab.getByRole("tab", { name: /Look/ }).click();
  await page.getByLabel("Shape and resolution").selectOption("1080x1080");
  await expect(page.locator(".draft-canvas")).toHaveCSS(
    "aspect-ratio",
    "1080 / 1080",
  );
  // Picking a wallpaper frames the video: padding, rounded corners and a shadow.
  await page.getByRole("radio", { name: "dusk wallpaper" }).click();
  await expect(page.locator(".draft-canvas")).toHaveCSS(
    "background-image",
    /wallpapers\/dusk\.jpg/,
  );
  await expect(page.getByLabel("Rounded corners")).not.toHaveValue("0");
  // Captions get a style, and titles are one click.
  await page.getByLabel("Show captions in the video").check();
  await page.getByRole("radio", { name: "Word by word" }).click();
  await page.getByRole("button", { name: "Title card", exact: true }).click();
  await page
    .locator(".effect-row")
    .last()
    .getByLabel("Title", { exact: true })
    .fill("Relay in two minutes");
  await page
    .locator(".effect-row")
    .last()
    .getByLabel("Subtitle")
    .fill("A quick tour");
  await expect(page.locator(".draft-box").first()).not.toHaveCSS(
    "box-shadow",
    "none",
  );
  // The live preview shows the title card at the start of the video.
  await page.getByLabel("Position in video").fill("0.5");
  await expect(page.locator(".draft-title")).toContainText(
    "Relay in two minutes",
  );
  await page.screenshot({
    path: "test-results/studio-desktop.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBeTruthy();
  await page.screenshot({
    path: "test-results/studio-mobile.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await page.getByText("Share page on this computer").click();
  await page
    .getByLabel("Video password", { exact: true })
    .fill("review-password");
  await page.getByLabel("Allow file downloads").uncheck();
  const link = await page
    .getByRole("textbox", { name: "Share link", exact: true })
    .inputValue();
  // The dialog's own button saves, so a typed password can't be lost.
  await page
    .getByRole("button", { name: "Save and close", exact: true })
    .click();
  await expect(
    page.getByText("Sharing settings saved", { exact: true }),
  ).toBeVisible();
  const guest = await browser.newContext();
  const watch = await guest.newPage();
  await watch.goto(link);
  await expect(
    watch.getByRole("heading", { name: "This video is password-protected" }),
  ).toBeVisible();
  await watch.getByLabel("Watch password").fill("review-password");
  await watch.getByRole("button", { name: "Watch video", exact: true }).click();
  await expect(watch.locator(".video-player")).toBeVisible();
  await expect(
    watch.getByRole("link", { name: "Download", exact: true }),
  ).toHaveCount(0);
  await guest.close();
  await page.getByRole("button", { name: "Library", exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBeTruthy();
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await page.context().setOffline(true);
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Library", exact: true }),
  ).toBeVisible();
  await expect(page.getByText(/Offline/).first()).toBeVisible();
  await page.context().setOffline(false);
  expect(errors).toEqual([]);
});
