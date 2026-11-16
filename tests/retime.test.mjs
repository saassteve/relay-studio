import { test } from "node:test";
import assert from "node:assert/strict";
import { insertSpan, removeSpan, swapSpans } from "../src/retime.ts";

const project = () => ({
  overlays: [
    { id: "intro", start: 1, end: 3 },
    { id: "blur", start: 12, end: 15 },
    { id: "outro", start: 26, end: 29 },
  ],
  scenes: [{ id: "side", start: 20, end: 24, preset: "side" }],
});
const at = (p) =>
  Object.fromEntries(
    [...p.overlays, ...p.scenes].map((x) => [
      x.id,
      [Math.round(x.start * 100) / 100, Math.round(x.end * 100) / 100],
    ]),
  );

test("removing footage takes its effects with it and pulls later ones forward", () => {
  const p = project();
  // A 10 second section from 10s to 20s is removed.
  removeSpan(p, 10, 10);
  assert.deepEqual(at(p), {
    intro: [1, 3],
    side: [10, 14],
    outro: [16, 19],
  });
});

test("adding footage pushes later effects back", () => {
  const p = project();
  insertSpan(p, 10, 5);
  assert.deepEqual(at(p), {
    intro: [1, 3],
    blur: [17, 20],
    side: [25, 29],
    outro: [31, 34],
  });
});

test("reordering two sections moves each one's effects with it", () => {
  const p = project();
  // Sections 10s to 20s and 20s to 25s change places.
  swapSpans(p, 10, 10, 5);
  assert.deepEqual(at(p), {
    intro: [1, 3],
    blur: [17, 20],
    side: [10, 14],
    outro: [26, 29],
  });
});

test("an effect that ends exactly where a section ends stays with that section", () => {
  const p = { overlays: [{ id: "edge", start: 18, end: 20 }], scenes: [] };
  swapSpans(p, 10, 10, 5);
  assert.deepEqual(at(p), { edge: [23, 25] });
});
