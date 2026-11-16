import { problem, parseJSON } from "./schema.mjs";
export const defaultLayout = () => ({
  width: 1280,
  height: 720,
  padding: 0,
  background: "#173e32",
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
    camera: { ...camera, visible: camera.visible !== false },
    audio: {
      ...audio,
      normalize: audio.normalize !== false,
      denoise: Boolean(audio.denoise),
    },
    captions: Boolean(raw.captions),
  };
  const total = segments.reduce((n, s) => n + s.end - s.start, 0);
  if (
    !Array.isArray(input.overlays || []) ||
    (input.overlays || []).length > 60
  )
    throw problem(400, "Use at most 60 visual effects.");
  const overlays = (input.overlays || []).map((o, i) => {
    if (!["text", "arrow", "box", "blur", "zoom", "cursor"].includes(o.type))
      throw problem(400, "Unsupported visual effect.");
    const start = number(o.start, 0, total, "effect start"),
      end = number(o.end, 0, total + 0.05, "effect end");
    if (end <= start)
      throw problem(400, "An effect must have a positive duration.");
    return {
      id: String(o.id || i).slice(0, 80),
      type: o.type,
      start,
      end,
      x: number(o.x ?? 0.1, 0, 0.95, "effect x"),
      y: number(o.y ?? 0.1, 0, 0.95, "effect y"),
      w: number(o.w ?? 0.3, 0.01, 1, "effect width"),
      h: number(o.h ?? 0.15, 0.01, 1, "effect height"),
      scale: number(o.scale ?? 1.8, 1, 4, "zoom"),
      text: String(o.text || "").slice(0, 500),
      color: /^#[a-f0-9]{6}$/i.test(o.color || "") ? o.color : "#d6f475",
      ...(o.type === "zoom" && o.auto === true ? { auto: true } : {}),
    };
  });
  const cta = {
    label: String(input.cta?.label || "").slice(0, 80),
    url: String(input.cta?.url || "").slice(0, 2000),
  };
  if (cta.url && !/^https?:\/\//.test(cta.url))
    throw problem(400, "The call-to-action URL must use HTTP or HTTPS.");
  return { version: 1, segments, layout, overlays, cta };
}
export function getProject(v) {
  const p = parseJSON(v.project, {});
  return p.version === 1 ? p : initialProject(v);
}
export function cutRanges(project, sourceId, ranges) {
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
  return { ...project, segments };
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
export function parseCaptions(content) {
  if (typeof content !== "string" || content.length > 2000000)
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
    const match = lines[i].match(/([\d:. ,]+)\s*-->\s*([\d:.,]+)/);
    if (!match) continue;
    const start = time(match[1].trim()),
      end = time(match[2].trim()),
      text = lines
        .slice(i + 1)
        .join(" ")
        .replace(/<[^>]*>/g, "")
        .trim();
    if (Number.isFinite(start) && Number.isFinite(end) && end > start && text)
      result.push({ start, end, text, granularity: "segment" });
  }
  if (!result.length)
    throw problem(400, "No valid captions were found. Import SRT or WebVTT.");
  return result;
}

export function publishedProject(v) {
  const p = parseJSON(v.published_project, {});
  return p.version === 1 ? p : initialProject(v);
}
