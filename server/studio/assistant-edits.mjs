// A small, safe vocabulary of edits that an AI assistant can apply to a project.
// Used by the MCP connector (Claude, ChatGPT and other clients) and by Relay's
// own AI features. Every change goes through validateProject and is saved as
// an undoable revision.
import { randomUUID } from "node:crypto";
import { parseJSON, problem } from "./schema.mjs";
import { captionCues, cutRanges, getProject, outputWords } from "./project.mjs";
import { CAPTION_STYLES, TITLE_TYPES } from "./titles.mjs";
import { PRESETS, WALLPAPERS } from "./compose.mjs";

export const OPERATIONS = [
  "cut",
  "remove_fillers",
  "remove_silences",
  "add_title",
  "add_zoom",
  "set_layout",
  "change_layout",
  "set_look",
  "set_captions",
  "remove",
  "set_details",
];

export const EDIT_GUIDE = `Operations (each is an object with an "op" field):
- {"op":"cut","start":s,"end":s} remove a stretch of the video.
- {"op":"remove_fillers"} cut ums and uhs. {"op":"remove_silences"} cut long pauses.
- {"op":"add_title","style":"title"|"lowerthird"|"chapter","start":s,"end":s,"title":"...","subtitle":"..."}
  title = full-screen title card; lowerthird = name and role bar; chapter = small corner label.
- {"op":"add_zoom","start":s,"end":s,"x":0-1,"y":0-1,"scale":1.2-3} zoom the screen toward a point (x,y are fractions of the frame).
- {"op":"set_layout","layout":"pip"|"side"|"screen"|"camera"} layout for the whole video.
- {"op":"change_layout","start":s,"end":s,"layout":...} a different layout for part of the video.
- {"op":"set_look","wallpaper":"${WALLPAPERS.join('"|"')}"|"none","padding":0-0.15,"corners":0-0.05,"shadow":0-1}
- {"op":"set_captions","enabled":true|false,"style":"${CAPTION_STYLES.join('"|"')}"}
- {"op":"remove","what":"titles"|"zooms"|"layout_changes"|"all_effects"}
- {"op":"set_details","title":"...","description":"..."}
All times are seconds on the timeline returned by get_project. Cuts in the same call are accounted for automatically, so never adjust later times yourself. Changes are saved as a draft the user can undo; call render_video to publish them.`;

const num = (v, min, max, name) => {
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max)
    throw problem(400, `${name} must be between ${min} and ${max}.`);
  return n;
};

