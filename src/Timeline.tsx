import { useEffect, useRef, useState, type RefObject } from "react";
import { clock, type Project } from "./types";
import { PRESETS } from "./layoutPlan";

interface Item {
  key: string;
  kind: "overlay" | "scene";
  index: number;
  start: number;
  end: number;
  label: string;
  track: number;
}
const TITLES = ["title", "lowerthird", "chapter"];
const TRACKS = ["Titles", "Zoom and highlights", "Layout changes"];
const STEPS = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
// How a drag can end.
const EVENTS = ["pointerup", "pointercancel", "lostpointercapture"] as const;
type Edge = "start" | "end";
// What is being dragged in the row of sections: one end of a section, or all of it.
type Gesture =
  | { kind: "trim"; index: number; edge: Edge; length: number; span: number }
  | { kind: "move"; index: number; by: number; to: number };

// The whole video at a glance: its sections, and every title, effect and layout
// change as a bar you can drag to move or stretch. Click anywhere to jump there.
// Sections can be trimmed by an end and dragged into a new order.
export function Timeline({
  project,
  total,
  selected,
  onSelect,
  onSeek,
  edit,
  marker,
  names,
  onPick,
  onTrim,
  onTrimEnd,
  onMove,
  onRemove,
  onSplit,
}: {
  project: Project;
  total: number;
  selected: number;
  onSelect: (index: number, start: number) => void;
  onSeek: (time: number) => void;
  edit: (fn: (p: Project) => void) => void;
  // The line showing where the preview is; the editor moves it as the video plays.
  marker: RefObject<HTMLElement | null>;
  names: Record<string, string>;
  // A bar was clicked: show its settings.
  onPick?: (key: string) => void;
  // One end of a section is being moved to `to` seconds of its footage. Called as
  // the handle moves; onTrimEnd is called once when it is let go.
  onTrim?: (index: number, edge: Edge, to: number) => void;
  onTrimEnd?: () => void;
  // A section was put in a new place among the others.
  onMove?: (from: number, to: number) => void;
  onRemove?: (index: number) => void;
  // Split the section under the playhead.
  onSplit?: () => void;
}) {
  const root = useRef<HTMLDivElement>(null);
  const [gesture, setGesture] = useState<Gesture | null>(null);
  // A drag outlives the render it began in, so it calls the newest handlers.
  const live = useRef({ onTrim, onTrimEnd, onMove });
  live.current = { onTrim, onTrimEnd, onMove };
  // A drag ends with a click on the same section; that one is not a selection.
  const skipClick = useRef(false);
  // The section the keyboard should stay on once the sections have changed places.
  const focusNext = useRef<number | null>(null);
  useEffect(() => {
    if (focusNext.current === null) return;
    root.current
      ?.querySelectorAll<HTMLElement>(".tl-clips > button")
      [focusNext.current]?.focus();
    focusNext.current = null;
  });
  const count = project.segments.length;
  const lengths = project.segments.map((s) => s.end - s.start);
  const starts: number[] = [];
  lengths.reduce((at, length, i) => ((starts[i] = at), at + length), 0);
  const trimmed =
    gesture?.kind === "trim" && gesture.index < count ? gesture : null;
  const moving =
    gesture?.kind === "move" && gesture.index < count ? gesture : null;
  // While an end is dragged, everything else holds still so the end stays under the
  // pointer. The other sections close up, or make room, when it is let go.
  const grown = trimmed ? lengths[trimmed.index] - trimmed.length : 0;
  const nudge =
    trimmed?.edge === "start" ? Math.max(-grown, -starts[trimmed.index]) : 0;
  // Where each section is drawn: its real place, unless a drag is under way.
  const place = (i: number) => {
    let at = starts[i];
    if (trimmed)
      at += i === trimmed.index ? nudge : i > trimmed.index ? -grown : 0;
    if (moving && i !== moving.index) {
      if (i > moving.index && i <= moving.to) at -= lengths[moving.index];
      if (i < moving.index && i >= moving.to) at += lengths[moving.index];
    }
    return at;
  };
  const span = trimmed
    ? Math.max(
        trimmed.span,
        starts[trimmed.index] + nudge + lengths[trimmed.index],
      )
    : total || 1;
  const pct = (t: number) => `${(t / span) * 100}%`;
  const items: Item[] = [
    ...project.overlays.map((o, index) => ({
      key: o.id,
      kind: "overlay" as const,
      index,
      start: o.start,
      end: o.end,
      label:
        (TITLES.includes(o.type) || o.type === "text") && o.text.trim()
          ? o.text.trim()
          : names[o.type] || o.type,
      track: TITLES.includes(o.type) ? 0 : 1,
    })),
    ...(project.scenes || []).map((s, index) => ({
      key: s.id,
      kind: "scene" as const,
      index,
      start: s.start,
      end: s.end,
      label: PRESETS.find((p) => p.id === s.preset)?.label || "Layout",
      track: 2,
    })),
  ];
  // Bars that overlap in time sit on separate rows of their track.
  const tracks = TRACKS.map((name, track) => {
    const ends: number[] = [];
    const bars = items
      .filter((item) => item.track === track)
      .sort((a, b) => a.start - b.start)
      .map((item) => {
        let row = ends.findIndex((end) => end <= item.start + 0.001);
        if (row < 0) row = ends.push(0) - 1;
        ends[row] = item.end;
        return { ...item, row };
      });
    return { name, bars, rows: Math.max(1, ends.length) };
  }).filter((track) => track.bars.length);

  const set = (item: Item, start: number, end: number) =>
    edit((p) => {
      const target =
        item.kind === "overlay"
          ? p.overlays[item.index]
          : p.scenes?.[item.index];
      if (!target) return;
      target.start = +start.toFixed(1);
      target.end = +end.toFixed(1);
    });
  const drag =
    (item: Item, mode: "move" | "start" | "end") =>
    (e: React.PointerEvent<HTMLElement>) => {
      const width = root.current?.getBoundingClientRect().width;
      if (!width || !total || e.button) return;
      e.preventDefault();
      e.stopPropagation();
      const target = e.currentTarget,
        from = e.clientX,
        length = item.end - item.start;
      let moved = false;
      target.setPointerCapture(e.pointerId);
      const move = (ev: PointerEvent) => {
        if (Math.abs(ev.clientX - from) > 3) moved = true;
        if (!moved) return;
        const by = ((ev.clientX - from) / width) * total;
        if (mode === "move") {
          const start = Math.max(0, Math.min(total - length, item.start + by));
          set(item, start, start + length);
        } else if (mode === "start")
          set(
            item,
            Math.max(0, Math.min(item.end - 0.5, item.start + by)),
            item.end,
          );
        else
          set(
            item,
            item.start,
            Math.min(total, Math.max(item.start + 0.5, item.end + by)),
          );
      };
      const stop = () => {
        target.removeEventListener("pointermove", move);
        target.removeEventListener("pointerup", stop);
        target.removeEventListener("pointercancel", stop);
        // A plain click jumps to the bar and opens its settings instead.
        if (!moved) {
          onSeek(item.start + 0.05);
          onPick?.(item.key);
        }
      };
      target.addEventListener("pointermove", move);
      target.addEventListener("pointerup", stop);
      target.addEventListener("pointercancel", stop);
    };
  // Drag one end of a section to trim it. The preview shows the frame at that end.
  const trim =
    (i: number, edge: Edge) => (e: React.PointerEvent<HTMLElement>) => {
      const width = root.current?.getBoundingClientRect().width;
      const section = project.segments[i];
      if (!width || !total || e.button || !section) return;
      // The section's own press handler would start moving it.
      e.stopPropagation();
      const target = e.currentTarget,
        from = e.clientX,
        origin = section[edge],
        perPixel = span / width;
      let moved = false;
      target.setPointerCapture(e.pointerId);
      const move = (ev: PointerEvent) => {
        if (!moved) {
          if (Math.abs(ev.clientX - from) <= 3) return;
          moved = true;
          setGesture({
            kind: "trim",
            index: i,
            edge,
            length: section.end - section.start,
            span,
          });
        }
        // To the nearest twentieth of a second, like the trim sliders.
        live.current.onTrim?.(
          i,
          edge,
          Math.round((origin + (ev.clientX - from) * perPixel) * 20) / 20,
        );
      };
      const stop = () => {
        for (const type of EVENTS) target.removeEventListener(type, stop);
        target.removeEventListener("pointermove", move);
        if (!moved) return;
        skipClick.current = true;
        setTimeout(() => (skipClick.current = false));
        setGesture(null);
        live.current.onTrimEnd?.();
      };
      target.addEventListener("pointermove", move);
      for (const type of EVENTS) target.addEventListener(type, stop);
    };
  // Drag a section sideways to put it before or after its neighbours. It takes a
  // neighbour's place once the pointer is past that neighbour's middle.
  const reorder = (i: number) => (e: React.PointerEvent<HTMLButtonElement>) => {
    // Not a press on the empty timeline.
    e.stopPropagation();
    const box = root.current?.getBoundingClientRect();
    if (!box || !total || e.button || count < 2 || !onMove) return;
    const target = e.currentTarget,
      from = e.clientX,
      px = (t: number) => (t / span) * box.width,
      middles = starts.map((at, j) => box.left + px(at + lengths[j] / 2)),
      lowest = -px(starts[i]),
      highest = box.width - px(starts[i] + lengths[i]);
    let moved = false,
      to = i;
    target.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => {
      // A press that barely moves is still a click.
      if (!moved && Math.abs(ev.clientX - from) <= 4) return;
      moved = true;
      to = i;
      for (let j = i + 1; j < count && ev.clientX > middles[j]; j++) to = j;
      for (let j = i - 1; j >= 0 && ev.clientX < middles[j]; j--) to = j;
      setGesture({
        kind: "move",
        index: i,
        by: Math.max(lowest, Math.min(highest, ev.clientX - from)),
        to,
      });
    };
    const stop = (ev: Event) => {
      for (const type of EVENTS) target.removeEventListener(type, stop);
      target.removeEventListener("pointermove", move);
      if (!moved) return;
      skipClick.current = true;
      setTimeout(() => (skipClick.current = false));
      setGesture(null);
      if (ev.type !== "pointerup" || to === i) return;
      focusNext.current = to;
      live.current.onMove?.(i, to);
    };
    target.addEventListener("pointermove", move);
    for (const type of EVENTS) target.addEventListener(type, stop);
  };
  // Press or drag on an empty part of the timeline to move through the video.
  const scrub = (e: React.PointerEvent<HTMLDivElement>) => {
    const box = root.current?.getBoundingClientRect();
    if (!box || e.button) return;
    const el = e.currentTarget;
    const go = (x: number) =>
      onSeek(
        Math.max(0, Math.min(total, ((x - box.left) / box.width) * total)),
      );
    go(e.clientX);
    el.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => go(ev.clientX);
    const stop = () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", stop);
      el.removeEventListener("pointercancel", stop);
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", stop);
    el.addEventListener("pointercancel", stop);
  };
  const step = STEPS.find((s) => span / s <= 8) || 600;
  const ticks = Array.from(
    { length: Math.floor(span / step) + 1 },
    (_, i) => i * step,
  );
  return (
    <div className="timeline" aria-label="Timeline" role="group">
      <div className="tl-names" aria-hidden="true">
        <span className="tl-ruler-gap" />
        <span style={{ height: 32 }}>Video</span>
        {tracks.map((track) => (
          <span key={track.name} style={{ height: track.rows * 26 + 2 }}>
            {track.name === "Zoom and highlights"
              ? "Effects"
              : track.name === "Layout changes"
                ? "Layout"
                : track.name}
          </span>
        ))}
      </div>
      <div
        className={`timeline-area${trimmed ? " is-trimming" : ""}`}
        ref={root}
        onPointerDown={scrub}
      >
        <div className="tl-ruler" aria-hidden="true">
          {ticks.map((t) => (
            <span key={t} style={{ left: pct(t) }}>
              {clock(t)}
            </span>
          ))}
        </div>
        <div
          className={`tl-track tl-clips${moving ? " is-reordering" : ""}`}
          role="group"
          aria-label="Sections"
        >
          {project.segments.map((s, i) => {
            const start = starts[i],
              length = lengths[i];
            return (
              <button
                key={i}
                className={[
                  i === selected && "selected",
                  i === moving?.index && "is-moving",
                  i === trimmed?.index && "is-trimmed",
                ]
                  .filter(Boolean)
                  .join(" ")}
                aria-pressed={i === selected}
                aria-label={`Section ${i + 1}, ${clock(length)} long`}
                title={
                  onTrim
                    ? `Section ${i + 1} · drag an end to trim it${count > 1 ? ", drag the middle to move it" : ""}. ${count > 1 ? "Arrow keys move it, " : ""}Shift and arrows trim its end, Alt and arrows trim its start${count > 1 ? ", Delete removes it" : ""}. S splits the video where it is paused.`
                    : undefined
                }
                style={{
                  left: pct(place(i)),
                  width: pct(length),
                  transform:
                    i === moving?.index
                      ? `translateX(${moving.by}px)`
                      : undefined,
                }}
                onPointerDown={reorder(i)}
                onKeyDown={(e) => {
                  if (e.metaKey || e.ctrlKey) return;
                  const used = () => {
                    e.preventDefault();
                    e.stopPropagation();
                  };
                  if (e.key === "Delete" || e.key === "Backspace") {
                    if (!onRemove || count < 2) return;
                    used();
                    focusNext.current = Math.min(i, count - 2);
                    onRemove(i);
                  } else if (e.key.toLowerCase() === "s" && !e.altKey) {
                    if (!onSplit) return;
                    used();
                    onSplit();
                  } else if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
                    const way = e.key === "ArrowRight" ? 1 : -1;
                    used();
                    // Half a second at a time, like the bars underneath.
                    if (e.shiftKey) onTrim?.(i, "end", s.end + way * 0.5);
                    else if (e.altKey)
                      onTrim?.(i, "start", s.start + way * 0.5);
                    else if (onMove && i + way >= 0 && i + way < count) {
                      focusNext.current = i + way;
                      onMove(i, i + way);
                    }
                  }
                }}
                onKeyUp={() => onTrimEnd?.()}
                onBlur={() => onTrimEnd?.()}
                onClick={(e) => {
                  if (skipClick.current) {
                    skipClick.current = false;
                    return;
                  }
                  // Go to the moment that was clicked; from the keyboard, to its start.
                  const box = root.current?.getBoundingClientRect();
                  onSelect(
                    i,
                    e.detail && box
                      ? Math.max(
                          0,
                          Math.min(
                            total,
                            ((e.clientX - box.left) / box.width) * total,
                          ),
                        )
                      : start,
                  );
                }}
              >
                {onTrim && (
                  <i
                    className="tl-trim"
                    aria-hidden="true"
                    onPointerDown={trim(i, "start")}
                  />
                )}
                <span>
                  {count > 1 ? `${i + 1} · ` : ""}
                  {clock(length)}
                </span>
                {onTrim && (
                  <i
                    className="tl-trim end"
                    aria-hidden="true"
                    onPointerDown={trim(i, "end")}
                  />
                )}
              </button>
            );
          })}
        </div>
        {tracks.map((track) => (
          <div
            className="tl-track tl-bars"
            key={track.name}
            role="group"
            aria-label={track.name}
            style={{ height: track.rows * 26 + 2 }}
          >
            {track.bars.map((bar) => (
              <button
                key={bar.key}
                className={`tl-bar track-${bar.track}`}
                style={{
                  left: pct(bar.start),
                  width: pct(bar.end - bar.start),
                  top: bar.row * 26,
                }}
                aria-label={`${bar.label}, ${clock(bar.start)} to ${clock(bar.end)}`}
                title={`${bar.label} · drag to move, drag an end to change its length. Arrow keys move it, Shift and arrows change its length, Delete removes it.`}
                onPointerDown={drag(bar, "move")}
                onKeyDown={(e) => {
                  if (e.key === "Delete" || e.key === "Backspace") {
                    e.preventDefault();
                    e.stopPropagation();
                    edit((p) => {
                      if (bar.kind === "overlay")
                        p.overlays.splice(bar.index, 1);
                      else p.scenes?.splice(bar.index, 1);
                    });
                    root.current
                      ?.querySelector<HTMLElement>(".tl-clips button")
                      ?.focus();
                    return;
                  }
                  const by =
                    e.key === "ArrowRight"
                      ? 0.5
                      : e.key === "ArrowLeft"
                        ? -0.5
                        : 0;
                  if (!by) return;
                  e.preventDefault();
                  e.stopPropagation();
                  const length = bar.end - bar.start;
                  if (e.shiftKey)
                    set(
                      bar,
                      bar.start,
                      Math.min(total, Math.max(bar.start + 0.5, bar.end + by)),
                    );
                  else {
                    const start = Math.max(
                      0,
                      Math.min(total - length, bar.start + by),
                    );
                    set(bar, start, start + length);
                  }
                }}
                onClick={(e) => {
                  // Keyboard "click": jump to it. Pointer clicks are handled on release.
                  if (e.detail === 0) {
                    onSeek(bar.start + 0.05);
                    onPick?.(bar.key);
                  }
                }}
              >
                <i className="tl-edge" onPointerDown={drag(bar, "start")} />
                <span>{bar.label}</span>
                <i className="tl-edge end" onPointerDown={drag(bar, "end")} />
              </button>
            ))}
          </div>
        ))}
        <i className="tl-now" ref={marker} aria-hidden="true" />
      </div>
      {onTrim && (
        <p className="sr-only">
          Sections can be moved earlier or later with the left and right arrow
          keys. Shift and the arrow keys trim a section’s end, and Alt and the
          arrow keys trim its start. Delete removes a section, and S splits the
          video where it is paused.
        </p>
      )}
      {tracks.length > 0 && (
        <p className="sr-only">
          Bars can be moved with the left and right arrow keys, made longer or
          shorter with Shift and the arrow keys, and removed with Delete.
        </p>
      )}
    </div>
  );
}
