import { randomUUID } from "node:crypto";

// Turns pointer samples (fractions of the captured frame, with source times) into
// zoom effects on the output timeline. A "key moment" is where the pointer comes to
// rest after travelling: someone pointing at the thing they are talking about.
const SETTLE_RADIUS = 0.045; // fraction of the frame
const MIN_DWELL = 0.8; // seconds at rest
const LEAD_IN = 0.35; // start zooming slightly before the pointer stops
const HOLD_AFTER = 1.4; // stay zoomed after it moves on
const MIN_TRAVEL = 0.08; // ignore jitter between nearby rests
const MAX_ZOOMS = 30;

function dwells(points) {
  const found = [];
  let i = 0;
  while (i < points.length) {
    let j = i + 1,
      sx = points[i].x,
      sy = points[i].y,
      n = 1;
    while (j < points.length) {
      const cx = sx / n,
        cy = sy / n;
      if (Math.hypot(points[j].x - cx, points[j].y - cy) > SETTLE_RADIUS) break;
      sx += points[j].x;
      sy += points[j].y;
      n++;
      j++;
    }
    const start = points[i].time,
      end = points[j - 1].time;
    if (end - start >= MIN_DWELL)
      found.push({ start, end, x: sx / n, y: sy / n });
    i = Math.max(i + 1, j);
  }
  return found;
}

// Maps a source time to the edited output timeline, or null if it was cut.
export function toOutputTime(segments, sourceId, time) {
  let offset = 0;
  for (const s of segments) {
    if (s.sourceId === sourceId && time >= s.start && time <= s.end)
      return offset + time - s.start;
    offset += s.end - s.start;
  }
  return null;
}

export function autoZoom(
  points,
  { segments, sourceId, duration, scale = 1.8 },
) {
  const clean = (Array.isArray(points) ? points : [])
    .filter(
      (p) =>
        Number.isFinite(p?.time) &&
        Number.isFinite(p?.x) &&
        Number.isFinite(p?.y) &&
        p.x >= 0 &&
        p.x <= 1 &&
        p.y >= 0 &&
        p.y <= 1,
    )
    .sort((a, b) => a.time - b.time);
  const total = segments.reduce((n, s) => n + s.end - s.start, 0) || duration;
  const effects = [];
  let previous = null;
  for (const d of dwells(clean)) {
    // A rest right where the last one was is the same moment, keep it going.
    if (
      previous &&
      Math.hypot(d.x - previous.x, d.y - previous.y) < MIN_TRAVEL &&
      d.start - previous.sourceEnd < 2
    ) {
      const end = toOutputTime(segments, sourceId, d.end);
      if (end !== null)
        previous.effect.end = Math.min(
          total,
          Math.max(previous.effect.end, end + HOLD_AFTER),
        );
      previous.sourceEnd = d.end;
      continue;
    }
    const start = toOutputTime(
        segments,
        sourceId,
        Math.max(0, d.start - LEAD_IN),
      ),
      end = toOutputTime(segments, sourceId, d.end);
    if (start === null || end === null) continue;
    const last = effects.at(-1);
    let from = start;
    // Keep zooms from overlapping; leave room to ease out and back in.
    if (last && from < last.end + 0.3) {
      if (last.end - last.start > 2.2)
        last.end = Math.max(last.start + 1.8, from - 0.3);
      from = Math.max(from, last.end + 0.3);
    }
    const to = Math.min(total - 0.05, Math.max(from + 1.8, end + HOLD_AFTER));
    if (to - from < 1.2) continue;
    const effect = {
      id: randomUUID(),
      type: "zoom",
      auto: true,
      start: +from.toFixed(2),
      end: +to.toFixed(2),
      x: +Math.min(0.95, Math.max(0, d.x)).toFixed(4),
      y: +Math.min(0.95, Math.max(0, d.y)).toFixed(4),
      w: 0.3,
      h: 0.2,
      scale,
      text: "",
      color: "#d6f475",
    };
    effects.push(effect);
    previous = { ...d, sourceEnd: d.end, effect };
    if (effects.length >= MAX_ZOOMS) break;
  }
  return effects;
}

// FFmpeg zoompan expressions for a set of zooms on a segment's local timeline.
// Each zoom eases in and out (smoothstep) around its point of focus, which stays
// where it is in the picture while everything else grows away from it. That is
// how the editor's preview shows a zoom, so the two agree.
export function zoomFilter(zooms, width, height) {
  if (!zooms.length) return null;
  const weight = (z) => {
    const ease = Math.max(0.15, Math.min(0.5, (z.end - z.start) / 3));
    return `(st(1,clip((it-${z.start.toFixed(3)})/${ease.toFixed(3)},0,1)*clip((${z.end.toFixed(3)}-it)/${ease.toFixed(3)},0,1));ld(1)*ld(1)*(3-2*ld(1)))`;
  };
  const sum = (term) => zooms.map(term).join("+");
  const total = sum((z) => weight(z));
  const zoom = `1+${sum((z) => `${(z.scale - 1).toFixed(3)}*${weight(z)}`)}`;
  const centre = (axis) =>
    `if(gt(${total},0.0001),(${sum((z) => `${z[axis].toFixed(4)}*${weight(z)}`)})/(${total}),0.5)`;
  return (
    `zoompan=z='${zoom}'` +
    `:x='clip(${centre("x")}*(iw-iw/zoom),0,iw-iw/zoom)'` +
    `:y='clip(${centre("y")}*(ih-ih/zoom),0,ih-ih/zoom)'` +
    `:d=1:s=${width}x${height}:fps=30`
  );
}
