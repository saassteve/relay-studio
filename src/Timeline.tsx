import { useRef, type RefObject } from "react";
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

// The whole video at a glance: its sections, and every title, effect and layout
// change as a bar you can drag to move or stretch. Click anywhere to jump there.
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
}) {
  const root = useRef<HTMLDivElement>(null);
  const span = total || 1;
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
  let offset = 0;
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
      <div className="timeline-area" ref={root} onPointerDown={scrub}>
        <div className="tl-ruler" aria-hidden="true">
          {ticks.map((t) => (
            <span key={t} style={{ left: pct(t) }}>
              {clock(t)}
            </span>
          ))}
        </div>
        <div className="tl-track tl-clips" role="group" aria-label="Sections">
          {project.segments.map((s, i) => {
            const start = offset,
              length = s.end - s.start;
            offset += length;
            return (
              <button
                key={`${i}-${s.sourceId}-${s.start}`}
                className={i === selected ? "selected" : ""}
                aria-pressed={i === selected}
                aria-label={`Section ${i + 1}, ${clock(length)} long`}
                style={{ left: pct(start), width: pct(length) }}
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => {
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
                <span>
                  {project.segments.length > 1 ? `${i + 1} · ` : ""}
                  {clock(length)}
                </span>
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
      {tracks.length > 0 && (
        <p className="sr-only">
          Bars can be moved with the left and right arrow keys, made longer or
          shorter with Shift and the arrow keys, and removed with Delete.
        </p>
      )}
    </div>
  );
}
