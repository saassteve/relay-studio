import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import { Pause, Play, Volume2, VolumeX } from "lucide-react";
import { clock, type Project, type Word } from "./types";
import {
  DEFAULT_TEXT_SIZE,
  textFade,
  zoomAt,
} from "../shared/editor-effects.mjs";
import {
  onScreen,
  planLayout,
  type Box,
  type LayoutPreset,
} from "./layoutPlan";
import "./draft-player.css";

export interface DraftPlayerHandle {
  seek: (time: number) => void;
  time: () => number;
  pause: () => void;
  toggle: () => void;
}

type Overlay = Project["overlays"][number];
const pct = (n: number, of: number) => `${(n / of) * 100}%`;
const clamp = (n: number, low: number, high: number) =>
  +Math.min(high, Math.max(low, n)).toFixed(3);

function CanvasText({
  value,
  label,
  maxLength,
  onSelect,
  onSave,
}: {
  value: string;
  label: string;
  maxLength: number;
  onSelect: () => void;
  onSave: (value: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const input = useRef<HTMLTextAreaElement>(null);
  const cancelled = useRef(false);
  useEffect(() => {
    if (editing) {
      input.current?.focus({ preventScroll: true });
      input.current?.select();
    }
  }, [editing]);
  if (!editing)
    return (
      <span
        className="canvas-text-target"
        title="Double-click to edit text"
        onClick={(e) => {
          e.stopPropagation();
          onSelect();
        }}
        onDoubleClick={(e) => {
          e.stopPropagation();
          onSelect();
          cancelled.current = false;
          setEditing(true);
        }}
      >
        {value || " "}
      </span>
    );
  return (
    <textarea
      ref={input}
      className="canvas-text-input"
      aria-label={label}
      rows={Math.min(5, value.split("\n").length)}
      maxLength={maxLength}
      defaultValue={value}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.nativeEvent.isComposing) return;
        if (
          e.key === "Escape" ||
          (e.key === "Enter" && (e.metaKey || e.ctrlKey))
        ) {
          e.preventDefault();
          cancelled.current = e.key === "Escape";
          e.currentTarget.blur();
        }
      }}
      onBlur={(e) => {
        if (!cancelled.current && e.target.value !== value)
          onSave(e.target.value);
        setEditing(false);
      }}
    />
  );
}

// Plays the video exactly as currently edited, straight from the original tracks:
// cuts are skipped, layouts change, zooms ease in, and titles and captions appear.
// Nothing needs rendering to see an edit.
export const DraftPlayer = forwardRef<
  DraftPlayerHandle,
  {
    project: Project;
    videoId: string;
    hasCamera: boolean;
    focusOverlayId?: string;
    onPickOverlay?: (id: string) => void;
    words: Word[];
    onTime?: (t: number) => void;
    // Called while an effect is dragged or resized in the preview.
    onOverlay?: (
      id: string,
      patch: Partial<Pick<Overlay, "x" | "y" | "w" | "h" | "text" | "sub">>,
    ) => void;
    // Called while the camera bubble is dragged to a new spot.
    onCamera?: (position: { x: number; y: number }) => void;
  }
