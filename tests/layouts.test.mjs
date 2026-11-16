import { test } from "node:test";
import assert from "node:assert/strict";
import { layoutPieces } from "../server/studio/render.mjs";
import {
  planLayout,
  wallpaperFile,
  WALLPAPERS,
} from "../server/studio/compose.mjs";
import { validateProject, defaultLayout } from "../server/studio/project.mjs";

const layout = () => ({
  ...defaultLayout(),
  width: 1920,
  height: 1080,
  padding: 80,
  radius: 0.012,
  shadow: 0.7,
});

test("a section is split into one stretch per layout", () => {
  const scenes = [
    { start: 4, end: 7, preset: "side" },
    { start: 7, end: 9.5, preset: "camera" },
  ];
  assert.deepEqual(layoutPieces(scenes, 0, 12, "pip"), [
    { start: 0, end: 4, preset: "pip" },
    { start: 4, end: 7, preset: "side" },
    { start: 7, end: 9.5, preset: "camera" },
    { start: 9.5, end: 12, preset: "pip" },
  ]);
  // A later section sees the same scenes shifted by what came before it.
  assert.deepEqual(layoutPieces(scenes, 5, 10, "pip"), [
    { start: 0, end: 2, preset: "side" },
    { start: 2, end: 4.5, preset: "camera" },
    { start: 4.5, end: 10, preset: "pip" },
  ]);
  assert.deepEqual(layoutPieces([], 0, 3, "side"), [
    { start: 0, end: 3, preset: "side" },
  ]);
  // Slivers are folded away rather than rendered as their own flash of layout.
  assert.equal(
    layoutPieces([{ start: 0.2, end: 5, preset: "side" }], 0, 8, "pip")[0]
      .preset,
    "side",
  );
});

test("layouts keep every element inside the frame with even sizes", () => {
  for (const aspect of [16 / 9, 16 / 10, 4 / 3, 9 / 16])
    for (const preset of ["pip", "side", "screen", "camera"]) {
      const plan = planLayout(layout(), preset, aspect, true);
      for (const box of [plan.screen, plan.camera].filter(Boolean)) {
        assert.ok(box.x >= 0 && box.y >= 0, `${preset} ${aspect}`);
        assert.ok(
          box.x + box.w <= 1920 && box.y + box.h <= 1080,
          `${preset} ${aspect}`,
        );
        assert.equal(box.w % 2, 0);
        assert.equal(box.h % 2, 0);
      }
    }
  assert.equal(planLayout(layout(), "camera", 16 / 9, true).screen, null);
  // Without a camera track every layout falls back to the screen alone.
  assert.equal(planLayout(layout(), "side", 16 / 9, false).preset, "screen");
});

test("wallpapers ship with the app and project looks are validated", () => {
  for (const name of WALLPAPERS) assert.ok(wallpaperFile(name), name);
  const find = () => ({ id: "v", duration: 10 });
  const base = {
    version: 1,
    segments: [{ sourceId: "v", start: 0, end: 10 }],
  };
  const ok = validateProject(
    {
      ...base,
      layout: { wallpaper: "dusk", radius: 0.02, shadow: 0.5, preset: "side" },
      scenes: [
        { start: 6, end: 9, preset: "camera" },
        { start: 1, end: 4, preset: "pip" },
      ],
    },
    find,
  );
  assert.equal(ok.layout.wallpaper, "dusk");
  assert.deepEqual(
    ok.scenes.map((s) => s.start),
    [1, 6],
  );
  assert.equal(
    validateProject({ ...base, layout: { wallpaper: "../etc" } }, find).layout
      .wallpaper,
    "none",
  );
  assert.throws(() =>
    validateProject({ ...base, layout: { radius: 2 } }, find),
  );
  assert.throws(() =>
    validateProject(
      { ...base, scenes: [{ start: 1, end: 3, preset: "spin" }] },
      find,
    ),
  );
  assert.throws(() =>
    validateProject(
      { ...base, scenes: [{ start: 1, end: 1.2, preset: "pip" }] },
      find,
    ),
  );
});
