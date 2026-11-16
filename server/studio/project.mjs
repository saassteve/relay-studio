import { problem, parseJSON } from "./schema.mjs";
import { WALLPAPERS, PRESETS } from "./compose.mjs";
import { CAPTION_STYLES, TITLE_TYPES } from "./titles.mjs";
// The shortest a layout change may be, with room for floating-point subtraction.
const MIN_SCENE = 0.5 - 1e-6;
export const defaultLayout = () => ({
  width: 1280,
  height: 720,
  padding: 0,
  background: "#173e32",
  wallpaper: "none",
  radius: 0,
  shadow: 0,
  preset: "pip",
  camera: { visible: true, x: 0.03, y: 0.67, size: 0.17, shape: "circle" },
  audio: { microphone: 1, system: 1, normalize: true, denoise: false },
  captions: false,
});
export const initialProject = (v) => ({
  version: 1,
  segments: [{ sourceId: v.id, start: 0, end: v.duration }],
  layout: defaultLayout(),
  overlays: [],
  cta: { label: "", url: "" },
});
const number = (v, min, max, name) => {
  if (typeof v !== "number" || !Number.isFinite(v) || v < min || v > max)
    throw problem(400, `Invalid ${name}.`);
  return v;
};
export function validateProject(input, find) {
  if (
    !input ||
    input.version !== 1 ||
    !Array.isArray(input.segments) ||
    !input.segments.length ||
    input.segments.length > 100
  )
    throw problem(400, "A project needs 1–100 video sections.");
  const segments = input.segments.map((s) => {
    if (!s || typeof s !== "object")
      throw problem(400, "A project needs 1–100 video sections.");
    const source = find(String(s.sourceId));
    const start = number(s.start, 0, source.duration, "section start"),
      end = number(s.end, 0, source.duration + 0.05, "section end");
    if (end - start < 0.08)
      throw problem(400, "Sections must be at least 0.08 seconds.");
    return { sourceId: source.id, start, end };
  });
  if (segments.reduce((n, s) => n + s.end - s.start, 0) > 86400)
    throw problem(400, "The edited video is too long.");
  const raw = input.layout || {},
    base = defaultLayout(),
    camera = { ...base.camera, ...raw.camera },
    audio = { ...base.audio, ...raw.audio };
  const width = number(raw.width ?? 1280, 320, 3840, "export width"),
    height = number(raw.height ?? 720, 180, 2160, "export height");
  if (width % 2 || height % 2)
    throw problem(400, "Export dimensions must be even numbers.");
  const background = /^#[0-9a-f]{6}$/i.test(raw.background || "")
    ? raw.background
    : base.background;
  for (const name of ["x", "y"]) number(camera[name], 0, 1, `camera ${name}`);
  number(camera.size, 0.05, 0.6, "camera size");
  if (!["circle", "square", "portrait"].includes(camera.shape))
    throw problem(400, "Choose a supported camera shape.");
  for (const name of ["microphone", "system"])
    number(audio[name], 0, 3, `${name} volume`);
  const layout = {
    width,
    height,
    padding: number(
      raw.padding ?? 0,
      0,
      Math.floor(Math.min(width, height) / 3),
      "padding",
    ),
    background,
    wallpaper: WALLPAPERS.includes(raw.wallpaper) ? raw.wallpaper : "none",
    radius: number(raw.radius ?? 0, 0, 0.08, "corner radius"),
    shadow: number(raw.shadow ?? 0, 0, 1, "shadow"),
    preset: PRESETS.includes(raw.preset) ? raw.preset : "pip",
    camera: { ...camera, visible: camera.visible !== false },
    audio: {
      ...audio,
      normalize: audio.normalize !== false,
      denoise: Boolean(audio.denoise),
    },
    captions: Boolean(raw.captions),
    captionStyle: CAPTION_STYLES.includes(raw.captionStyle)
      ? raw.captionStyle
      : "clean",
  };
  const total = segments.reduce((n, s) => n + s.end - s.start, 0);
  if (
    !Array.isArray(input.overlays || []) ||
    (input.overlays || []).length > 60
  )
    throw problem(400, "Use at most 60 visual effects.");
  const overlays = (input.overlays || [])
    .map((o, i) => {
      if (
        ![
          "text",
          "arrow",
          "box",
          "blur",
          "zoom",
          "cursor",
          ...TITLE_TYPES,
        ].includes(o?.type)
      )
        throw problem(400, "Unsupported visual effect.");
      const start = number(o.start, 0, 86400, "effect start"),
        until = number(o.end, 0, 86400.05, "effect end");
      if (until <= start)
        throw problem(400, "An effect must have a positive duration.");
      // Trimming the video can leave an effect hanging past the end: keep what fits.
      if (start > total - 0.1) return null;
      const end = Math.min(until, total);
      return {
        id: String(o.id || i).slice(0, 80),
        type: o.type,
        start,
        end,
        // A zoom's point of focus can sit right on the edge of the frame.
        x: number(o.x ?? 0.1, 0, o.type === "zoom" ? 1 : 0.95, "effect x"),
        y: number(o.y ?? 0.1, 0, o.type === "zoom" ? 1 : 0.95, "effect y"),
        w: number(o.w ?? 0.3, 0.01, 1, "effect width"),
        h: number(o.h ?? 0.15, 0.01, 1, "effect height"),
        scale: number(o.scale ?? 1.8, 1, 4, "zoom"),
        text: String(o.text || "").slice(0, 500),
        ...(TITLE_TYPES.includes(o.type)
          ? { sub: String(o.sub || "").slice(0, 200) }
          : {}),
        color: /^#[a-f0-9]{6}$/i.test(o.color || "") ? o.color : "#d6f475",
        ...(o.type === "zoom" && o.auto === true ? { auto: true } : {}),
      };
    })
    .filter(Boolean);
  const cta = {
    label: String(input.cta?.label || "").slice(0, 80),
    url: String(input.cta?.url || "").slice(0, 2000),
  };
  if (cta.url && !/^https?:\/\//.test(cta.url))
    throw problem(400, "The call-to-action URL must use HTTP or HTTPS.");
  if (!Array.isArray(input.scenes || []) || (input.scenes || []).length > 40)
    throw problem(400, "Use at most 40 layout changes.");
  const scenes = (input.scenes || [])
    .map((sc, i) => {
      if (!PRESETS.includes(sc?.preset))
        throw problem(400, "Choose a supported layout.");
      const start = number(sc.start, 0, 86400, "layout start"),
        until = number(sc.end, 0, 86400.05, "layout end");
      if (until - start < MIN_SCENE)
        throw problem(400, "A layout change must last at least half a second.");
      const end = Math.min(until, total);
      if (end - start < MIN_SCENE) return null;
      return {
        id: String(sc.id || i).slice(0, 80),
        start,
        end,
        preset: sc.preset,
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.start - b.start);
  return { version: 1, segments, layout, overlays, scenes, cta };
}
export function getProject(v) {
  const p = parseJSON(v.project, {});
  return p.version === 1 ? p : initialProject(v);
}
// Removes stretches of one source from the video. Titles, effects and layout changes
// move with what they were pointing at, and anything that was cut away goes too.
export function cutRanges(project, sourceId, ranges) {
  // The same stretches on the timeline as it is now.
  const gone = [];
  let offset = 0;
  for (const s of project.segments) {
    if (s.sourceId === sourceId)
      for (const r of ranges) {
        const start = Math.max(r.start, s.start),
          end = Math.min(r.end, s.end);
        if (end > start)
          gone.push({
            start: offset + start - s.start,
            end: offset + end - s.start,
          });
      }
    offset += s.end - s.start;
  }
  gone.sort((a, b) => a.start - b.start);
  const removed = [];
  for (const g of gone) {
    const last = removed.at(-1);
    if (last && g.start <= last.end) last.end = Math.max(last.end, g.end);
    else removed.push({ ...g });
  }
  let segments = project.segments;
  for (const r of ranges) {
    segments = segments.flatMap((s) => {
      if (s.sourceId !== sourceId || r.end <= s.start || r.start >= s.end)
        return [s];
      const out = [];
      if (r.start - s.start >= 0.08) out.push({ ...s, end: r.start });
      if (s.end - r.end >= 0.08) out.push({ ...s, start: r.end });
      return out;
    });
  }
  if (!segments.length)
    throw problem(400, "These cuts would remove the entire video.");
  const total = segments.reduce((n, s) => n + s.end - s.start, 0);
  const remap = (t) => {
    let before = 0;
    for (const r of removed) {
      if (t >= r.end) before += r.end - r.start;
      else if (t > r.start) before += t - r.start;
    }
    return Math.min(total, Math.max(0, t - before));
  };
  const moved = (items, shortest) =>
    (items || [])
      .map((item) => ({
        ...item,
        start: remap(item.start),
        end: remap(item.end),
      }))
      .filter((item) => item.end - item.start >= shortest);
  return {
    ...project,
    segments,
    overlays: moved(project.overlays, 0.1),
    ...(project.scenes ? { scenes: moved(project.scenes, MIN_SCENE) } : {}),
  };
}
// Checks a transcript against the length of its recording and returns clean words.
export function transcriptWords(words, duration) {
  if (!Array.isArray(words) || words.length > 100000)
    throw problem(400, "Invalid transcript.");
  return words.map((w) => {
    const start = Number(w?.start),
      end = Number(w?.end),
      text = String(w?.text || "").slice(0, 2000);
    if (
      !Number.isFinite(start) ||
      !Number.isFinite(end) ||
      start < 0 ||
      end <= start ||
      end > duration + 0.5
    )
      throw problem(400, "Transcript timestamps are outside the recording.");
    return {
      text,
      start,
      end,
      granularity: w.granularity === "segment" ? "segment" : "word",
    };
  });
}
export function outputWords(project, find) {
  let offset = 0;
  const result = [];
  for (const segment of project.segments) {
    const words = parseJSON(find(segment.sourceId).transcript, []);
    for (const w of words) {
      if (w.end > segment.start && w.start < segment.end)
        result.push({
          ...w,
          sourceId: segment.sourceId,
          sourceStart: w.start,
          sourceEnd: w.end,
          start: offset + Math.max(0, w.start - segment.start),
          end:
            offset +
            Math.min(segment.end - segment.start, w.end - segment.start),
        });
    }
    offset += segment.end - segment.start;
  }
  return result;
}
export function captionCues(words) {
  const result = [];
  let cue;
  for (const word of words) {
    if (!cue || word.end - cue.start > 3.5 || cue.text.length > 70) {
      cue = { start: word.start, end: word.end, text: word.text.trim() };
      result.push(cue);
    } else {
      cue.end = word.end;
      cue.text += " " + word.text.trim();
    }
  }
  return result;
}
const stamp = (time, separator = ".") => {
  const ms = Math.round(Math.max(0, time) * 1000);
  return `${String(Math.floor(ms / 3600000)).padStart(2, "0")}:${String(Math.floor(ms / 60000) % 60).padStart(2, "0")}:${String(Math.floor(ms / 1000) % 60).padStart(2, "0")}${separator}${String(ms % 1000).padStart(3, "0")}`;
};
export const captions = (words, format = "vtt") =>
  (format === "vtt" ? "WEBVTT\n\n" : "") +
  captionCues(words)
    .map(
      (c, i) =>
        `${format === "srt" ? `${i + 1}\n` : ""}${stamp(c.start, format === "srt" ? "," : ".")} --> ${stamp(c.end, format === "srt" ? "," : ".")}\n${c.text.replaceAll("-->", "→")}\n`,
    )
    .join("\n");
// A timing line such as "00:01.000 --> 00:04.000". It is anchored, and no two
// neighbouring parts can match the same character, so a hostile line is still
// read in one pass.
const TIMING = /^[ \t]*(\d[\d:.,]*)[ \t]*-->[ \t]*(\d[\d:.,]*)/;
// Removes <tags> in one pass. A "<" that is never closed stays as text.
function withoutTags(value) {
  let out = "",
    at = 0;
  for (;;) {
    const open = value.indexOf("<", at),
      close = open < 0 ? -1 : value.indexOf(">", open);
    if (close < 0) return out + value.slice(at);
    out += value.slice(at, open);
    at = close + 1;
  }
}
export function parseCaptions(content) {
  if (typeof content !== "string" || content.length > 1000000)
    throw problem(400, "The caption file is too large.");
  const result = [];
  const time = (s) => {
    const p = s.replace(",", ".").split(":").map(Number);
    return p.length === 3 ? p[0] * 3600 + p[1] * 60 + p[2] : p[0] * 60 + p[1];
  };
  for (const block of content.replaceAll("\r", "").split(/\n\s*\n/)) {
    const lines = block.split("\n"),
      i = lines.findIndex((l) => l.includes("-->"));
    if (i < 0) continue;
    const match = lines[i].slice(0, 200).match(TIMING);
    if (!match) continue;
    const start = time(match[1]),
      end = time(match[2]),
      text = withoutTags(lines.slice(i + 1).join(" ")).trim();
    if (Number.isFinite(start) && Number.isFinite(end) && end > start && text)
      result.push({ start, end, text, granularity: "segment" });
  }
  if (!result.length)
    throw problem(400, "No valid captions were found. Import SRT or WebVTT.");
  return result;
}
// Notes about a video (summary, chapters, action items) arrive from imported
// bundles and from the editor. Only known fields of the right kind are kept.
export function cleanOutline(input) {
  const o = input && typeof input === "object" ? input : {},
    line = (v, max) => (typeof v === "string" ? v.slice(0, max) : ""),
    out = {};
  if (typeof o.summary === "string") out.summary = o.summary.slice(0, 10000);
  if (Array.isArray(o.chapters))
    out.chapters = o.chapters
      .slice(0, 2000)
      .map((c) => ({ time: Number(c?.time), title: line(c?.title, 300) }))
      .filter((c) => Number.isFinite(c.time) && c.time >= 0 && c.title);
  if (Array.isArray(o.actionItems))
    out.actionItems = o.actionItems
      .slice(0, 30)
      .filter((s) => typeof s === "string")
      .map((s) => s.slice(0, 1000));
  for (const [name, max] of [
    ["title", 300],
    ["provider", 80],
    ["generatedBy", 80],
    ["generated", 40],
    // The sections these notes describe; they are hidden once the edit changes.
    ["projectSegments", 40000],
  ])
    if (line(o[name], max)) out[name] = line(o[name], max);
  return out;
}

export function publishedProject(v) {
  const p = parseJSON(v.published_project, {});
  return p.version === 1 ? p : initialProject(v);
}
