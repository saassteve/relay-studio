import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import ffmpeg from "../server/ffmpeg.mjs";
import { zoomAt } from "../shared/editor-effects.mjs";
import { autoZoom, zoomFilter } from "../server/studio/autozoom.mjs";

// Pointer moves, rests at (0.8, 0.2) from 2s to 4s, moves, rests at (0.2, 0.7) from 8s to 10s.
function path_() {
  const points = [];
  const at = (from, to, x, y) => {
    for (let t = from; t <= to + 1e-9; t += 0.15)
      points.push({ time: +t.toFixed(2), x, y });
  };
  for (let t = 0; t < 2; t += 0.15)
    points.push({ time: t, x: 0.1 + t * 0.3, y: 0.5 });
  at(2, 4, 0.8, 0.2);
  for (let t = 4.15; t < 8; t += 0.15)
    points.push({ time: t, x: 0.8 - (t - 4) * 0.15, y: 0.2 + (t - 4) * 0.12 });
  at(8, 10, 0.2, 0.7);
  return points;
}
const id = "11111111-1111-1111-1111-111111111111";

test("auto-zoom finds the places the pointer rests and eases around them", () => {
  const zooms = autoZoom(path_(), {
    segments: [{ sourceId: id, start: 0, end: 14 }],
    sourceId: id,
    duration: 14,
  });
  assert.equal(zooms.length, 2);
  const [a, b] = zooms;
  assert.ok(a.auto && a.type === "zoom");
  assert.ok(Math.abs(a.x - 0.8) < 0.02 && Math.abs(a.y - 0.2) < 0.02);
  assert.ok(
    a.start >= 1.5 && a.start <= 2,
    `starts just before the rest: ${a.start}`,
  );
  assert.ok(a.end > 4 && a.end <= 6);
  assert.ok(Math.abs(b.x - 0.2) < 0.02 && Math.abs(b.y - 0.7) < 0.02);
  assert.ok(b.start >= a.end, "zooms never overlap");
});

test("auto-zoom follows edits: cut moments are dropped and later ones shift", () => {
  const segments = [
    { sourceId: id, start: 0, end: 1.5 },
    { sourceId: id, start: 6, end: 14 },
  ];
  const zooms = autoZoom(path_(), { segments, sourceId: id, duration: 14 });
  assert.equal(zooms.length, 1);
  assert.ok(Math.abs(zooms[0].x - 0.2) < 0.02);
  assert.ok(zooms[0].start >= 3 && zooms[0].start < 3.5);
});

test("auto-zoom ignores a parked pointer and gaps and follows reordered footage", () => {
  const bounds = {
    sourceId: id,
    segments: [{ sourceId: id, start: 0, end: 14 }],
  };
  const parked = Array.from({ length: 30 }, (_, i) => ({
    time: i * 0.15,
    x: 0.5,
    y: 0.5,
  }));
  assert.deepEqual(autoZoom(parked, bounds), []);
  assert.deepEqual(
    autoZoom(
      [
        { time: 0, x: 0.1, y: 0.1 },
        { time: 0.15, x: 0.5, y: 0.5 },
        { time: 8, x: 0.5, y: 0.5 },
      ],
      bounds,
    ),
    [],
  );
  const [first, second] = autoZoom(path_(), {
    sourceId: id,
    segments: [
      { sourceId: id, start: 7, end: 14 },
      { sourceId: id, start: 0, end: 5 },
    ],
  });
  assert.ok(first.x < second.x);
  assert.ok(first.end <= 7 && second.start >= 7 && second.end <= 12);
});

test("rendered overlapping zooms use the same scale and focus as the preview", () => {
  const zooms = [
    { start: 0.1, end: 2, x: 0.75, y: 0.25, scale: 3, motion: "cut" },
    { start: 0.3, end: 2, x: 0.25, y: 0.75, scale: 2, motion: "quick" },
  ];
  const time = 0.4;
  const view = zoomAt(zooms, time);
  assert.ok(view.scale > 2 && view.scale < 3);
  const frame = (effects) =>
    execFileSync(ffmpeg, [
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      "testsrc2=size=320x180:rate=30",
      "-vf",
      zoomFilter(effects, 320, 180),
      "-ss",
      String(time),
      "-frames:v",
      "1",
      "-f",
      "rawvideo",
      "-pix_fmt",
      "gray",
      "-",
    ]);
  assert.deepEqual(
    frame(zooms),
    frame([{ ...view, start: 0, end: 2, motion: "cut" }]),
  );
});

test("auto-zoom ignores bad samples and a pointer that never settles", () => {
  const moving = Array.from({ length: 80 }, (_, i) => ({
    time: i * 0.15,
    x: (i * 0.05) % 1,
    y: 0.5,
  }));
  const zooms = autoZoom([...moving, { time: NaN, x: 2, y: -1 }, null], {
    segments: [{ sourceId: id, start: 0, end: 12 }],
    sourceId: id,
    duration: 12,
  });
  assert.deepEqual(zooms, []);
  assert.equal(zoomFilter([], 1280, 720), null);
});

test("zoom expression renders: frames zoom in and back out", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "relay-zoom-"));
  try {
    const out = path.join(dir, "out.mp4");
    const filter = zoomFilter(
      [{ start: 0.5, end: 2.5, x: 0.75, y: 0.3, scale: 2 }],
      320,
      180,
    );
    execFileSync(ffmpeg, [
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      "testsrc2=size=320x180:rate=30",
      "-t",
      "3",
      "-vf",
      filter,
      "-pix_fmt",
      "yuv420p",
      out,
    ]);
    const frame = (t) =>
      execFileSync(ffmpeg, [
        "-hide_banner",
        "-loglevel",
        "error",
        "-ss",
        String(t),
        "-i",
        out,
        "-frames:v",
        "1",
        "-f",
        "rawvideo",
        "-pix_fmt",
        "gray",
        "-",
      ]);
    const source = execFileSync(ffmpeg, [
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      "testsrc2=size=320x180:rate=30",
      "-ss",
      "1.5",
      "-frames:v",
      "1",
      "-f",
      "rawvideo",
      "-pix_fmt",
      "gray",
      "-",
    ]);
    const diff = (a, b) => {
      let d = 0;
      for (let i = 0; i < a.length; i++) d += Math.abs(a[i] - b[i]);
      return d / a.length;
    };
    assert.ok(
      diff(frame(1.5), source) > 20,
      "zoomed frame differs from source",
    );
    assert.equal(frame(2.9).length, 320 * 180);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
