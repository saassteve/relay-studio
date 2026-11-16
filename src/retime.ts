import type { Project } from "./types";

// Titles, effects and layout changes are placed by time on the finished video. When
// footage is removed, added or reordered underneath them, these keep each one over
// the footage it was put on, and drop anything whose footage is gone.

const EDGE = 1e-6;
const SHORTEST_EFFECT = 0.1;
const SHORTEST_LAYOUT = 0.5 - EDGE;

function move(project: Project, map: (t: number) => number) {
  const moved = <T extends { start: number; end: number }>(
    items: T[],
    shortest: number,
  ) =>
    items
      // An end belongs to the moment just before it, so an item that finishes
      // exactly on a boundary stays with the footage on its own side.
      .map((x) => ({
        ...x,
        start: map(x.start),
        end: map(x.end - EDGE) + EDGE,
      }))
      .filter((x) => x.end - x.start >= shortest);
  project.overlays = moved(project.overlays, SHORTEST_EFFECT);
  if (project.scenes) project.scenes = moved(project.scenes, SHORTEST_LAYOUT);
}

// `length` seconds of footage starting at `from` were removed.
export function removeSpan(project: Project, from: number, length: number) {
  if (length <= 0) return;
  move(project, (t) => (t < from ? t : t >= from + length ? t - length : from));
}

// `length` seconds of footage were added at `at`.
export function insertSpan(project: Project, at: number, length: number) {
  if (length <= 0) return;
  move(project, (t) => (t >= at ? t + length : t));
}

// Two neighbouring stretches starting at `at`, `first` then `second` seconds long,
// changed places.
export function swapSpans(
  project: Project,
  at: number,
  first: number,
  second: number,
) {
  move(project, (t) =>
    t < at || t >= at + first + second
      ? t
      : t < at + first
        ? t + second
        : t - first,
  );
}
