import { test } from "node:test";
import assert from "node:assert/strict";
import { layoutPieces } from "../server/studio/render.mjs";
import {
  onScreen,
  planLayout,
  wallpaperFile,
  WALLPAPERS,
} from "../server/studio/compose.mjs";
import {
  validateProject,
  defaultLayout,
  settleBlurs,
} from "../server/studio/project.mjs";

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

test("a blur over the screen picture is placed on the picture, and one beside it is not", () => {
  const { screen } = planLayout(layout(), "screen", 16 / 9, false);
  const blur = (x, y, w, h) => onScreen({ x, y, w, h }, screen, 1920, 1080);
  // Its corners land on the same points of the frame, counted from the picture.
  const middle = blur(0.4, 0.4, 0.2, 0.2);
  const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-6, `${a} is not ${b}`);
  close(screen.x + middle.x * screen.w, 0.4 * 1920);
  close(screen.y + middle.y * screen.h, 0.4 * 1080);
  close(middle.w * screen.w, 0.2 * 1920);
  close(middle.h * screen.h, 0.2 * 1080);
  // One that hangs over the edge is kept to the part on the picture.
  const edge = blur(0.85, 0.5, 0.1, 0.1);
  assert.ok(Math.abs(edge.x + edge.w - 1) < 1e-9);
  // One whose middle is on the wallpaper stays where it is in the frame.
  assert.equal(blur(0, 0, 0.05, 0.05), null);
  assert.equal(
    onScreen({ x: 0.4, y: 0.4, w: 0.2, h: 0.2 }, null, 1920, 1080),
    null,
  );
});

test("an arrow points one of eight ways, and anything else points right", () => {
  const find = () => ({ id: "v", duration: 10 });
  const arrows = validateProject(
    {
      version: 1,
      segments: [{ sourceId: "v", start: 0, end: 10 }],
      overlays: ["↖", "←", "", "<script>", undefined].map((text, i) => ({
        id: `a${i}`,
        type: "arrow",
        start: 0,
        end: 1,
        text,
      })),
    },
    find,
  ).overlays.map((o) => o.text);
  assert.deepEqual(arrows, ["↖", "←", "→", "→", "→"]);
});

test("a blur placed under a zoom by an earlier version lands on the same part of the picture", () => {
  // A full-frame screen, so places on the frame are places on the picture.
  const old = {
    version: 1,
    segments: [{ sourceId: "v", start: 0, end: 10 }],
    layout: { ...defaultLayout(), width: 1920, height: 1080, preset: "screen" },
    scenes: [],
    overlays: [
      { id: "z", type: "zoom", start: 2, end: 6, x: 0.5, y: 0.5, scale: 2 },
      // Put there while the preview showed the middle of the picture at twice
      // its size: it covers the tenth of the picture to the right of the middle.
      {
        id: "a",
        type: "blur",
        start: 3,
        end: 5,
        x: 0.5,
        y: 0.5,
        w: 0.2,
        h: 0.2,
      },
      // Put there with no zoom on: it stays.
      {
        id: "b",
        type: "blur",
        start: 7,
        end: 8,
        x: 0.1,
        y: 0.1,
        w: 0.2,
        h: 0.2,
      },
    ],
  };
  const shape = () => ({ aspect: 16 / 9, hasCamera: false });
  const settled = settleBlurs(old, shape);
  const [, a, b] = settled.overlays;
  const close = (got, want) =>
    assert.ok(Math.abs(got - want) < 1e-9, `${got} is not ${want}`);
  close(a.x, 0.5);
  close(a.y, 0.5);
  close(a.w, 0.1);
  close(a.h, 0.1);
  assert.deepEqual(b, old.overlays[2]);
  // It is done once, and a project saved by this version needs none.
  assert.equal(settled.placing, 2);
  assert.equal(settleBlurs(settled, shape), settled);
  assert.equal(
    validateProject(old, () => ({ id: "v", duration: 10 })).placing,
    2,
  );
  // Nothing is touched while a recording's shape isn't known.
  assert.equal(
    settleBlurs(old, () => null),
    old,
  );
});
