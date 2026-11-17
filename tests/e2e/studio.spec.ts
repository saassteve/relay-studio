import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";

test("scrolls during playback and publishes multiple zooms with styled text", async ({
  page,
}) => {
  await page.request.put("/api/preferences", { data: { onboarded: true } });
  const uploaded = await page.request.post("/api/videos", {
    multipart: {
      title: "Effects review",
      duration: "15",
      video: {
        name: "presenter.mp4",
        mimeType: "video/mp4",
        buffer: await readFile("scripts/assets/presenter.mp4"),
      },
    },
  });
  expect(uploaded.ok(), await uploaded.text()).toBeTruthy();
  const { id } = await uploaded.json();
  await page.goto(`/video/${id}`);
  await page.setViewportSize({ width: 1240, height: 720 });
  const position = page.getByLabel("Position in video");
  const stage = page.locator(".stage");
  const video = stage.locator("video").first();
  const scroll = () => page.evaluate(() => window.scrollY);
  const play = page.getByRole("button", { name: "Play", exact: true });
  await play.click();
  const initialScroll = await scroll();
  const previewHeight = (await stage.boundingBox())!.height;
  await page.mouse.move(400, 350);
  await page.mouse.wheel(0, 400);
  await expect.poll(scroll).toBeGreaterThan(initialScroll + 100);
  await expect
    .poll(() => video.evaluate((v) => v.currentTime))
    .toBeGreaterThan(0.1);
  expect(await video.evaluate((v) => v.paused)).toBe(false);
  expect((await stage.boundingBox())!.height).toBe(previewHeight);
  await page.mouse.move(400, 580);
  await page.mouse.wheel(0, -600);
  await expect.poll(scroll).toBeLessThan(100);
  await page.getByRole("button", { name: "Pause", exact: true }).click();

  const tools = page.getByRole("tablist", { name: "Editing tools" });
  await tools.getByRole("tab", { name: "Effects" }).click();
  await position.fill("1");
  const effects = page.getByRole("tabpanel", { name: "Effects" });
  await effects.getByRole("button", { name: "Zoom", exact: true }).click();
  const zooms = page
    .locator(".effect-row")
    .filter({ has: page.getByLabel("Zoom motion") });
  await zooms.first().getByLabel("Zoom ×").fill("2.4");
  await zooms.first().getByLabel("Zoom motion").selectOption("quick");
  await zooms.first().getByRole("button", { name: "Duplicate Zoom" }).click();
  const zoomTrack = stage.getByRole("group", { name: "Zooms", exact: true });
  await expect(zoomTrack.getByRole("button")).toHaveCount(2);
  await zooms.last().getByText("Timing and position").click();
  await expect(zooms.last().getByLabel("Starts at (sec)")).toHaveValue("4");
  await zooms.last().getByLabel("Zoom motion").selectOption("cut");
  await zooms.last().getByRole("button", { name: "Go to it: Zoom" }).click();
  await expect(video).toHaveCSS("transform", "matrix(2.4, 0, 0, 2.4, 0, 0)");

  await effects.getByRole("button", { name: "Text", exact: true }).click();
  const text = page
    .locator(".effect-row")
    .filter({ has: page.getByLabel("Text style") });
  await expect(page.locator(".effect-row")).toHaveCount(1);
  const target = stage.getByText("Your text", { exact: true }).first();
  await target.dblclick();
  const inline = stage.getByLabel("Edit text in preview");
  await inline.fill("Discard this");
  await inline.press("Escape");
  await expect(target).toBeVisible();
  await target.dblclick();
  await inline.fill("First line\nSecond line");
  await inline.press("Meta+Enter");
  await expect(text.getByLabel("Words")).toHaveValue("First line\nSecond line");
  await text.getByLabel("Text style").selectOption("outline");
  await text.getByLabel("Text size (% of frame height)").fill("8");
  await text.getByLabel("Text animation").selectOption("fade");
  await text.getByText("Timing and position").click();
  await text.getByRole("button", { name: "Go to it: Text" }).click();
  const overlay = stage.locator('.draft-fx.text[data-text-style="outline"]');
  await expect(overlay).toHaveText("First line\nSecond line", {
    useInnerText: true,
  });
  await expect(overlay).toHaveCSS("opacity", "1");
  await page.getByRole("button", { name: "Update video" }).click();
  await expect(page.locator(".save-state")).toHaveText("Video is up to date", {
    timeout: 90000,
  });
  const { published } = await (
    await page.request.get(`/api/videos/${id}/project`)
  ).json();
  expect(published.overlays).toMatchObject([
    { type: "zoom", scale: 2.4, motion: "quick" },
    { type: "zoom", scale: 2.4, motion: "cut" },
    { type: "text", textStyle: "outline", textSize: 0.08, animation: "fade" },
  ]);
  await expect
    .poll(async () => {
      const clip = await page.request.get(`/api/videos/${id}`);
      return (await clip.json()).streamReady;
    })
    .toBeTruthy();

  await text.getByRole("button", { name: "Duplicate Text" }).click();
  await stage.locator(".canvas-text-target").last().dblclick();
  await inline.fill("Second caption");
  await text.getByLabel("Text animation").click();
  await expect(text.getByLabel("Words")).toHaveValue("Second caption");
  await text.getByLabel("Text colour").fill("#ff4488");
  await stage.getByRole("button", { name: /^First line/ }).click();
  await expect(text.getByLabel("Words")).toHaveValue("First line\nSecond line");
  await expect(text.getByLabel("Text colour")).not.toHaveValue("#ff4488");
  await expect(page.locator(".effect-row")).toHaveCount(1);
  await page
    .locator(".studio-workbench")
    .screenshot({ path: "test-results/text-inspector.png" });
});

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
  // Sections are edited on the timeline itself. Each gesture is one step to undo.
  const sections = page.locator(".tl-clips>button");
  const trimStart = page.getByLabel("Section start", { exact: true });
  const trimEnd = page.getByLabel("Section end", { exact: true });
  const heading = page.locator(".cut-heading strong");
  const saved = () =>
    expect(page.locator(".save-state")).toHaveText(
      /^Edits saved\. Update the video/,
    );
  const undo = async () => {
    await saved();
    await page.getByRole("button", { name: "Undo", exact: true }).click();
    await expect(page.locator(".studio-job")).toHaveCount(0);
  };
  // Press on one point, move to another in a few steps, and let go.
  const drag = async (from: { x: number; y: number }, toX: number) => {
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move((from.x + toX) / 2, from.y, { steps: 4 });
    await page.mouse.move(toX, from.y, { steps: 4 });
    await page.mouse.up();
  };
  const middle = async (index: number, part = ".tl-clips>button") => {
    const section = sections.nth(index);
    const target = part.startsWith(".tl-trim")
      ? section.locator(part)
      : section;
    await target.scrollIntoViewIfNeeded();
    const box = (await target.boundingBox())!;
    return { x: box.x + box.width / 2, y: box.y + box.height / 2, box };
  };
  // A click only selects.
  await sections.nth(0).click();
  await expect(heading).toHaveText("Section 1 of 2");
  await expect(trimStart).toHaveValue("0");
  const splitAt = Number(await trimEnd.inputValue());
  expect(splitAt).toBeGreaterThan(2);
  await saved();
  // Drag the end of the first section a third of the way back: it gets shorter.
  await sections.nth(0).locator(".tl-trim.end").hover();
  await page.locator(".stage").screenshot({
    path: "test-results/timeline-sections.png",
  });
  const first = await middle(0);
  const endHandle = await middle(0, ".tl-trim.end");
  expect(endHandle.box.width).toBeGreaterThanOrEqual(12);
  await drag(endHandle, endHandle.x - first.box.width / 3);
  await expect
    .poll(async () => Number(await trimEnd.inputValue()))
    .toBeLessThan(splitAt - 0.5);
  await expect(sections).toHaveCount(2);
  await expect(sections.nth(0)).not.toHaveAccessibleName(
    `Section 1, 0:0${Math.floor(splitAt)} long`,
  );
  await expect(trimStart).toHaveValue("0");
  await undo();
  await expect(trimEnd).toHaveValue(String(splitAt));
  await expect(sections).toHaveCount(2);
  // The start handle trims the other end.
  const startHandle = await middle(0, ".tl-trim:not(.end)");
  await drag(startHandle, startHandle.x + first.box.width / 3);
  await expect
    .poll(async () => Number(await trimStart.inputValue()))
    .toBeGreaterThan(0.5);
  await expect(trimEnd).toHaveValue(String(splitAt));
  await undo();
  await expect(trimStart).toHaveValue("0");
  // Drag the first section past the middle of the second: they change places.
  const second = await middle(1);
  await drag(await middle(0), second.x + 30);
  await expect(heading).toHaveText("Section 2 of 2");
  await expect(trimStart).toHaveValue("0");
  await expect(trimEnd).toHaveValue(String(splitAt));
  await sections.nth(0).click();
  await expect(heading).toHaveText("Section 1 of 2");
  await expect(trimStart).toHaveValue(String(splitAt));
  await undo();
  await sections.nth(0).click();
  await expect(trimStart).toHaveValue("0");
  await expect(trimEnd).toHaveValue(String(splitAt));
  // The same from the keyboard: Shift and an arrow trims the end by half a second,
  // an arrow alone moves the section, and S splits where the video is paused.
  await saved();
  await sections.nth(0).focus();
  await page.keyboard.press("Shift+ArrowLeft");
  await expect(trimEnd).toHaveValue(String(splitAt - 0.5));
  await undo();
  await expect(trimEnd).toHaveValue(String(splitAt));
  await sections.nth(0).focus();
  await page.keyboard.press("ArrowRight");
  await expect(heading).toHaveText("Section 2 of 2");
  await expect(sections.nth(1)).toBeFocused();
  await expect(trimStart).toHaveValue("0");
  await page.keyboard.press("ArrowLeft");
  await expect(heading).toHaveText("Section 1 of 2");
  await expect(sections.nth(0)).toBeFocused();
  await expect(trimStart).toHaveValue("0");
  await page.getByLabel("Position in video").fill("1");
  await sections.nth(0).focus();
  await page.keyboard.press("s");
  await expect(sections).toHaveCount(3);
  await undo();
  await expect(sections).toHaveCount(2);
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
