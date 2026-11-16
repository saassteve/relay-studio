import { useRef, useState } from "react";
import { Ban, Play, Plus, Trash2 } from "lucide-react";
import type { Project } from "./types";
import {
  PRESETS,
  WALLPAPERS,
  planLayout,
  type Box,
  type LayoutPreset,
} from "./layoutPlan";
import "./look-panel.css";

const pct = (n: number, of: number) => `${(n / of) * 100}%`;

// A live preview of the framed video. Elements glide between layouts the way
// the rendered video blends between them.
export function LayoutPreview({
  project,
  preset,
  screenSrc,
  cameraSrc,
}: {
  project: Project;
  preset: LayoutPreset;
  screenSrc: string;
  cameraSrc: string | null;
}) {
  const root = useRef<HTMLDivElement>(null);
  const [aspect, setAspect] = useState(16 / 9);
  const l = project.layout,
    plan = planLayout(l, preset, aspect, Boolean(cameraSrc));
  const place = (b: Box | null): React.CSSProperties =>
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
    <div>
      <div
        className="look-canvas"
        ref={root}
        style={{
          aspectRatio: `${l.width}/${l.height}`,
          background:
            l.wallpaper && l.wallpaper !== "none"
              ? `center / cover url(/wallpapers/${l.wallpaper}.jpg)`
              : l.background,
        }}
      >
        <video
          src={screenSrc}
          muted
          playsInline
          preload="auto"
          onLoadedMetadata={(e) => {
            const v = e.currentTarget;
            if (v.videoWidth && v.videoHeight)
              setAspect(v.videoWidth / v.videoHeight);
          }}
          style={place(plan.screen)}
        />
        {cameraSrc && (
          <video
            className="look-camera"
            src={cameraSrc}
            muted
            playsInline
            preload="auto"
            style={place(plan.camera)}
          />
        )}
      </div>
      <button
        className="text-button small"
        onClick={() =>
          root.current?.querySelectorAll("video").forEach((v) => {
            if (v.paused) void v.play().catch(() => {});
            else v.pause();
          })
        }
      >
        <Play size={13} />
        Play preview
      </button>
    </div>
  );
}

export function PresetTiles({
  value,
  onChange,
  label,
  small,
}: {
  value: LayoutPreset;
  onChange: (p: LayoutPreset) => void;
  label: string;
  small?: boolean;
}) {
  return (
    <div
      className={`preset-tiles ${small ? "small" : ""}`}
      role="radiogroup"
      aria-label={label}
    >
      {PRESETS.map((p) => (
        <button
          type="button"
          key={p.id}
          role="radio"
          aria-checked={value === p.id}
          title={p.hint}
          className={value === p.id ? "selected" : undefined}
          onClick={() => onChange(p.id)}
        >
          <i className={`preset-art ${p.id}`} aria-hidden="true">
            <b />
            <u />
          </i>
          {!small && <span>{p.label}</span>}
        </button>
      ))}
    </div>
  );
}

