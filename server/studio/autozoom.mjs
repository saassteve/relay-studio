import { randomUUID } from "node:crypto";
import { zoomEase } from "../../shared/editor-effects.mjs";

// Turns pointer samples (fractions of the captured frame, with source times) into
// zoom effects on the output timeline. A "key moment" is where the pointer comes to
// rest after travelling: someone pointing at the thing they are talking about.
const SETTLE_RADIUS = 0.045; // fraction of the frame
const MIN_DWELL = 0.8; // seconds at rest
const LEAD_IN = 0.35; // start zooming slightly before the pointer stops
const HOLD_AFTER = 1.4; // stay zoomed after it moves on
const MIN_TRAVEL = 0.08; // ignore jitter between nearby rests
const MAX_SAMPLE_GAP = 0.5;
const MAX_HOLD = 4;
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
      if (
        points[j].time - points[j - 1].time > MAX_SAMPLE_GAP ||
        Math.hypot(points[j].x - cx, points[j].y - cy) > SETTLE_RADIUS
      )
        break;
      sx += points[j].x;
      sy += points[j].y;
      n++;
      j++;
    }
    const start = points[i].time,
      end = points[j - 1].time,
      x = sx / n,
      y = sy / n;
    if (end - start >= MIN_DWELL) {
      // A pointer left parked at the start, or just outside the capture area,
      // is not a reason to zoom. Look for a deliberate approach to this point.
      for (let k = i - 1; k >= 0 && start - points[k].time <= 1; k--) {
        if (points[k + 1].time - points[k].time > MAX_SAMPLE_GAP) break;
        if (Math.hypot(points[k].x - x, points[k].y - y) >= MIN_TRAVEL) {
          found.push({ start, end, x, y });
          break;
        }
      }
    }
    i = Math.max(i + 1, j);
  }
  return found;
}

export function autoZoom(points, { segments, sourceId, scale = 1.8 }) {
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
  const effects = [];
  const moments = dwells(clean);
  const spans = [];
  let offset = 0;
  for (const segment of segments) {
    const last = spans.at(-1);
    if (segment.sourceId === sourceId) {
      // A split without a cut remains a continuous run of the same footage.
      if (
        last &&
        Math.abs(last.end - segment.start) < 1e-6 &&
        Math.abs(last.offset + last.end - last.start - offset) < 1e-6
      )
        last.end = segment.end;
      else spans.push({ ...segment, offset });
    }
    offset += segment.end - segment.start;
  }
  for (const span of spans) {
    for (const d of moments) {
      if (
        Math.min(d.end, span.end) - Math.max(d.start, span.start) <
        MIN_DWELL / 2
      )
        continue;
      const fromSource = Math.max(span.start, d.start - LEAD_IN);
      const toSource = Math.min(
        span.end,
        d.end + HOLD_AFTER,
        d.start + MAX_HOLD,
      );
      let from = span.offset + fromSource - span.start;
      const to = span.offset + toSource - span.start;
      const last = effects.at(-1);
      if (last) from = Math.max(from, last.end + 0.3);
      if (to - from < 1.2) continue;
      effects.push({
        id: randomUUID(),
        type: "zoom",
        auto: true,
        start: +from.toFixed(3),
        end: +to.toFixed(3),
        x: +d.x.toFixed(4),
        y: +d.y.toFixed(4),
        w: 0.3,
        h: 0.2,
        scale,
        text: "",
        color: "#d6f475",
      });
      if (effects.length >= MAX_ZOOMS) return effects;
    }
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
    const ease = zoomEase(z);
    if (!ease) return `(gte(it,${z.start})*lt(it,${z.end}))`;
    return `(st(1,clip(min((it-${z.start})/${ease},(${z.end}-it)/${ease}),0,1));ld(1)*ld(1)*(3-2*ld(1)))`;
  };
  const sum = (term) => zooms.map(term).join("+");
  const depth = (z) => `${z.scale - 1}*${weight(z)}`;
  const total = sum((z) => weight(z));
  const zoom = `1+(${sum(depth)})/max(1,${total})`;
  const centre = (axis) =>
    `(st(2,${sum(depth)});if(gt(ld(2),0.0001),(${sum((z) => `${z[axis]}*${depth(z)}`)})/ld(2),0.5))`;
  return (
    `zoompan=z='${zoom}'` +
    `:x='clip(${centre("x")}*(iw-iw/zoom),0,iw-iw/zoom)'` +
    `:y='clip(${centre("y")}*(ih-ih/zoom),0,ih-ih/zoom)'` +
    `:d=1:s=${width}x${height}:fps=30`
  );
}
