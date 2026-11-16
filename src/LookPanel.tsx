import { radio } from "./Modal";
import { useEffect, useId, useState, type ReactNode } from "react";
import { Ban, Plus, Trash2 } from "lucide-react";
import type { Project } from "./types";
import { PRESETS, WALLPAPERS, type LayoutPreset } from "./layoutPlan";
import "./look-panel.css";

// A number you can type freely. A value is applied as soon as it makes sense, so
// half-typed or emptied text never reaches the project; leaving the field puts
// back the last good value.
export function NumberField({
  value,
  onCommit,
  min,
  max,
  step,
  valid = () => true,
}: {
  value: number;
  onCommit: (n: number) => void;
  min: number;
  max: number;
  step?: string;
  valid?: (n: number) => boolean;
}) {
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  return (
    <input
      type="number"
      min={min}
      max={max}
      step={step}
      value={text}
      onChange={(e) => {
        setText(e.target.value);
        const n = Number(e.target.value);
        if (
          e.target.value.trim() !== "" &&
          Number.isFinite(n) &&
          n >= min &&
          n <= max &&
          valid(n) &&
          n !== value
        )
          onCommit(n);
      }}
      onBlur={() => setText(String(value))}
    />
  );
}

// The shortest a layout change may be, with room for floating-point subtraction.
const MIN_SCENE = 0.5 - 1e-6;

// One slider everywhere: its name, how far along it is, and the value in words.
export function Slider({
  label,
  value,
  min,
  max,
  step,
  onChange,
  format,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (value: number) => void;
  format?: (value: number) => string;
}) {
  const id = useId();
  const fill = ((value - min) / (max - min || 1)) * 100;
  const text = format ? format(value) : `${Math.round(fill)}%`;
  return (
    <div className="slider">
      <label htmlFor={id}>{label}</label>
      <output htmlFor={id}>{text}</output>
      <input
        id={id}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        aria-valuetext={text}
        onChange={(e) => onChange(+e.target.value)}
        style={{ ["--fill" as string]: `${fill}%` }}
      />
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
          {...radio(value === p.id)}
          aria-label={small ? p.label : undefined}
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

// Wallpaper and frame ("background") or layout controls for the Look tab.
export function LookControls({
  part,
  project,
  total,
  edit,
  now,
  children,
}: {
  part: "background" | "layout";
  project: Project;
  total: number;
  edit: (fn: (p: Project) => void) => void;
  // Where the preview is paused, for "start here" and "end here".
  now: () => number;
  children?: ReactNode;
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
    });
  if (part === "background")
    return (
      <div className="look-controls look-background">
        <div className="look-group">
          <strong>Wallpaper</strong>
          <div
            className="wallpaper-grid"
            role="radiogroup"
            aria-label="Wallpaper"
          >
            <button
              type="button"
              {...radio(!l.wallpaper || l.wallpaper === "none")}
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
                {...radio(l.wallpaper === w)}
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
        <div className="look-group">
          <Slider
            label="Padding"
            min={0}
            max={Math.floor(Math.min(l.width, l.height) / 4)}
            step={2}
            value={l.padding}
            onChange={(v) => edit((p) => (p.layout.padding = v))}
          />
          <Slider
            label="Rounded corners"
            min={0}
            max={0.05}
            step={0.002}
            value={l.radius || 0}
            onChange={(v) => edit((p) => (p.layout.radius = v))}
          />
          <Slider
            label="Shadow"
            min={0}
            max={1}
            step={0.05}
            value={l.shadow || 0}
            onChange={(v) => edit((p) => (p.layout.shadow = v))}
          />
          {children}
        </div>
      </div>
    );
  return (
    <div className="look-controls">
      <PresetTiles
        label="Layout"
        value={(l.preset || "pip") as LayoutPreset}
        onChange={(preset) => {
          edit((p) => (p.layout.preset = preset));
        }}
      />
      {scenes.map((s, i) => (
        <div
          className="effect-row scene-row"
          role="group"
          aria-label={`Layout change ${i + 1}`}
          key={s.id}
        >
          <strong id={`fx-${s.id}`}>Layout change {i + 1}</strong>
          <PresetTiles
            small
            label={`Layout for change ${i + 1}`}
            value={s.preset as LayoutPreset}
            onChange={(preset) => {
              edit((p) => (p.scenes![i].preset = preset));
            }}
          />
          <label>
            Starts at (sec)
            <NumberField
              min={0}
              max={total}
              step=".1"
              value={s.start}
              valid={(n) => s.end - n >= MIN_SCENE}
              onCommit={(n) => edit((p) => (p.scenes![i].start = n))}
            />
          </label>
          <label>
            Ends at (sec)
            <NumberField
              min={0}
              max={total}
              step=".1"
              value={s.end}
              valid={(n) => n - s.start >= MIN_SCENE}
              onCommit={(n) => edit((p) => (p.scenes![i].end = n))}
            />
          </label>
          <button
            className="btn"
            aria-label={`Start here: layout change ${i + 1}`}
            onClick={() =>
              edit((p) => {
                const scene = p.scenes![i];
                scene.start = Math.min(now(), scene.end - 0.5);
              })
            }
          >
            Start here
          </button>
          <button
            className="btn"
            aria-label={`End here: layout change ${i + 1}`}
            onClick={() =>
              edit((p) => {
                const scene = p.scenes![i];
                scene.end = Math.max(now(), scene.start + 0.5);
              })
            }
          >
            End here
          </button>
          <button
            className="icon-button danger"
            aria-label={`Remove layout change ${i + 1}`}
            onClick={(e) => {
              edit((p) => p.scenes!.splice(i, 1));
              // Keep the keyboard somewhere sensible once this row is gone.
              e.currentTarget
                .closest(".look-controls")
                ?.querySelector<HTMLElement>(".add-scene")
                ?.focus();
            }}
          >
            <Trash2 size={15} />
          </button>
        </div>
      ))}
      <button className="btn add-scene" onClick={addScene}>
        <Plus size={14} />
        Change layout partway through
      </button>
      {children}
    </div>
  );
}