// Wallpaper, frame and layout controls for the Presentation tab.
export function LookControls({
  project,
  total,
  hasCamera,
  edit,
  previewing,
  setPreviewing,
}: {
  project: Project;
  total: number;
  hasCamera: boolean;
  edit: (fn: (p: Project) => void) => void;
  previewing: string;
  setPreviewing: (id: string) => void;
}) {
  const l = project.layout,
    scenes = project.scenes || [];
  const addScene = () =>
    edit((p) => {
      const list = (p.scenes ||= []);
      const start = Math.min(
        Math.max(0, total - 1),
        list.length
          ? Math.max(...list.map((s) => s.end))
          : Math.min(3, total / 3),
      );
      const id = crypto.randomUUID();
      list.push({
        id,
        start: +start.toFixed(1),
        end: +Math.min(total, start + 4).toFixed(1),
        preset: (p.layout.preset || "pip") === "pip" ? "side" : "pip",
      });
      setPreviewing(id);
    });
  return (
    <div className="look-controls">
      <div className="look-group">
        <strong>Wallpaper</strong>
        <div
          className="wallpaper-grid"
          role="radiogroup"
          aria-label="Wallpaper"
        >
          <button
            type="button"
            role="radio"
            aria-checked={!l.wallpaper || l.wallpaper === "none"}
            aria-label="No wallpaper"
            className={
              !l.wallpaper || l.wallpaper === "none" ? "selected" : undefined
            }
            onClick={() => edit((p) => (p.layout.wallpaper = "none"))}
          >
            <Ban size={15} />
          </button>
          {WALLPAPERS.map((w) => (
            <button
              type="button"
              key={w}
              role="radio"
              aria-checked={l.wallpaper === w}
              aria-label={`${w} wallpaper`}
              title={w[0].toUpperCase() + w.slice(1)}
              className={l.wallpaper === w ? "selected" : undefined}
              style={{ backgroundImage: `url(/wallpapers/${w}.jpg)` }}
              onClick={() =>
                edit((p) => {
                  p.layout.wallpaper = w;
                  // A wallpaper needs room to show: give the frame sensible defaults.
                  if (!p.layout.padding)
                    p.layout.padding =
                      Math.round((p.layout.width * 0.045) / 2) * 2;
                  if (!p.layout.radius) p.layout.radius = 0.012;
                  if (!p.layout.shadow) p.layout.shadow = 0.7;
                })
              }
            />
          ))}
        </div>
      </div>
      <div className="look-group look-sliders">
        <label>
          Padding
          <input
            aria-label="Canvas padding"
            type="range"
            min={0}
            max={Math.floor(Math.min(l.width, l.height) / 4)}
            step={2}
            value={l.padding}
            onChange={(e) => edit((p) => (p.layout.padding = +e.target.value))}
          />
        </label>
        <label>
          Rounded corners
          <input
            aria-label="Corner radius"
            type="range"
            min={0}
            max={0.05}
            step={0.002}
            value={l.radius || 0}
            onChange={(e) => edit((p) => (p.layout.radius = +e.target.value))}
          />
        </label>
        <label>
          Shadow
          <input
            aria-label="Shadow"
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={l.shadow || 0}
            onChange={(e) => edit((p) => (p.layout.shadow = +e.target.value))}
          />
        </label>
      </div>
      {hasCamera && (
        <div className="look-group">
          <strong>Layout</strong>
          <PresetTiles
            label="Layout"
            value={(l.preset || "pip") as LayoutPreset}
            onChange={(preset) => {
              edit((p) => (p.layout.preset = preset));
              setPreviewing("base");
            }}
          />
          <div className="scene-strip" aria-hidden="true">
            {scenes.map((s) => (
              <i
                key={s.id}
                className={previewing === s.id ? "active" : undefined}
                style={{
                  left: pct(s.start, total),
                  width: pct(s.end - s.start, total),
                }}
              />
            ))}
          </div>
          {scenes.map((s, i) => (
            <div
              className={`scene-row ${previewing === s.id ? "active" : ""}`}
              key={s.id}
              onClick={() => setPreviewing(s.id)}
            >
              <PresetTiles
                small
                label={`Layout change ${i + 1}`}
                value={s.preset as LayoutPreset}
                onChange={(preset) =>
                  edit((p) => (p.scenes![i].preset = preset))
                }
              />
              <label>
                From
                <input
                  aria-label={`Layout change ${i + 1} start`}
                  type="number"
                  min={0}
                  max={total}
                  step=".1"
                  value={s.start}
                  onChange={(e) =>
                    edit((p) => (p.scenes![i].start = +e.target.value))
                  }
                />
              </label>
              <label>
                To
                <input
                  aria-label={`Layout change ${i + 1} end`}
                  type="number"
                  min={0}
                  max={total}
                  step=".1"
                  value={s.end}
                  onChange={(e) =>
                    edit((p) => (p.scenes![i].end = +e.target.value))
                  }
                />
              </label>
              <button
                className="icon-button"
                aria-label={`Remove layout change ${i + 1}`}
                onClick={(e) => {
                  e.stopPropagation();
                  edit((p) => p.scenes!.splice(i, 1));
                  setPreviewing("base");
                }}
              >
                <Trash2 size={14} />
              </button>
            </div>
          ))}
          <button className="text-button small" onClick={addScene}>
            <Plus size={13} />
            Change layout partway through
          </button>
        </div>
      )}
    </div>
  );
}
