import { expect, test } from "@playwright/test";
import path from "node:path";
import { pathToFileURL } from "node:url";

// The Mac app's region picker is a page of its own. Here it is opened as a file,
// with the app's side of it replaced by something that remembers the answer.
test("a recording region can be chosen with the keyboard or by dragging", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const w = window as unknown as {
      chosen: unknown[];
      relayControls: { chooseRegion: (r: unknown) => void };
    };
    w.chosen = [];
    w.relayControls = { chooseRegion: (r) => w.chosen.push(r) };
  });
  await page.setViewportSize({ width: 1000, height: 600 });
  await page.goto(pathToFileURL(path.resolve("desktop/region.html")).href);
  const chosen = () =>
    page.evaluate(
      () => (window as unknown as { chosen: Record<string, number>[] }).chosen,
    );
  // Return does nothing until there is a region.
  await page.keyboard.press("Enter");
  expect(await chosen()).toEqual([]);
  // The first arrow key starts from the middle half of the screen; arrows move
  // it, Shift and arrows change its size, Option takes small steps.
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Shift+ArrowLeft");
  await page.keyboard.press("Shift+Alt+ArrowDown");
  await expect(page.locator("#region")).toHaveCSS("left", "260px");
  await expect(page.locator("#region")).toHaveCSS("top", "160px");
  await expect(page.locator("#region")).toHaveCSS("width", "490px");
  await expect(page.locator("#region")).toHaveCSS("height", "301px");
  await expect(page.getByRole("status")).toContainText("490 by 301");
  // It can't be pushed off the screen.
  for (let i = 0; i < 100; i++) await page.keyboard.press("ArrowRight");
  await expect(page.locator("#region")).toHaveCSS("left", "510px");
  await page.keyboard.press("Enter");
  expect(await chosen()).toEqual([
    { x: 0.51, y: 160 / 600, w: 0.49, h: 301 / 600 },
  ]);
  // Dragging still chooses straight away, and a stray click chooses nothing.
  await page.mouse.click(50, 50);
  await page.mouse.move(100, 100);
  await page.mouse.down();
  await page.mouse.move(400, 300);
  await page.mouse.up();
  expect((await chosen()).slice(1)).toEqual([
    { x: 0.1, y: 100 / 600, w: 0.3, h: 200 / 600 },
  ]);
  await page.keyboard.press("Escape");
  expect((await chosen()).at(-1)).toBeNull();
});
