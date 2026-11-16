import { test, expect, type Page } from "@playwright/test";

// Chrome's synthetic camera: a moving test pattern, no person in frame.
test.use({
  launchOptions: {
    args: [
      "--use-fake-device-for-media-stream",
      "--use-fake-ui-for-media-stream",
    ],
  },
  permissions: ["camera", "microphone"],
});

// Average colour of the live camera preview.
const sample = (page: Page) =>
  page.locator(".look-preview video").evaluate((v: HTMLVideoElement) => {
    const c = document.createElement("canvas");
    c.width = 64;
    c.height = 64;
    const g = c.getContext("2d")!;
    g.drawImage(v, 0, 0, 64, 64);
    const d = g.getImageData(0, 0, 64, 64).data;
    let r = 0,
      gr = 0,
      b = 0,
      spread = 0;
    for (let i = 0; i < d.length; i += 4) {
      r += d[i];
      gr += d[i + 1];
      b += d[i + 2];
      spread +=
        Math.max(d[i], d[i + 1], d[i + 2]) - Math.min(d[i], d[i + 1], d[i + 2]);
    }
    const n = d.length / 4;
    return { r: r / n, g: gr / n, b: b / n, spread: spread / n };
  });

test("camera looks: filters and on-device virtual backgrounds", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.request.put("/api/preferences", {
    data: { onboarded: true, cameraFilter: "none", cameraBackground: "none" },
  });
  await page.goto("/");
  await page.getByRole("button", { name: "New recording" }).first().click();
  await page.getByRole("button", { name: "Camera only", exact: true }).click();
  const preview = page.locator(".look-preview video");
  await expect
    .poll(() => preview.evaluate((v: HTMLVideoElement) => v.readyState))
    .toBeGreaterThan(1);

  await page.getByRole("radio", { name: "Mono" }).click();
  await expect.poll(async () => (await sample(page)).spread).toBeLessThan(6);

  await page.getByRole("radio", { name: "Natural" }).click();
  await expect
    .poll(async () => (await sample(page)).spread)
    .toBeGreaterThan(20);
  const raw = await sample(page);
  await page.getByRole("radio", { name: "Pine" }).click();
  await expect(page.locator(".look-busy")).toBeHidden({ timeout: 60000 });
  // No person in the synthetic feed, so the pine background should fill the frame.
  await expect
    .poll(
      async () => {
        const c = await sample(page);
        // Pine is a dark, blue-tinted green, unlike the bright fake feed.
        return c.g < raw.g - 25 && c.b > raw.b + 10;
      },
      { timeout: 60000 },
    )
    .toBe(true);
  await page.screenshot({ path: "test-results/camera-look.png" });

  const saved = await (await page.request.get("/api/preferences")).json();
  expect(saved).toMatchObject({
    cameraFilter: "none",
    cameraBackground: "pine",
  });
  expect(errors).toEqual([]);
});
