// Live camera looks: colour filters and virtual backgrounds, computed on-device.
// Backgrounds use MediaPipe's selfie segmentation, served from Relay itself.
import type { ImageSegmenter } from "@mediapipe/tasks-vision";
import { ticker } from "./ticker";

export type CameraFilter =
  "none" | "vivid" | "warm" | "cool" | "mono" | "film" | "soft";
export interface CameraLook {
  filter: CameraFilter;
  background: string;
}

export const FILTERS: { id: CameraFilter; label: string; css: string }[] = [
  { id: "none", label: "Natural", css: "none" },
  { id: "vivid", label: "Vivid", css: "saturate(1.45) contrast(1.08)" },
  {
    id: "warm",
    label: "Warm",
    css: "sepia(0.22) saturate(1.25) hue-rotate(-6deg)",
  },
  {
    id: "cool",
    label: "Cool",
    css: "saturate(1.05) hue-rotate(10deg) brightness(1.03)",
  },
  { id: "mono", label: "Mono", css: "grayscale(1) contrast(1.12)" },
  {
    id: "film",
    label: "Film",
    css: "contrast(1.18) saturate(0.78) sepia(0.12) brightness(1.04)",
  },
  {
    id: "soft",
    label: "Soft",
    css: "brightness(1.07) contrast(0.92) saturate(0.96)",
  },
];
export const filterCSS = (id: string) =>
  FILTERS.find((f) => f.id === id)?.css || "none";

// Swatches mirror the procedural backgrounds drawn below.
export const BACKGROUNDS: { id: string; label: string; swatch: string }[] = [
  { id: "none", label: "None", swatch: "" },
  { id: "blur", label: "Blur", swatch: "" },
  {
    id: "pine",
    label: "Pine",
    swatch: "radial-gradient(circle at 70% 30%, #3f7a61, #173e32 70%)",
  },
  {
    id: "studio",
    label: "Studio",
    swatch: "radial-gradient(circle at 50% 35%, #e9ebe6, #8f948d 85%)",
  },
  {
    id: "dusk",
    label: "Dusk",
    swatch: "linear-gradient(135deg, #2b2d6e, #8c4f8f 55%, #f19b6b)",
  },
  {
    id: "sunrise",
    label: "Sunrise",
    swatch: "linear-gradient(160deg, #ffe8b8, #f7b48a 60%, #e98c7e)",
  },
];
const CUSTOM_KEY = "relay-custom-background";
export function customBackground(): string | null {
  try {
    return localStorage.getItem(CUSTOM_KEY);
  } catch {
    return null;
  }
}
// Scales an uploaded picture to 1280×720 so it fits comfortably in storage.
export async function saveCustomBackground(file: File): Promise<string> {
  const bitmap = await createImageBitmap(file);
  const c = document.createElement("canvas");
  c.width = 1280;
  c.height = 720;
  const g = c.getContext("2d")!;
  const s = Math.max(1280 / bitmap.width, 720 / bitmap.height);
  g.drawImage(
    bitmap,
    (1280 - bitmap.width * s) / 2,
    (720 - bitmap.height * s) / 2,
    bitmap.width * s,
    bitmap.height * s,
  );
  const url = c.toDataURL("image/jpeg", 0.85);
  try {
    localStorage.setItem(CUSTOM_KEY, url);
  } catch {
    throw new Error("That picture is too large to keep. Try a smaller one.");
  }
  return url;
}