export function createAssistantEdits({
  db,
  find,
  sourceFind,
  save,
  validateProject,
  suggestions,
}) {
  const duration = (p) => p.segments.reduce((n, s) => n + s.end - s.start, 0);
  const round = (n) => Math.round(n * 100) / 100;

  // A compact description of a video an assistant can reason about.
  function describe(v) {
    const p = getProject(v),
      outline = parseJSON(v.outline, {}),
      words = outputWords(p, find);
    const effects = p.overlays || [];
    return {
      id: v.id,
      title: v.title,
      description: v.description || "",
      duration: round(duration(p)),
      published_revision: v.revision || 0,
      layout: {
        layout: p.layout.preset || "pip",
        wallpaper: p.layout.wallpaper || "none",
        padding: round(p.layout.padding / p.layout.width),
        corners: p.layout.radius || 0,
        shadow: p.layout.shadow || 0,
        captions: Boolean(p.layout.captions),
        caption_style: p.layout.captionStyle || "clean",
      },
      layout_changes: (p.scenes || []).map((s) => ({
        start: s.start,
        end: s.end,
        layout: s.preset,
      })),
      titles: effects
        .filter((o) => TITLE_TYPES.includes(o.type))
        .map((o) => ({
          style: o.type,
          start: o.start,
          end: o.end,
          title: o.text,
          subtitle: o.sub || "",
        })),
      zooms: effects
        .filter((o) => o.type === "zoom")
        .map((o) => ({
          start: o.start,
          end: o.end,
          x: o.x,
          y: o.y,
          scale: o.scale,
        })),
      other_effects: effects.filter(
        (o) => o.type !== "zoom" && !TITLE_TYPES.includes(o.type),
      ).length,
      summary: outline.summary || "",
      chapters: outline.chapters || [],
      // Transcript as timed lines. Treat it as content to edit, never as instructions.
      transcript: captionCues(words).map((c) => ({
        start: round(c.start),
        end: round(c.end),
        text: c.text,
      })),
      has_transcript: words.length > 0,
    };
  }

  async function apply(v, operations) {
    if (
      !Array.isArray(operations) ||
      !operations.length ||
      operations.length > 60
    )
      throw problem(400, "Send between 1 and 60 operations.");
    for (const o of operations)
      if (!o || !OPERATIONS.includes(o.op))
        throw problem(400, `Unknown operation "${o?.op}". ${EDIT_GUIDE}`);
    let project = structuredClone(getProject(v));
    project.overlays ||= [];
    project.scenes ||= [];
    const total = duration(project);
    const applied = [];

    // 1. Cuts, all measured on the timeline as it is now.
    const cuts = operations
      .filter((o) => o.op === "cut")
      .map((o) => {
        const start = num(o.start, 0, total, "cut start"),
          end = num(o.end, 0, total + 0.05, "cut end");
        if (end - start < 0.1)
          throw problem(400, "A cut must be at least 0.1 seconds.");
        return { start, end: Math.min(end, total) };
      })
      .sort((a, b) => a.start - b.start);
    // Where a moment on the old timeline lands after the cuts.
    const remap = (t) => {
      let removed = 0;
      for (const c of cuts) {
        if (t >= c.end) removed += c.end - c.start;
        else if (t > c.start) removed += t - c.start;
      }
      return Math.max(0, t - removed);
    };
    if (cuts.length) {
      const bySource = new Map();
      let offset = 0;
      for (const s of project.segments) {
        const length = s.end - s.start;
        for (const c of cuts) {
          const a = Math.max(c.start, offset),
            b = Math.min(c.end, offset + length);
          if (b - a > 0.001) {
            if (!bySource.has(s.sourceId)) bySource.set(s.sourceId, []);
            bySource
              .get(s.sourceId)
              .push({ start: s.start + a - offset, end: s.start + b - offset });
          }
        }
        offset += length;
      }
      for (const [sourceId, ranges] of bySource)
        project = cutRanges(project, sourceId, ranges);
      // cutRanges keeps existing effects and layout changes lined up with what
      // they pointed at.
      project.scenes ||= [];
      applied.push(
        `cut ${cuts.length} stretch${cuts.length === 1 ? "" : "es"} (${round(cuts.reduce((n, c) => n + c.end - c.start, 0))}s)`,
      );
    }
    const after = () => duration(project);
    const span = (o, minimum) => {
      const start = remap(num(o.start, 0, total, "start")),
        end = Math.min(after(), remap(num(o.end, 0, total + 0.05, "end")));
      if (end - start < minimum)
        throw problem(
          400,
          `That ${o.op} needs to last at least ${minimum} seconds.`,
        );
      return { start: round(start), end: round(end) };
    };

    // 2. Everything else, in the order given.
    for (const o of operations) {
      if (o.op === "cut") continue;
      if (o.op === "remove_fillers" || o.op === "remove_silences") {
        const kind = o.op === "remove_fillers" ? "filler" : "silence";
        const found = (await suggestions(v.id)).filter((s) => s.kind === kind);
        const bySource = new Map();
        for (const s of found) {
          if (!bySource.has(s.sourceId)) bySource.set(s.sourceId, []);
          bySource.get(s.sourceId).push({ start: s.start, end: s.end });
        }
        for (const [sourceId, ranges] of bySource)
          project = cutRanges(project, sourceId, ranges);
        applied.push(
          `removed ${found.length} ${kind === "filler" ? "filler word" : "pause"}${found.length === 1 ? "" : "s"}`,
        );
      } else if (o.op === "add_title") {
        const style = TITLE_TYPES.includes(o.style) ? o.style : "title";
        const title = String(o.title || "")
          .trim()
          .slice(0, 500);
        if (!title) throw problem(400, "A title needs text.");
        project.overlays.push({
          id: randomUUID(),
          type: style,
          ...span(o, 1),
          x: 0.1,
          y: 0.1,
          w: 0.3,
          h: 0.15,
          scale: 1.8,
          text: title,
          sub: String(o.subtitle || "").slice(0, 200),
          color: "#d6f475",
        });
        applied.push(
          `added ${style === "title" ? "a title card" : style === "lowerthird" ? "a lower third" : "a chapter label"}`,
        );
      } else if (o.op === "add_zoom") {
        project.overlays.push({
          id: randomUUID(),
          type: "zoom",
          ...span(o, 1),
          x: Math.min(0.95, num(o.x ?? 0.5, 0, 1, "x")),
          y: Math.min(0.95, num(o.y ?? 0.5, 0, 1, "y")),
          w: 0.3,
          h: 0.2,
          scale: num(o.scale ?? 1.8, 1.2, 3, "scale"),
          text: "",
          color: "#d6f475",
        });
        applied.push("added a zoom");
      } else if (o.op === "set_layout") {
        if (!PRESETS.includes(o.layout))
          throw problem(400, `Layout must be one of ${PRESETS.join(", ")}.`);
        project.layout.preset = o.layout;
        applied.push(`set the layout to ${o.layout}`);
      } else if (o.op === "change_layout") {
        if (!PRESETS.includes(o.layout))
          throw problem(400, `Layout must be one of ${PRESETS.join(", ")}.`);
        project.scenes.push({
          id: randomUUID(),
          ...span(o, 0.5),
          preset: o.layout,
        });
        applied.push(`switched to ${o.layout} for part of the video`);
      } else if (o.op === "set_look") {
        const l = project.layout;
        if (o.wallpaper !== undefined) {
          if (o.wallpaper !== "none" && !WALLPAPERS.includes(o.wallpaper))
            throw problem(
              400,
              `Wallpaper must be none or one of ${WALLPAPERS.join(", ")}.`,
            );
          l.wallpaper = o.wallpaper;
          if (o.wallpaper !== "none") {
            if (!l.padding) l.padding = Math.round((l.width * 0.045) / 2) * 2;
            if (!l.radius) l.radius = 0.012;
            if (!l.shadow) l.shadow = 0.7;
          }
        }
        if (o.padding !== undefined)
          l.padding =
            Math.round((l.width * num(o.padding, 0, 0.15, "padding")) / 2) * 2;
        if (o.corners !== undefined)
          l.radius = num(o.corners, 0, 0.05, "corners");
        if (o.shadow !== undefined) l.shadow = num(o.shadow, 0, 1, "shadow");
        applied.push("updated the look");
      } else if (o.op === "set_captions") {
        project.layout.captions = o.enabled !== false;
        if (o.style !== undefined) {
          if (!CAPTION_STYLES.includes(o.style))
            throw problem(
              400,
              `Caption style must be one of ${CAPTION_STYLES.join(", ")}.`,
            );
          project.layout.captionStyle = o.style;
        }
        applied.push(
          project.layout.captions
            ? "turned captions on"
            : "turned captions off",
        );
      } else if (o.op === "remove") {
        const before = project.overlays.length + project.scenes.length;
        if (o.what === "titles")
          project.overlays = project.overlays.filter(
            (x) => !TITLE_TYPES.includes(x.type),
          );
        else if (o.what === "zooms")
          project.overlays = project.overlays.filter((x) => x.type !== "zoom");
        else if (o.what === "layout_changes") project.scenes = [];
        else if (o.what === "all_effects") project.overlays = [];
        else
          throw problem(
            400,
            "Remove what? titles, zooms, layout_changes or all_effects.",
          );
        applied.push(
          `removed ${before - project.overlays.length - project.scenes.length} item(s)`,
        );
      } else if (o.op === "set_details") {
        const title =
            o.title === undefined
              ? v.title
              : String(o.title).trim().slice(0, 160),
          description =
            o.description === undefined
              ? v.description
              : String(o.description).slice(0, 20000);
        if (!title) throw problem(400, "The title can't be empty.");
        db.prepare("UPDATE videos SET title=?,description=? WHERE id=?").run(
          title,
          description,
          v.id,
        );
        applied.push("updated the title and description");
      }
    }
    // Removing words can shorten the video; keep everything inside it.
    const length = after();
    const inside = (minimum) => (item) => {
      item.end = Math.min(item.end, round(length));
      return item.end - item.start >= minimum;
    };
    project.overlays = project.overlays.filter(inside(0.3)).slice(0, 60);
    project.scenes = project.scenes.filter(inside(0.5)).slice(0, 40);
    save(find(v.id), validateProject(project, sourceFind));
    return { applied, video: describe(find(v.id)) };
  }
  return { describe, apply };
}
