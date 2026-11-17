// Frame composition: where the screen and camera sit on the canvas for each
// layout preset, plus the static artwork (wallpaper, shadows, rounded masks)
// that makes a recording look finished.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import ffmpeg from "../ffmpeg.mjs";

const run = promisify(execFile);
const appRoot = fileURLToPath(new URL("../..", import.meta.url));
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
export const PRESETS = ["pip", "side", "screen", "camera"];
export const wallpaperFile = (name) =>
  ["public/wallpapers", "dist/wallpapers"]
    .map((p) => path.join(appRoot, p, `${name}.jpg`))
    .find((p) => existsSync(p));

const even = (n) => Math.max(2, Math.round(n / 2) * 2);
// Largest box of the given aspect that fits inside a frame, centred.
function fit(aspect, frame) {
  let w = frame.w,
    h = w / aspect;
  if (h > frame.h) {
    h = frame.h;
    w = h * aspect;
  }
  w = even(w);
  h = even(h);
  return {
    x: Math.round(frame.x + (frame.w - w) / 2),
    y: Math.round(frame.y + (frame.h - h) / 2),
    w,
    h,
  };
}

// Where each element sits for a preset. Coordinates are canvas pixels.
export function planLayout(layout, preset, screenAspect, hasCamera) {
  const W = layout.width,
    H = layout.height,
    pad = Math.round(layout.padding),
    radius = Math.round((layout.radius || 0) * W),
    inner = { x: pad, y: pad, w: W - pad * 2, h: H - pad * 2 };
  const cam = layout.camera;
  if (!hasCamera || !cam.visible) preset = "screen";
  if (preset === "camera")
    return {
      preset,
      screen: null,
      camera: { ...inner, w: even(inner.w), h: even(inner.h), r: radius },
    };
  if (preset === "side") {
    const gap = Math.max(pad, Math.round(W * 0.02)),
      cw = even(inner.w * 0.27),
      ch = even(Math.min(inner.h, cw * 1.25));
    const screen = fit(screenAspect, {
      x: inner.x,
      y: inner.y,
      w: inner.w - cw - gap,
      h: inner.h,
    });
    // Keep the pair centred as a group.
    const total = screen.w + gap + cw,
      left = Math.round((W - total) / 2);
    screen.x = left;
    return {
      preset,
      screen: { ...screen, r: radius },
      camera: {
        x: left + screen.w + gap,
        y: Math.round((H - ch) / 2),
        w: cw,
        h: ch,
        r: Math.max(radius, Math.round(cw * 0.08)),
      },
    };
  }
  const screen = { ...fit(screenAspect, inner), r: radius };
  if (preset === "screen") return { preset, screen, camera: null };
  const cw = even(Math.max(32, W * cam.size)),
    ch = cam.shape === "portrait" ? even(cw * 1.35) : cw;
  return {
    preset: "pip",
    screen,
    camera: {
      x: Math.min(W - cw, Math.max(0, Math.round(W * cam.x))),
      y: Math.min(H - ch, Math.max(0, Math.round(H * cam.y))),
      w: cw,
      h: ch,
      r: cam.shape === "circle" ? cw / 2 : radius ? Math.round(cw * 0.14) : 0,
    },
  };
}

// Where an effect placed on the frame sits on the screen picture, as fractions
// of the picture. Null when its middle is not over the picture at all.
export function onScreen(effect, screen, W, H) {
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
  const within = (n) => Math.max(0, Math.min(1, n)),
    x = within((left - screen.x) / screen.w),
    y = within((top - screen.y) / screen.h);
  return {
    x,
    y,
    w: within((left + wide - screen.x) / screen.w) - x,
    h: within((top + high - screen.y) / screen.h) - y,
  };
}

// Anti-aliased rounded rectangle of size w×h centred in the image, as luma.
const roundedRect = (w, h, r) =>
  `255*clip(${r}-hypot(max(abs(X-(W-1)/2)-(${w / 2 - r}),0),max(abs(Y-(H-1)/2)-(${h / 2 - r}),0))+0.5,0,1)`;

async function image(args, out) {
  await run(
    ffmpeg,
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-nostdin",
      "-y",
      ...args,
      "-frames:v",
      "1",
      out,
    ],
    { timeout: 120000, maxBuffer: 1024 * 1024 },
  );
  return out;
}

// Builds (and caches per render) the stills a layout needs.
export function createArtwork(temp, layout) {
  const cache = new Map();
  const once = (key, make) => {
    if (!cache.has(key)) cache.set(key, make());
    return cache.get(key);
  };
  const W = layout.width,
    H = layout.height,
    strength = Math.max(0, Math.min(1, layout.shadow || 0)),
    sigma = Math.max(2, Math.round(W * 0.014 * (0.5 + strength / 2))),
    margin = sigma * 3,
    opacity = (0.55 * strength).toFixed(3);
  const shadowChain = (box) => {
    const sw = box.w + margin * 2,
      sh = box.h + margin * 2;
    return {
      sw,
      sh,
      chain:
        `color=black:s=${sw}x${sh},format=gray,geq=lum='${roundedRect(box.w, box.h, Math.min(box.r, box.w / 2, box.h / 2))}',` +
        `gblur=sigma=${sigma},lut=y=val*${opacity}`,
    };
  };
  return {
    margin,
    hasShadow: strength > 0,
    mask: (box) =>
      once(`mask:${box.w}x${box.h}:${box.r}`, () =>
        image(
          [
            "-f",
            "lavfi",
            "-i",
            `color=black:s=${box.w}x${box.h},format=gray,geq=lum='${roundedRect(box.w, box.h, Math.min(box.r, box.w / 2, box.h / 2))}'`,
          ],
          path.join(temp, `mask-${cache.size}.png`),
        ),
      ),
    // A standalone shadow, for elements that sit on top of others.
    shadow: (box) =>
      once(`shadow:${box.w}x${box.h}:${box.r}`, () => {
        const s = shadowChain(box);
        return image(
          [
            "-f",
            "lavfi",
            "-i",
            `color=black:s=${s.sw}x${s.sh},format=rgba[c];${s.chain}[a];[c][a]alphamerge`,
          ],
          path.join(temp, `shadow-${cache.size}.png`),
        );
      }),
    // Wallpaper (or colour) with the shadows of the given boxes baked in.
    background: (key, boxes) =>
      once(`bg:${key}`, () => {
        const file = layout.wallpaper && wallpaperFile(layout.wallpaper);
        const args = file
          ? ["-i", file]
          : [
              "-f",
              "lavfi",
              "-i",
              `color=c=${layout.background.replace("#", "0x")}:s=${W}x${H}`,
            ];
        let graph = `[0:v]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},format=rgb24[b0]`,
          last = "b0";
        if (strength > 0)
          boxes.forEach((box, i) => {
            const s = shadowChain(box);
            graph +=
              `;color=black:s=${s.sw}x${s.sh},format=rgba[c${i}];${s.chain}[a${i}];[c${i}][a${i}]alphamerge[s${i}]` +
              `;[${last}][s${i}]overlay=${box.x - margin}:${box.y - margin + Math.round(sigma * 0.6)}[b${i + 1}]`;
            last = `b${i + 1}`;
          });
        return image(
          [...args, "-filter_complex", graph, "-map", `[${last}]`],
          path.join(temp, `bg-${cache.size}.png`),
        );
      }),
  };
}
