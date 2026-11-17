// Where the screen and camera sit for each layout. Mirrors server/studio/compose.mjs
// so the editor preview matches the rendered video.
import type { Project } from "./types";

export type LayoutPreset = "pip" | "side" | "screen" | "camera";
export const PRESETS: { id: LayoutPreset; label: string; hint: string }[] = [
  { id: "pip", label: "Bubble", hint: "Screen with your camera on top" },
  {
    id: "side",
    label: "Side by side",
    hint: "Screen and camera share the frame",
  },
  { id: "screen", label: "Screen", hint: "Just the screen" },
  { id: "camera", label: "Camera", hint: "Just you" },
];
export const WALLPAPERS = [
  "aurora",
  "dusk",
  "ocean",
  "ember",
  "mint",
  "candy",
  "graphite",
  "paper",
  "pine",
];
export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
  r: number;
}
const fit = (
  aspect: number,
  f: { x: number; y: number; w: number; h: number },
) => {
  let w = f.w,
    h = w / aspect;
  if (h > f.h) {
    h = f.h;
    w = h * aspect;
  }
  return { x: f.x + (f.w - w) / 2, y: f.y + (f.h - h) / 2, w, h };
};
// Where an effect placed on the frame sits on the screen picture, as fractions
// of the picture. Null when its middle is not over the picture at all. Mirrors
// onScreen in server/studio/compose.mjs.
export function onScreen(
  effect: { x: number; y: number; w: number; h: number },
  screen: Box | null,
  W: number,
  H: number,
) {
  if (!screen) return null;
  const left = effect.x * W,
    top = effect.y * H,
    wide = effect.w * W,
    high = effect.h * H,
    cx = left + wide / 2,
    cy = top + high / 2;
  if (
    cx < screen.x ||
    cx > screen.x + screen.w ||
    cy < screen.y ||
    cy > screen.y + screen.h
  )
    return null;
  const within = (n: number) => Math.max(0, Math.min(1, n)),
    x = within((left - screen.x) / screen.w),
    y = within((top - screen.y) / screen.h);
  return {
    x,
    y,
    w: within((left + wide - screen.x) / screen.w) - x,
    h: within((top + high - screen.y) / screen.h) - y,
  };
}
export function planLayout(
  layout: Project["layout"],
  preset: LayoutPreset,
  screenAspect: number,
  hasCamera: boolean,
): { preset: LayoutPreset; screen: Box | null; camera: Box | null } {
  const W = layout.width,
    H = layout.height,
    pad = layout.padding,
    radius = (layout.radius || 0) * W,
    inner = { x: pad, y: pad, w: W - pad * 2, h: H - pad * 2 },
    cam = layout.camera;
  if (!hasCamera || !cam.visible) preset = "screen";
  if (preset === "camera")
    return { preset, screen: null, camera: { ...inner, r: radius } };
  if (preset === "side") {
    const gap = Math.max(pad, W * 0.02),
      cw = inner.w * 0.27,
      ch = Math.min(inner.h, cw * 1.25);
    const screen = fit(screenAspect, {
      x: inner.x,
      y: inner.y,
      w: inner.w - cw - gap,
      h: inner.h,
    });
    const left = (W - (screen.w + gap + cw)) / 2;
    return {
      preset,
      screen: { ...screen, x: left, r: radius },
      camera: {
        x: left + screen.w + gap,
        y: (H - ch) / 2,
        w: cw,
        h: ch,
        r: Math.max(radius, cw * 0.08),
      },
    };
  }
  const screen = { ...fit(screenAspect, inner), r: radius };
  if (preset === "screen") return { preset, screen, camera: null };
  const cw = Math.max(32, W * cam.size),
    ch = cam.shape === "portrait" ? cw * 1.35 : cw;
  return {
    preset: "pip",
    screen,
    camera: {
      x: Math.min(W - cw, Math.max(0, W * cam.x)),
      y: Math.min(H - ch, Math.max(0, H * cam.y)),
      w: cw,
      h: ch,
      r: cam.shape === "circle" ? cw / 2 : radius ? cw * 0.14 : 0,
    },
  };
}