function paintBackground(
  id: string,
  w: number,
  h: number,
): CanvasImageSource | string | null {
  if (/^#[0-9a-f]{6}$/i.test(id)) return id;
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const g = c.getContext("2d")!;
  const radial = (
    x: number,
    y: number,
    r: number,
    stops: [number, string][],
  ) => {
    const gr = g.createRadialGradient(
      x * w,
      y * h,
      0,
      x * w,
      y * h,
      r * Math.max(w, h),
    );
    stops.forEach(([o, col]) => gr.addColorStop(o, col));
    return gr;
  };
  const linear = (angle: number, stops: [number, string][]) => {
    const a = (angle * Math.PI) / 180,
      dx = Math.cos(a) * w,
      dy = Math.sin(a) * h;
    const gr = g.createLinearGradient(
      w / 2 - dx / 2,
      h / 2 - dy / 2,
      w / 2 + dx / 2,
      h / 2 + dy / 2,
    );
    stops.forEach(([o, col]) => gr.addColorStop(o, col));
    return gr;
  };
  const bokeh = (colors: string[], count: number) => {
    for (let i = 0; i < count; i++) {
      const x = ((i * 0.618 + 0.13) % 1) * w,
        y = ((i * 0.377 + 0.21) % 1) * h * 0.8,
        r = (0.04 + ((i * 0.27) % 1) * 0.07) * w;
      const gr = g.createRadialGradient(x, y, 0, x, y, r);
      gr.addColorStop(0, colors[i % colors.length]);
      gr.addColorStop(1, "transparent");
      g.fillStyle = gr;
      g.fillRect(x - r, y - r, r * 2, r * 2);
    }
  };
  if (id === "pine") {
    g.fillStyle = radial(0.7, 0.3, 0.9, [
      [0, "#3f7a61"],
      [0.7, "#173e32"],
      [1, "#0f2a21"],
    ]);
    g.fillRect(0, 0, w, h);
    bokeh(["#d6f47533", "#9fd3a222", "#ffffff18"], 9);
  } else if (id === "studio") {
    g.fillStyle = radial(0.5, 0.35, 0.85, [
      [0, "#eceee9"],
      [1, "#8f948d"],
    ]);
    g.fillRect(0, 0, w, h);
  } else if (id === "dusk") {
    g.fillStyle = linear(35, [
      [0, "#2b2d6e"],
      [0.55, "#8c4f8f"],
      [1, "#f19b6b"],
    ]);
    g.fillRect(0, 0, w, h);
    bokeh(["#ffd6a033", "#ffffff22"], 7);
  } else if (id === "sunrise") {
    g.fillStyle = linear(70, [
      [0, "#ffe8b8"],
      [0.6, "#f7b48a"],
      [1, "#e98c7e"],
    ]);
    g.fillRect(0, 0, w, h);
    bokeh(["#ffffff40", "#fff3d044"], 8);
  } else if (id === "custom") {
    const url = customBackground();
    if (!url) return null;
    const img = new Image();
    img.src = url;
    return img;
  } else return null;
  return c;
}

let segmenter: Promise<ImageSegmenter> | null = null;
function loadSegmenter(): Promise<ImageSegmenter> {
  return (segmenter ??= (async () => {
    const { ImageSegmenter } = await import("@mediapipe/tasks-vision");
    const fileset = {
      wasmLoaderPath: "/vendor/mediapipe/vision_wasm_internal.js",
      wasmBinaryPath: "/vendor/mediapipe/vision_wasm_internal.wasm",
    };
    const options = (delegate: "GPU" | "CPU") => ({
      baseOptions: {
        modelAssetPath: "/models/selfie_segmenter.tflite",
        delegate,
      },
      runningMode: "VIDEO" as const,
      outputConfidenceMasks: true,
      outputCategoryMask: false,
    });
    try {
      return await ImageSegmenter.createFromOptions(fileset, options("GPU"));
    } catch {
      return await ImageSegmenter.createFromOptions(fileset, options("CPU"));
    }
  })().catch((e) => {
    segmenter = null;
    throw e;
  }));
}

export interface CameraPipeline {
  stream: MediaStream;
  setLook: (look: CameraLook) => void;
  stop: () => void;
  ready: Promise<void>;
}
export const isPlain = (look: CameraLook) =>
  (!look.filter || look.filter === "none") &&
  (!look.background || look.background === "none");

// Wraps a camera stream in a canvas pipeline and returns a processed stream.
// Frames are drawn on a timer, not animation frames, so recording continues while
// Relay's window is hidden.
export async function createCameraPipeline(
  source: MediaStream,
  initial: CameraLook,
  fps = 30,
): Promise<CameraPipeline> {
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.srcObject = source;
  await video.play();
  const settings = source.getVideoTracks()[0]?.getSettings() || {};
  const scale = Math.min(
    1,
    1280 / (settings.width || video.videoWidth || 1280),
  );
  const W =
      Math.round(((settings.width || video.videoWidth || 1280) * scale) / 2) *
      2,
    H =
      Math.round(((settings.height || video.videoHeight || 720) * scale) / 2) *
      2;
  const out = document.createElement("canvas");
  out.width = W;
  out.height = H;
  const ctx = out.getContext("2d")!;
  // Segmentation runs on a small copy of each frame.
  const small = document.createElement("canvas");
  small.width = 256;
  small.height = Math.round((256 * H) / W);
  const sctx = small.getContext("2d", { willReadFrequently: true })!;
  const mask = document.createElement("canvas");
  mask.width = small.width;
  mask.height = small.height;
  const mctx = mask.getContext("2d")!;
  const maskData = mctx.createImageData(mask.width, mask.height);
  const person = document.createElement("canvas");
  person.width = W;
  person.height = H;
  const pctx = person.getContext("2d")!;

  let look = initial,
    background: CanvasImageSource | string | null = null,
    model: ImageSegmenter | null = null,
    loading: Promise<void> = Promise.resolve(),
    stopTicker: () => void = () => {},
    stopped = false,
    hasMask = false,
    lastStamp = 0;
  const apply = (requested: CameraLook) => {
    // A custom picture lives in this browser only; without it, blur instead.
    const next =
      requested.background === "custom" && !customBackground()
        ? { ...requested, background: "blur" }
        : requested;
    look = next;
    background =
      next.background && !["none", "blur"].includes(next.background)
        ? paintBackground(next.background, W, H)
        : null;
    if (next.background && next.background !== "none" && !model)
      loading = loadSegmenter()
        .then((m) => {
          model = m;
        })
        .catch(() => {
          /* Fall back to the filter alone if segmentation can't start. */
        });
  };
  apply(initial);

  const segment = () => {
    if (!model) return;
    sctx.drawImage(video, 0, 0, small.width, small.height);
    const stamp = Math.max(lastStamp + 1, performance.now());
    lastStamp = stamp;
    const result = model.segmentForVideo(small, stamp);
    const confidence = result.confidenceMasks?.[0];
    if (confidence) {
      const values = confidence.getAsFloat32Array();
      const px = maskData.data;
      for (let i = 0; i < values.length; i++) {
        // Steepen the edge a little for a crisper cut-out.
        const a = Math.min(1, Math.max(0, (values[i] - 0.25) / 0.5));
        px[i * 4 + 3] = a * 255;
      }
      mctx.putImageData(maskData, 0, 0);
      hasMask = true;
    }
    result.close();
  };

  const draw = () => {
    if (stopped) return;
    const css = filterCSS(look.filter);
    if (video.readyState >= 2) {
      if (!look.background || look.background === "none" || !model) {
        ctx.filter = css;
        ctx.drawImage(video, 0, 0, W, H);
      } else {
        try {
          segment();
        } catch {
          /* Keep drawing frames even if one segmentation fails. */
        }
        // Background. Always painted, so nothing from earlier frames shows through.
        ctx.filter = "none";
        ctx.fillStyle = "#173e32";
        ctx.fillRect(0, 0, W, H);
        if (look.background === "blur") {
          ctx.filter = `blur(${Math.round(W / 60)}px) ${css === "none" ? "" : css}`;
          ctx.drawImage(video, -20, -20, W + 40, H + 40);
        } else if (typeof background === "string") {
          ctx.filter = "none";
          ctx.fillStyle = background;
          ctx.fillRect(0, 0, W, H);
        } else if (background) {
          ctx.filter = "none";
          try {
            ctx.drawImage(background, 0, 0, W, H);
          } catch {
            ctx.fillStyle = "#173e32";
            ctx.fillRect(0, 0, W, H);
          }
        }
        // Person, cut out by the feathered mask
        pctx.globalCompositeOperation = "copy";
        pctx.filter = css;
        pctx.drawImage(video, 0, 0, W, H);
        if (hasMask) {
          pctx.globalCompositeOperation = "destination-in";
          pctx.filter = `blur(${Math.max(1, Math.round(W / 400))}px)`;
          pctx.drawImage(mask, 0, 0, W, H);
        }
        ctx.filter = "none";
        ctx.drawImage(person, 0, 0);
      }
    }
  };
  draw();
  stopTicker = ticker(draw, fps);
  const stream = out.captureStream(fps);
  return {
    stream,
    setLook: apply,
    get ready() {
      return loading;
    },
    stop() {
      stopped = true;
      stopTicker();
      stream.getTracks().forEach((t) => t.stop());
      video.srcObject = null;
    },
  };
}