>(function DraftPlayer(
  {
    project,
    videoId,
    hasCamera,
    focusOverlayId,
    onPickOverlay,
    words,
    onTime,
    onOverlay,
    onCamera,
  },
  ref,
) {
  const screen = useRef<HTMLVideoElement>(null),
    camera = useRef<HTMLVideoElement>(null),
    voice = useRef<HTMLAudioElement>(null),
    index = useRef(0),
    frame = useRef(0),
    canvas = useRef<HTMLDivElement>(null);
  const [t, setT] = useState(0),
    [playing, setPlaying] = useState(false),
    [muted, setMuted] = useState(false),
    [aspect, setAspect] = useState(16 / 9),
    // Uploaded videos carry their own sound; recordings keep the mic on its own track.
    [voiceMissing, setVoiceMissing] = useState(false),
    [cameraMissing, setCameraMissing] = useState(false);
  const segs = project.segments,
    l = project.layout;
  const starts = useMemo(() => {
    let n = 0;
    return segs.map((s) => {
      const at = n;
      n += s.end - s.start;
      return at;
    });
  }, [segs]);
  const total = segs.reduce((n, s) => n + s.end - s.start, 0);
  const live = useRef({ segs, starts, total, t });
  live.current = { segs, starts, total, t };

  const media = () =>
    [screen.current, camera.current, voice.current].filter(
      Boolean,
    ) as HTMLMediaElement[];
  const source = (id: string, role: string) =>
    `/api/videos/${id}/tracks/${role}`;
  // Point every track at the same moment of the same source.
  const place = useCallback((i: number, sourceTime: number) => {
    const { segs } = live.current,
      s = segs[i];
    if (!s) return;
    index.current = i;
    for (const [el, role] of [
      [screen.current, "main"],
      [camera.current, "camera"],
      [voice.current, "voice"],
    ] as const) {
      if (!el) continue;
      const url = source(s.sourceId, role);
      if (!el.src.endsWith(url)) el.src = url;
      if (Math.abs(el.currentTime - sourceTime) > 0.05)
        el.currentTime = sourceTime;
    }
  }, []);
  const seek = useCallback(
    (time: number) => {
      const { segs, starts, total } = live.current;
      const clamped = Math.max(0, Math.min(total, time));
      let i = starts.findLastIndex((at) => clamped >= at);
      if (i < 0) i = 0;
      const s = segs[i];
      if (!s) return;
      place(i, Math.min(s.end, s.start + clamped - starts[i]));
      setT(clamped);
      onTime?.(clamped);
    },
    [place, onTime],
  );
  const pause = useCallback(() => {
    media().forEach((m) => m.pause());
    setPlaying(false);
  }, []);
  const toggleRef = useRef(() => {});
  useImperativeHandle(
    ref,
    () => ({
      seek,
      pause,
      time: () => live.current.t,
      toggle: () => toggleRef.current(),
    }),
    [seek, pause],
  );

  // Edits can move or remove the moment being shown; stay at the same time if it exists.
  useEffect(() => {
    seek(Math.min(live.current.t, total));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(segs), videoId]);

  useEffect(() => {
    if (!playing) return;
    const step = () => {
      const { segs, starts, total } = live.current,
        main = screen.current,
        i = index.current,
        s = segs[i];
      if (main && s) {
        if (main.currentTime >= s.end - 0.02 || main.ended) {
          if (i + 1 < segs.length) {
            // Jump over whatever was cut between this section and the next.
            place(i + 1, segs[i + 1].start);
            void main.play().catch(() => {});
          } else {
            pause();
            setT(total);
            onTime?.(total);
            return;
          }
        } else {
          const now = starts[i] + Math.max(0, main.currentTime - s.start);
          setT(now);
          onTime?.(now);
          // Keep the camera and voice in step with the picture.
          for (const el of [camera.current, voice.current])
            if (el && el.readyState > 0) {
              if (Math.abs(el.currentTime - main.currentTime) > 0.18)
                el.currentTime = main.currentTime;
              if (el.paused && !main.paused) void el.play().catch(() => {});
            }
        }
      }
      frame.current = requestAnimationFrame(step);
    };
    frame.current = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame.current);
  }, [playing, place, pause, onTime]);
  useEffect(() => () => media().forEach((m) => m.pause()), []);

  const toggle = () => {
    if (playing) return pause();
    if (t >= total - 0.05) seek(0);
    setPlaying(true);
    media().forEach((m) => void m.play().catch(() => {}));
  };

  toggleRef.current = toggle;
  // What is on screen at this moment.
  // Sorted the way the render sorts them, so overlapping changes agree with it.
  const scene = [...(project.scenes || [])]
    .sort((a, b) => a.start - b.start)
    .findLast((s) => t >= s.start && t < s.end);
  const preset = (scene?.preset || l.preset || "pip") as LayoutPreset;
  const plan = planLayout(l, preset, aspect, hasCamera && !cameraMissing);
  const zooms = useMemo(
    () => project.overlays.filter((o) => o.type === "zoom"),
    [project.overlays],
  );
  const activeZooms = zooms.filter((o) => t >= o.start && t < o.end);
  const zoom =
    activeZooms.find((o) => o.id === focusOverlayId) ?? activeZooms.at(-1);
  const view = zoomAt(zooms, t);
  const titles = project.overlays.filter(
    (o) =>
      (o.type === "title" || o.type === "lowerthird" || o.type === "chapter") &&
      t >= o.start &&
      t < o.end &&
      o.text.trim(),
  );
  const showing = project.overlays.filter(
    (o) =>
      ["text", "arrow", "box", "blur", "cursor"].includes(o.type) &&
      t >= o.start &&
      t < o.end,
  );
  // A blur over the screen picture belongs to the picture, as it does in the
  // finished video: it is drawn on the picture, so a zoom or a change of layout
  // carries it along. Where it sits is read in the video's own layout.
  const resting = planLayout(
    l,
    (l.preset || "pip") as LayoutPreset,
    aspect,
    hasCamera && !cameraMissing,
  );
  const held = new Map(
    showing
      .filter((o) => o.type === "blur")
      .map((o) => [o.id, onScreen(o, resting.screen, l.width, l.height)]),
  );
  const effects = showing.filter((o) => !held.get(o.id));
  const zoomed: React.CSSProperties | undefined =
    view.scale > 1
      ? {
          transform: `scale(${view.scale})`,
          transformOrigin: `${view.x * 100}% ${view.y * 100}%`,
        }
      : undefined;
  // Drag an effect to move it, or its corner to resize it. "focus" moves the point a
  // zoom closes in on, which is measured inside the screen picture.
  const drag =
    (o: Overlay, mode: "move" | "size" | "focus") =>
    (e: React.PointerEvent<HTMLElement>) => {
      const area = canvas.current?.getBoundingClientRect();
      if (!onOverlay || !area) return;
      e.preventDefault();
      e.stopPropagation();
      const target =
          e.target instanceof HTMLElement ? e.target : e.currentTarget,
        from = { x: e.clientX, y: e.clientY },
        start = { x: o.x, y: o.y, w: o.w, h: o.h },
        // A blur on the screen picture is as large as the picture shows it.
        grown =
          held.get(o.id) && plan.screen && resting.screen
            ? (plan.screen.w / resting.screen.w) * view.scale
            : 1,
        within =
          mode === "focus" && plan.screen
            ? {
                w: (area.width * plan.screen.w) / l.width,
                h: (area.height * plan.screen.h) / l.height,
              }
            : { w: area.width * grown, h: area.height * grown };
      target.setPointerCapture(e.pointerId);
      const move = (ev: PointerEvent) => {
        const dx = (ev.clientX - from.x) / within.w,
          dy = (ev.clientY - from.y) / within.h;
        if (mode === "size")
          onOverlay(o.id, {
            w: clamp(start.w + dx, 0.03, 1 - start.x),
            h: clamp(start.h + dy, 0.03, 1 - start.y),
          });
        else
          onOverlay(o.id, {
            x: clamp(start.x + dx, 0, mode === "focus" ? 1 : 0.95),
            y: clamp(start.y + dy, 0, mode === "focus" ? 1 : 0.95),
          });
      };
      const stop = () => {
        target.removeEventListener("pointermove", move);
        target.removeEventListener("pointerup", stop);
        target.removeEventListener("pointercancel", stop);
      };
      target.addEventListener("pointermove", move);
      target.addEventListener("pointerup", stop);
      target.addEventListener("pointercancel", stop);
    };
  const canvasText = (o: Overlay, field: "text" | "sub" = "text") =>
    onOverlay ? (
      <CanvasText
        value={o[field] ?? ""}
        label={
          field === "text" ? "Edit text in preview" : "Edit subtitle in preview"
        }
        maxLength={field === "text" ? 500 : 200}
        onSelect={() => {
          pause();
          onPickOverlay?.(o.id);
        }}
        onSave={(value) => onOverlay(o.id, { [field]: value })}
      />
    ) : (
      o[field]
    );
  const still = (e: React.MouseEvent) => e.stopPropagation();
  // The camera bubble can be picked up and put anywhere in the frame.
  const movable = Boolean(onCamera && plan.preset === "pip" && plan.camera);
  const dragged = useRef(false);
  const dragCamera = (e: React.PointerEvent<HTMLElement>) => {
    const area = canvas.current?.getBoundingClientRect();
    if (!onCamera || !area || e.button) return;
    const target = e.currentTarget,
      from = { x: e.clientX, y: e.clientY },
      start = { x: l.camera.x, y: l.camera.y };
    dragged.current = false;
    target.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => {
      if (Math.hypot(ev.clientX - from.x, ev.clientY - from.y) > 3)
        dragged.current = true;
      if (!dragged.current) return;
      onCamera({
        x: clamp(start.x + (ev.clientX - from.x) / area.width, 0, 0.95),
        y: clamp(start.y + (ev.clientY - from.y) / area.height, 0, 0.95),
      });
    };
    const stop = () => {
      target.removeEventListener("pointermove", move);
      target.removeEventListener("pointerup", stop);
      target.removeEventListener("pointercancel", stop);
    };
    target.addEventListener("pointermove", move);
    target.addEventListener("pointerup", stop);
    target.addEventListener("pointercancel", stop);
  };
  // Words on the edited timeline: only those inside a kept section, shifted to match.
  const spoken = useMemo(() => {
    const out: Word[] = [];
    segs.forEach((s, i) => {
      if (s.sourceId !== videoId) return;
      for (const w of words)
        if (w.end > s.start && w.start < s.end)
          out.push({
            ...w,
            start: starts[i] + Math.max(0, w.start - s.start),
            end: starts[i] + Math.min(s.end, w.end) - s.start,
          });
    });
    return out;
  }, [segs, starts, words, videoId]);
  const caption = useMemo(() => {
    if (!l.captions) return null;
    const style = l.captionStyle || "clean";
    const at = spoken.findIndex((w) => t >= w.start && t < w.end + 0.25);
    if (at < 0) return null;
    // Show a few words around the one being spoken.
    const size = style === "highlight" ? 4 : 8;
    const first = Math.floor(at / size) * size;
    return {
      style,
      words: spoken.slice(first, first + size),
      current: at - first,
    };
  }, [l.captions, l.captionStyle, spoken, t]);

  const box = (b: Box | null): React.CSSProperties =>
    b
      ? {
          left: pct(b.x, l.width),
          top: pct(b.y, l.height),
          width: pct(b.w, l.width),
          height: pct(b.h, l.height),
          borderRadius: `${(b.r / l.width) * 100}cqw`,
          boxShadow: l.shadow
            ? `0 ${1.2 * l.shadow}cqw ${4 * l.shadow}cqw rgb(0 0 0 / ${0.5 * l.shadow})`
            : "none",
          opacity: 1,
        }
      : { left: "50%", top: "50%", width: "0%", height: "0%", opacity: 0 };
  return (
    <div
      className="draft-player"
      style={{ ["--ratio" as string]: l.width / l.height }}
    >
      <div
        className={`draft-canvas ${onOverlay && !playing ? "is-editing" : ""}`}
        ref={canvas}
        style={{
          aspectRatio: `${l.width}/${l.height}`,
          background:
            l.wallpaper && l.wallpaper !== "none"
              ? `center / cover url(/wallpapers/${l.wallpaper}.jpg)`
              : l.background,
          // Sizes inside are relative to the frame height, like the render.
          ["--h" as string]: `${(l.height / l.width) * 100}cqw`,
        }}
        onClick={toggle}
      >
        <div className="draft-box" style={box(plan.screen)}>
          <video
            ref={screen}
            muted={muted || !voiceMissing}
            playsInline
            preload="auto"
            onLoadedMetadata={(e) => {
              const v = e.currentTarget;
              if (v.videoWidth && v.videoHeight)
                setAspect(v.videoWidth / v.videoHeight);
            }}
            style={zoomed}
          />
          <div className="draft-on-screen" style={zoomed}>
            {showing.map((o) => {
              const on = held.get(o.id);
              return (
                on && (
                  <div
                    key={o.id}
                    className="draft-fx blur"
                    style={{
                      left: `${on.x * 100}%`,
                      top: `${on.y * 100}%`,
                      width: `${on.w * 100}%`,
                      height: `${on.h * 100}%`,
                    }}
                    onPointerDown={playing ? undefined : drag(o, "move")}
                    onClick={still}
                  >
                    {onOverlay && !playing && (
                      <i
                        className="draft-fx-size"
                        onPointerDown={drag(o, "size")}
                        onClick={still}
                      />
                    )}
                  </div>
                )
              );
            })}
          </div>
        </div>
        {hasCamera && (
          <div
            className={`draft-box ${movable ? "is-movable" : ""}`}
            style={box(cameraMissing ? null : plan.camera)}
            title={movable ? "Drag to move your camera" : undefined}
            onPointerDown={movable ? dragCamera : undefined}
            onClick={(e) => {
              // A drag is not a click on the video.
              if (dragged.current) e.stopPropagation();
              dragged.current = false;
            }}
          >
            <video
              ref={camera}
              muted
              playsInline
              preload="auto"
              onError={() => setCameraMissing(true)}
              onLoadedMetadata={() => setCameraMissing(false)}
            />
          </div>
        )}
        <audio
          ref={voice}
          muted={muted}
          preload="auto"
          onError={() => setVoiceMissing(true)}
          onLoadedMetadata={() => setVoiceMissing(false)}
        />
        {effects.map((o) => {
          const fade = textFade(o);
          return (
            <div
              key={o.id}
              data-selected={focusOverlayId === o.id || undefined}
              className={`draft-fx ${o.type}`}
              data-text-style={
                o.type === "text" ? o.textStyle || "label" : undefined
              }
              style={{
                left: `${o.x * 100}%`,
                top: `${o.y * 100}%`,
                ...(o.type === "blur" || o.type === "box"
                  ? { width: `${o.w * 100}%`, height: `${o.h * 100}%` }
                  : {}),
                color: o.color,
                ...(o.type === "text"
                  ? {
                      fontSize: `calc(var(--h) * ${o.textSize ?? Math.max(18 / l.height, DEFAULT_TEXT_SIZE)})`,
                      opacity: fade
                        ? Math.min(1, (t - o.start) / fade, (o.end - t) / fade)
                        : undefined,
                    }
                  : {}),
              }}
              onPointerDown={playing ? undefined : drag(o, "move")}
              onClick={(e) => {
                still(e);
                onPickOverlay?.(o.id);
              }}
            >
              {o.type === "text"
                ? canvasText(o)
                : o.type === "arrow"
                  ? o.text || "→"
                  : o.type === "cursor"
                    ? "●"
                    : null}
              {(o.type === "blur" || o.type === "box") &&
                onOverlay &&
                !playing && (
                  <i
                    className="draft-fx-size"
                    onPointerDown={drag(o, "size")}
                    onClick={still}
                  />
                )}
            </div>
          );
        })}
        {zoom && onOverlay && !playing && plan.screen && (
          <div
            className="draft-fx-focus"
            title="Drag to choose where the zoom closes in"
            style={{
              left: pct(plan.screen.x + zoom.x * plan.screen.w, l.width),
              top: pct(plan.screen.y + zoom.y * plan.screen.h, l.height),
            }}
            onPointerDown={drag(zoom, "focus")}
            onClick={still}
          />
        )}
        {titles.map((o) =>
          o.type === "title" ? (
            <div className="draft-title" key={o.id}>
              <i style={{ background: o.color }} />
              <strong>{canvasText(o)}</strong>
              {o.sub && <span>{canvasText(o, "sub")}</span>}
            </div>
          ) : o.type === "lowerthird" ? (
            <div className="draft-lower" key={o.id}>
              <i style={{ background: o.color }} />
              <strong>{canvasText(o)}</strong>
              {o.sub && <span>{canvasText(o, "sub")}</span>}
            </div>
          ) : (
            <div
              className="draft-chapter"
              key={o.id}
              style={{ background: o.color }}
            >
              {canvasText(o)}
            </div>
          ),
        )}
        {caption && (
          <div className={`draft-caption ${caption.style}`}>
            <span>
              {caption.words.map((w, i) => (
                <b
                  key={i}
                  className={
                    caption.style === "highlight" && i === caption.current
                      ? "now"
                      : undefined
                  }
                >
                  {w.text}{" "}
                </b>
              ))}
            </span>
          </div>
        )}
        {!playing && !titles.some((o) => o.type === "title") && (
          <span className="draft-play" aria-hidden="true">
            <Play size={30} fill="currentColor" />
          </span>
        )}
      </div>
      <div className="draft-controls">
        <button
          className="icon-button"
          aria-label={playing ? "Pause" : "Play"}
          onClick={toggle}
        >
          {playing ? <Pause size={18} /> : <Play size={18} />}
        </button>
        <span className="draft-time">
          {clock(t)} <span>/ {clock(total)}</span>
        </span>
        <div className="draft-scrub">
          <div className="draft-marks" aria-hidden="true">
            {starts.slice(1).map((at) => (
              <i key={at} style={{ left: pct(at, total || 1) }} />
            ))}
          </div>
          <input
            type="range"
            aria-label="Position in video"
            aria-valuetext={`${clock(t)} of ${clock(total)}`}
            min={0}
            max={total || 1}
            step={0.05}
            value={Math.min(t, total)}
            onChange={(e) => seek(+e.target.value)}
            onKeyDown={(e) => {
              const by =
                e.key === "ArrowRight"
                  ? 5
                  : e.key === "ArrowLeft"
                    ? -5
                    : e.key === "PageUp"
                      ? total / 10
                      : e.key === "PageDown"
                        ? -total / 10
                        : 0;
              if (!by) return;
              e.preventDefault();
              e.stopPropagation();
              seek(t + by);
            }}
            style={{ ["--played" as string]: pct(t, total || 1) }}
          />
        </div>
        <button
          className="icon-button"
          aria-label="Mute"
          title={muted ? "Turn sound on" : "Mute"}
          aria-pressed={muted}
          onClick={() => setMuted(!muted)}
        >
          {muted ? <VolumeX size={18} /> : <Volume2 size={18} />}
        </button>
      </div>
    </div>
  );
});
