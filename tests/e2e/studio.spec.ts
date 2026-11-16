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
    .getByRole("button", { name: "Explore a sample", exact: true })
    .click();
  await expect(page.locator(".studio-workbench")).toBeVisible({
    timeout: 120000,
  });
  const videoId = new URL(page.url()).pathname.slice(7);
  await page
    .getByRole("button", { name: "Split at midpoint", exact: true })
    .click();
  await expect(page.locator(".section-timeline>button")).toHaveCount(2);
  await page.getByRole("button", { name: "Save project", exact: true }).click();
  await page.getByRole("button", { name: "Undo edit", exact: true }).click();
  await expect(page.locator(".section-timeline>button")).toHaveCount(1);
  await page.getByRole("button", { name: "Redo edit", exact: true }).click();
  await expect(page.locator(".section-timeline>button")).toHaveCount(2);
  const tab = page.locator(".studio-tabs");
  await tab.getByRole("button", { name: /Transcript/ }).click();
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
  await tab.getByRole("button", { name: /Transcript/ }).click();
  await expect(page.locator(".transcript-words")).toContainText("Hello");
  await page
    .locator(".transcript-words")
    .getByRole("button", { name: "Hello", exact: true })
    .click();
  await page.getByRole("button", { name: /Cut.*selected/ }).click();
  await expect(page.locator(".studio-workbench .error")).toHaveCount(0);
  await tab.getByRole("button", { name: /Presentation/ }).click();
  await page.getByLabel("Canvas preset").selectOption("1080x1080");
  await expect(page.locator(".look-canvas")).toHaveCSS(
    "aspect-ratio",
    "1080 / 1080",
  );
  // Picking a wallpaper frames the video: padding, rounded corners and a shadow.
  await page.getByRole("radio", { name: "dusk wallpaper" }).click();
  await expect(page.locator(".look-canvas")).toHaveCSS(
    "background-image",
    /wallpapers\/dusk\.jpg/,
  );
  await expect(page.getByLabel("Corner radius")).not.toHaveValue("0");
  await expect(page.locator(".look-canvas > video").first()).not.toHaveCSS(
    "box-shadow",
    "none",
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
  await page.getByRole("button", { name: "Share video", exact: true }).click();
  await page
    .getByLabel("Video password", { exact: true })
    .fill("review-password");
  await page.getByLabel("Allow file downloads").uncheck();
  await page
    .getByRole("button", { name: "Save access settings", exact: true })
    .click();
  await expect(
    page.getByText("Viewer access settings saved", { exact: true }),
  ).toBeVisible();
  const link = await page
    .getByRole("textbox", { name: "Share link", exact: true })
    .inputValue();
  const guest = await browser.newContext();
  const watch = await guest.newPage();
  await watch.goto(link);
  await expect(
    watch.getByRole("heading", { name: "A little privacy." }),
  ).toBeVisible();
  await watch.getByLabel("Watch password").fill("review-password");
  await watch.getByRole("button", { name: "Watch video", exact: true }).click();
  await expect(watch.locator(".video-player")).toBeVisible();
  await expect(
    watch.getByRole("link", { name: "Download", exact: true }),
  ).toHaveCount(0);
  await guest.close();
  await page.getByRole("button", { name: "Done", exact: true }).click();
  await page.getByRole("button", { name: "Your library", exact: true }).click();
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
    page.getByRole("heading", { name: "Ideas worth sharing.", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("status")).toContainText("Offline");
  await page.context().setOffline(false);
  expect(errors).toEqual([]);
});
