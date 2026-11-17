import { execFile, spawn } from "node:child_process";
import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import ffmpeg from "../ffmpeg.mjs";
import { zoomFilter } from "./autozoom.mjs";
import { createArtwork, onScreen, planLayout } from "./compose.mjs";
import { outputWords } from "./project.mjs";
import { parseJSON, problem } from "./schema.mjs";
import { buildASS, buildTextASS, TITLE_TYPES } from "./titles.mjs";

const run = promisify(execFile);
// Every render is 30 frames a second with 48 kHz sound: 1600 samples a frame.
const FPS = 30,
  RATE = 48000;
// Fonts ship in public/ from source and in dist/ in production images.
const appRoot = fileURLToPath(new URL("../..", import.meta.url));
const fontsDir =
  ["public/fonts", "dist/fonts"]
    .map((p) => path.join(appRoot, p))
    .find((p) => existsSync(p)) || path.join(appRoot, "public/fonts");

// Splits a section into stretches that each use one layout.
export function layoutPieces(scenes, offset, length, base) {
  const points = new Set([0, length]);
  const local = scenes
    .map((s) => ({
      start: Math.max(0, s.start - offset),
      end: Math.min(length, s.end - offset),
      preset: s.preset,
    }))
    .filter((s) => s.end - s.start > 0.05);
  for (const s of local) points.add(s.start).add(s.end);
  const cuts = [...points].sort((a, b) => a - b);
  const pieces = [];
  for (let i = 0; i < cuts.length - 1; i++) {
    const start = cuts[i],
      end = cuts[i + 1],
      mid = (start + end) / 2,
      scene = local.findLast((s) => mid >= s.start && mid < s.end),
      preset = scene ? scene.preset : base,
      previous = pieces.at(-1);
    // Join equal neighbours, and fold slivers into what came before.
    if (previous && (previous.preset === preset || end - start < 0.6))
      previous.end = end;
    else pieces.push({ start, end, preset });
  }
  if (pieces.length > 1 && pieces[0].end - pieces[0].start < 0.6) {
    pieces[1].start = 0;
    pieces.shift();
  }
  return pieces;
}
// Blurs parts of a picture `wide` by `high`. Each blur is given as fractions of
// the picture, with its times on the picture's own clock.
function hide(graph, label, blurs, wide, high) {
  const even = (n) => Math.floor(n / 2) * 2;
  let last = label;
  blurs.forEach((o, i) => {
    const x = Math.min(wide - 4, even(o.x * wide)),
      y = Math.min(high - 4, even(o.y * high)),
      w = Math.max(4, Math.min(wide - x, even(o.w * wide + 1))),
      h = Math.max(4, Math.min(high - y, even(o.h * high + 1))),
      during = `enable='between(t,${o.start.toFixed(3)},${o.end.toFixed(3)})'`;
    graph.push(
      `[${last}]split[${label}b${i}][${label}u${i}]`,
      `[${label}u${i}]crop=${w}:${h}:${x}:${y},${blurOf(w, h, wide)}[${label}d${i}]`,
      `[${label}b${i}][${label}d${i}]overlay=${x}:${y}:${during}[${label}h${i}]`,
    );
    last = `${label}h${i}`;
  });
  return last;
}
// A blur strong enough to hide text in an area `w` by `h` of a picture `wide`
// across: stronger on a larger picture, and never more than the area allows.
const blurOf = (w, h, wide) => {
  const most = Math.max(8, Math.round(wide / 64)),
    small = Math.min(w, h);
  return `boxblur=lr=${Math.max(1, Math.min(most, Math.floor(small / 4)))}:lp=2:cr=${Math.max(1, Math.min(most >> 1, Math.floor(small / 8)))}:cp=2`;
};
export async function probe(file) {
  try {
    await run(ffmpeg, ["-hide_banner", "-i", file], { maxBuffer: 1024 * 1024 });
  } catch (e) {
    const text = e.stderr || "";
    const d = text.match(/Duration: (\d+):(\d+):([\d.]+)/),
      wh = text.match(/Video:.*? (\d{2,5})x(\d{2,5})(?:[,\s])/);
    return {
      hasAudio: /Audio:/.test(text),
      hasVideo: /Video:/.test(text),
      duration: d ? +d[1] * 3600 + +d[2] * 60 + +d[3] : 0,
      width: wh ? +wh[1] : 1280,
      height: wh ? +wh[2] : 720,
    };
  }
  return {
    hasAudio: false,
    hasVideo: false,
    duration: 0,
    width: 1280,
    height: 720,
  };
}
export const filterPath = (p) =>
  p.replaceAll("\\", "/").replaceAll(":", "\\:").replaceAll("'", "'\\''");

// Runs FFmpeg. A long or large video may take hours, so there is no time limit:
// it is stopped only when nothing it reports has moved for several minutes.
export function engine(args, { stall = 600000, log = "error" } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      ffmpeg,
      [
        "-hide_banner",
        "-loglevel",
        log,
        "-nostdin",
        "-nostats",
        "-progress",
        "pipe:1",
        ...args,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    const seen = {};
    let stderr = "",
      pending = "",
      stalled = false,
      timer;
    const watch = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        stalled = true;
        child.kill("SIGKILL");
      }, stall);
    };
    watch();
    child.stdout.on("data", (data) => {
      const lines = (pending + data).split("\n");
      pending = lines.pop();
      let moved = false;
      for (const line of lines) {
        const [key, value] = line.split("=");
        if (
          ["frame", "out_time", "out_time_us", "total_size"].includes(key) &&
          seen[key] !== value
        ) {
          seen[key] = value;
          moved = true;
        }
      }
      if (moved) watch();
    });
    child.stderr.on(
      "data",
      (data) => (stderr = (stderr + data).slice(-4 * 1024 * 1024)),
    );
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (stalled)
        reject(
          problem(
            504,
            "This video took too long to process: the media engine stopped making progress. Try again, or export a shorter or smaller video.",
          ),
        );
      else if (code === 0) resolve({ stderr });
      else
        reject(
          Object.assign(
            new Error(`Command failed: ${ffmpeg} ${args.join(" ")}\n${stderr}`),
            { code, stderr },
          ),
        );
    });
  });
}
// Working folders left in tmp/ by a job that was cut short when Relay quit.
export function sweep(dataDir, ...prefixes) {
  const tmp = path.join(dataDir, "tmp");
  try {
    for (const name of readdirSync(tmp))
      if (prefixes.some((p) => name.startsWith(p)))
        rmSync(path.join(tmp, name), { recursive: true, force: true });
  } catch {
    /* Nothing to clear. */
  }
}

export function createRenderer({ db, dataDir, find }) {
  sweep(dataDir, "render-");
  const media = (f) => path.join(dataDir, "media", f);
  const assetsFor = (v) => {
    let assets = db.prepare("SELECT * FROM assets WHERE video_id=?").all(v.id);
    if (!assets.length) {
      db.prepare("INSERT OR IGNORE INTO assets VALUES(?,?,?,?,?,?)").run(
        v.id,
        "primary",
        v.filename,
        v.mime,
        v.duration,
        "{}",
      );
      assets = db.prepare("SELECT * FROM assets WHERE video_id=?").all(v.id);
    }
    return assets;
  };
  const info = async (asset) => {
    let result = parseJSON(asset.info, {});
    if (result.hasVideo === undefined) {
      result = await probe(media(asset.filename));
      db.prepare("UPDATE assets SET info=? WHERE video_id=? AND role=?").run(
        JSON.stringify(result),
        asset.video_id,
        asset.role,
      );
    }
    return result;
  };
  async function render(video, project, destination, progress = () => {}) {
    if (!ffmpeg || !existsSync(ffmpeg))
      throw problem(503, "FFmpeg is unavailable. Reinstall dependencies.");
    const temp = mkdtempSync(path.join(dataDir, "tmp", "render-"));
    const l = project.layout,
      W = l.width,
      H = l.height;
    const art = createArtwork(temp, l);
    const encode = (crf) => [
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-crf",
      String(crf),
      "-pix_fmt",
      "yuv420p",
      "-threads",
      "2",
    ];
    const exec = (args) => engine(["-y", ...args]);
    // The whole soundtrack as plain samples. It is joined section by section
    // and only encoded once, at the end.
    const soundtrack = path.join(temp, "sound.pcm"),
      pcm = ["-f", "s16le", "-ar", String(RATE), "-ac", "2"];
    // Renders one stretch of a section in a single layout: `frames` of picture
    // to `out`, and `samples` of sound to `sound`. Either can be left out.
    async function piece({
      byRole,
      primary,
      aspect,
      recorded = 0,
      from,
      frames = 0,
      samples = 0,
      zooms = [],
      blurs = [],
      preset,
      towards,
      crf = 21,
      out,
      sound,
    }) {
      const args = [],
        d = frames / FPS;
      let index = 0;
      // A recording has no frames while its picture is still, so one that is
      // cut partway cannot be read from the cut onwards. Reading starts at the
      // keyframe before it, and `fps` below keeps the frame that was showing.
      const picture = (asset) => {
        args.push(
          "-noaccurate_seek",
          "-ss",
          String(from),
          "-i",
          media(asset.filename),
        );
        return index++;
      };
      const still = (file) => {
        args.push(
          "-loop",
          "1",
          "-framerate",
          String(FPS),
          "-t",
          String((frames + 0.5) / FPS),
          "-i",
          file,
        );
        return index++;
      };
      // A little more sound than needed is read, then cut to the sample.
      const audible = (asset) => {
        args.push(
          "-ss",
          String(from),
          "-t",
          String(samples / RATE + 0.1),
          "-i",
          media(asset.filename),
        );
        return index++;
      };
      // Exactly `frames` frames at a steady rate, starting at the cut.
      const steady = `fps=${FPS}:start_time=0,tpad=stop_mode=clone:stop_duration=${(d + 1).toFixed(3)},trim=end_frame=${frames}`;
      const graph = [];
      const cameraAsset = byRole.screen && byRole.camera ? byRole.camera : null;
      if (frames) {
        const plan = planLayout(l, preset, aspect, Boolean(cameraAsset)),
          // Set during a layout change: where everything is heading.
          next = towards
            ? planLayout(l, towards, aspect, Boolean(cameraAsset))
            : null;
        // How far a layout change has come, quick to start and gentle to land
        // like the preview. The last frame arrives.
        const along = (t) => `clip((${t}*${FPS}+1)/${frames},0,1)`,
          eased = `(1-pow(1-${along("t")},3))`,
          glide = (from, to) =>
            from === to ? String(from) : `(${from}+(${to - from})*${eased})`,
          fade = (direction) =>
            `format=rgba,fade=t=${direction}:st=0:d=${d.toFixed(4)}:alpha=1`,
          canvas = `color=black:s=${W}x${H}:r=${FPS},format=rgb24,trim=end_frame=${frames}`;
        const backdrop = async (p) =>
          still(
            await art.background(
              `${p.preset}:${aspect.toFixed(4)}`,
              [p.screen, p.preset === "pip" ? null : p.camera].filter(Boolean),
            ),
          );
        graph.push(
          `[${await backdrop(plan)}:v]fps=${FPS},format=rgb24,setsar=1,trim=end_frame=${frames}[bg]`,
        );
        let last = "bg",
          layers = 0;
        const over = (layer, x, y) => {
          const out = `on${layers++}`;
          graph.push(`[${last}][${layer}]overlay=${x}:${y}:shortest=1[${out}]`);
          last = out;
        };
        if (next) {
          // Each wallpaper carries the shadows of its own layout.
          graph.push(
            `[${await backdrop(next)}:v]fps=${FPS},setsar=1,trim=end_frame=${frames},${fade("in")}[bgnext]`,
          );
          over("bgnext", 0, 0);
        }
        const rounded = async (label, box) => {
          if (!(box.r > 0)) return label;
          const m = still(await art.mask(box));
          graph.push(
            `[${label}]format=rgba[${label}c]`,
            `[${m}:v]fps=${FPS},format=gray[${label}m]`,
            `[${label}c][${label}m]alphamerge[${label}r]`,
          );
          return `${label}r`;
        };
        const same = (a, b) =>
          ["x", "y", "w", "h", "r"].every((key) => a[key] === b[key]);
        // What happens to something that is in this layout, the next, or both.
        const change = (a, b) =>
          !next || (a && b && same(a, b))
            ? "stay"
            : a && b
              ? "glide"
              : a
                ? "out"
                : "in";
        // A picture already cut to its box: put there, or faded in or out there.
        const show = async (label, box, how) => {
          const cut = await rounded(label, box);
          if (how === "stay") return over(cut, box.x, box.y);
          graph.push(`[${cut}]${fade(how)}[${label}f]`);
          over(`${label}f`, box.x, box.y);
        };
        // A picture `wide` by `high` travels from one box to another, always
        // filling the box it is passing through. Its outline is drawn for the
        // whole frame, with corners that go from the first box's to the second's.
        const travel = async (label, wide, high, a, b) => {
          const corner = (box) => Math.min(box.r || 0, box.w / 2, box.h / 2),
            w = glide(a.w, b.w),
            h = glide(a.h, b.h),
            x = glide(a.x, b.x),
            y = glide(a.y, b.y),
            r = glide(corner(a), corner(b)),
            even = (n) => `max(2,2*trunc((${n})/2))`,
            sized = (width, height) =>
              `scale=w='${even(width)}':h='${even(height)}':eval=frame`,
            shape = (wide / high).toFixed(5);
          // A touch larger than its outline, so no edge of it ever shows.
          graph.push(
            `[${label}]${sized(`max(${w},${h}*${shape})+2`, `max(${h},${w}/${shape})+2`)}[${label}s]`,
            `${canvas}[${label}c]`,
            `[${label}c][${label}s]overlay=x='${x}+(${w}-overlay_w)/2':y='${y}+(${h}-overlay_h)/2':format=rgb[${label}p]`,
            `${canvas}[${label}o0]`,
          );
          // The outline is a cross of two bars with a disc in each corner.
          let outline = 0;
          const add = (part, left, top) => {
            graph.push(
              `[${label}o${outline}][${part}]overlay=x='${left}':y='${top}':format=rgb[${label}o${++outline}]`,
            );
          };
          const white = (name, size = 16) =>
            graph.push(
              `color=white:s=${size}x${size}:r=${FPS},format=rgb24,trim=end_frame=${frames}[${name}]`,
            );
          white(`${label}w0`);
          white(`${label}w1`);
          graph.push(
            `[${label}w0]${sized(w, `${h}-2*${r}`)}[${label}b0]`,
            `[${label}w1]${sized(`${w}-2*${r}`, h)}[${label}b1]`,
          );
          add(`${label}b0`, x, `${y}+${r}`);
          add(`${label}b1`, `${x}+${r}`, y);
          const widest = Math.ceil(Math.max(corner(a), corner(b))) * 2;
          if (widest > 0) {
            const disc = still(
              await art.mask({ w: widest, h: widest, r: widest / 2 }),
            );
            white(`${label}dw`, widest);
            graph.push(
              `[${disc}:v]fps=${FPS},format=gray[${label}dm]`,
              `[${label}dw][${label}dm]alphamerge,${sized(`2*${r}`, `2*${r}`)},split=4${[0, 1, 2, 3].map((i) => `[${label}d${i}]`).join("")}`,
            );
            for (const i of [0, 1, 2, 3])
              add(
                `${label}d${i}`,
                i % 2 ? `${x}+${w}-2*${r}` : x,
                i > 1 ? `${y}+${h}-2*${r}` : y,
              );
          }
          graph.push(
            `[${label}o${outline}]format=gray[${label}g]`,
            `[${label}p][${label}g]alphamerge[${label}r]`,
          );
          over(`${label}r`, 0, 0);
        };
        const screens = [plan.screen, next?.screen];
        if (screens[0] || screens[1]) {
          const how = change(...screens),
            // While it travels, the picture is made at the larger of its sizes.
            b =
              how === "glide" && screens[1].w > screens[0].w
                ? screens[1]
                : screens[0] || screens[1],
            pi = picture(primary),
            zoom = zoomFilter(zooms, b.w, b.h),
            // A zoom shows part of the picture enlarged, so until the zoom is
            // applied the picture keeps as much of its recorded size as the
            // deepest zoom can use. Shrinking it to its box first would throw
            // away the detail a zoom is there to show.
            deepest = Math.max(1, ...zooms.map((z) => z.scale)),
            k = Math.max(1, Math.min(deepest, recorded / b.w)),
            iw = Math.round((b.w * k) / 2) * 2,
            ih = Math.round((b.h * k) / 2) * 2;
          graph.push(
            `[${pi}:v]scale=${iw}:${ih}:flags=lanczos,setsar=1,${steady}[whole]`,
          );
          // Hidden before the picture is zoomed or moved, so that what is
          // hidden stays hidden wherever the picture goes.
          const covered = hide(graph, "whole", blurs, iw, ih);
          graph.push(`[${covered}]${zoom || "null"}[scr]`);
          if (how === "glide") await travel("scr", b.w, b.h, ...screens);
          else await show("scr", b, how);
        }
        // A camera bubble casts its own shadow, which comes and goes with it.
        for (const [p, how] of next
          ? [
              [plan, "out"],
              [next, "in"],
            ]
          : [[plan, "stay"]]) {
          if (!(p.camera && p.preset === "pip" && art.hasShadow)) continue;
          // A bubble on the move leaves its shadow behind until it has landed.
          if (next && plan.camera && next.camera) continue;
          const sh = still(await art.shadow(p.camera)),
            x = p.camera.x - art.margin,
            y = p.camera.y - art.margin + Math.round(art.margin / 5);
          if (how === "stay") over(`${sh}:v`, x, y);
          else {
            graph.push(`[${sh}:v]${fade(how)}[shadow${how}]`);
            over(`shadow${how}`, x, y);
          }
        }
        const cameras = [plan.camera, next?.camera];
        if (cameras[0] || cameras[1]) {
          const how = change(...cameras),
            ci = picture(cameraAsset);
          if (how === "glide") {
            const shot = await info(cameraAsset);
            graph.push(`[${ci}:v]setsar=1,${steady}[cam]`);
            await travel("cam", shot.width || 4, shot.height || 3, ...cameras);
          } else {
            const b = cameras[0] || cameras[1];
            graph.push(
              `[${ci}:v]scale=${b.w}:${b.h}:force_original_aspect_ratio=increase,crop=${b.w}:${b.h},setsar=1,${steady}[cam]`,
            );
            await show("cam", b, how);
          }
        }
        graph.push(`[${last}]format=yuv420p[video]`);
      }
      if (samples) {
        const audio = [],
          exact = `apad,atrim=end_sample=${samples}`;
        if (byRole.microphone && l.audio.microphone > 0)
          audio.push({
            index: audible(byRole.microphone),
            gain: l.audio.microphone,
          });
        if (byRole.system && l.audio.system > 0)
          audio.push({ index: audible(byRole.system), gain: l.audio.system });
        if (
          !audio.length &&
          (await info(primary)).hasAudio &&
          l.audio.microphone > 0
        )
          audio.push({ index: audible(primary), gain: l.audio.microphone });
        if (audio.length) {
          audio.forEach((a, i) =>
            graph.push(
              `[${a.index}:a]asetpts=PTS-STARTPTS,aresample=${RATE},volume=${a.gain}${l.audio.denoise ? ",afftdn=nf=-25" : ""},${exact}[a${i}]`,
            ),
          );
          graph.push(
            `${audio.map((_, i) => `[a${i}]`).join("")}amix=inputs=${audio.length}:normalize=0,aresample=${RATE},${exact}[audio]`,
          );
        } else
          graph.push(
            `anullsrc=r=${RATE}:cl=stereo,atrim=end_sample=${samples}[audio]`,
          );
      }
      args.push("-filter_complex", graph.join(";"));
      if (frames)
        args.push(
          "-map",
          "[video]",
          "-frames:v",
          String(frames),
          ...encode(crf),
          out,
        );
      if (samples)
        args.push("-map", "[audio]", "-c:a", "pcm_s16le", ...pcm, sound);
      await exec(args);
    }
    // Loudness is measured once over the finished soundtrack and corrected in
    // one go, so a short section is treated like the ones around it.
    async function loudness() {
      const target = "loudnorm=I=-16:TP=-1.5:LRA=11",
        { stderr } = await engine(
          [
            ...pcm,
            "-i",
            soundtrack,
            "-af",
            `aformat=channel_layouts=stereo,${target}:print_format=json`,
            "-f",
            "null",
            "-",
          ],
          { log: "info" },
        ),
        found = parseJSON(stderr.match(/\{[^{}]*\}/g)?.at(-1), {}),
        measured = [
          ["measured_I", "input_i", -99, 0],
          ["measured_TP", "input_tp", -99, 99],
          ["measured_LRA", "input_lra", 0, 99],
          ["measured_thresh", "input_thresh", -99, 0],
          ["offset", "target_offset", -99, 99],
        ].map(([name, key, min, max]) => [
          name,
          Math.min(max, Math.max(min, Number(found[key]))),
        ]);
      // Silence has no loudness to correct.
      if (!measured.every(([, value]) => Number.isFinite(value))) return [];
      return [
        `${target}:${measured.map((m) => m.join("=")).join(":")}`,
        `aresample=${RATE}`,
      ];
    }
    try {
      const parts = [],
        // Blurs that are not over a screen picture, and when each is shown.
        fixed = new Map();
      let offset = 0;
      for (let n = 0; n < project.segments.length; n++) {
        const s = project.segments[n],
          source = find(s.sourceId),
          assets = assetsFor(source),
          byRole = Object.fromEntries(assets.map((a) => [a.role, a]));
        const primary = byRole.screen || byRole.primary || byRole.camera;
        if (!primary) throw problem(400, "A source recording is missing.");
        // Sections are cut to whole frames and whole samples of the finished
        // video, measured from its start, so rounding never adds up from one
        // section to the next and everything timed stays where it was put.
        const end = offset + s.end - s.start,
          first = Math.round(offset * FPS),
          frames = Math.round(end * FPS) - first,
          samples = Math.round(end * RATE) - Math.round(offset * RATE),
          at = first / FPS,
          d = frames / FPS,
          shape = await info(primary),
          aspect = (shape.width || 16) / (shape.height || 9),
          target = path.join(temp, `segment-${n}.mp4`),
          // The first section starts the soundtrack; the rest are added to it.
          sound = n ? path.join(temp, `segment-${n}.pcm`) : soundtrack;
        // Zooms act on the screen layer only, so the camera stays put.
        const zoomsFor = (local, length) =>
          (project.overlays || [])
            .filter((o) => o.type === "zoom")
            .map((o) => ({
              ...o,
              start: o.start - at - local,
              end: o.end - at - local,
            }))
            .filter((o) => o.end > 0 && o.start < length);
        // A blur over the screen picture belongs to the picture: it is put on
        // before the picture is zoomed or moved to another layout. Where it sits
        // is read in the video's own layout, without any zoom.
        const resting = planLayout(
          l,
          l.preset || "pip",
          aspect,
          Boolean(byRole.screen && byRole.camera),
        );
        const hidden = (project.overlays || [])
          .filter((o) => o.type === "blur" && o.end > at && o.start < end)
          .map((o) => ({ o, on: onScreen(o, resting.screen, W, H) }));
        const blursFor = (local, length) =>
          hidden
            .filter((b) => b.on)
            .map((b) => ({
              ...b.on,
              start: b.o.start - at - local,
              end: b.o.end - at - local,
            }))
            .filter((b) => b.end > 0 && b.start < length);
        // The rest stay where they are in the frame for this section.
        for (const b of hidden)
          if (!b.on)
            fixed.set(b.o, [
              ...(fixed.get(b.o) || []),
              [Math.max(b.o.start, at), Math.min(b.o.end, end)],
            ]);
        const pieces = frames
          ? layoutPieces(project.scenes || [], at, d, l.preset || "pip")
          : [];
        const common = {
          byRole,
          primary,
          aspect,
          recorded: shape.width || 0,
          from: s.start,
        };
        if (pieces.length < 2) {
          await piece({
            ...common,
            frames,
            samples,
            zooms: zoomsFor(0, d),
            blurs: blursFor(0, d),
            preset: pieces[0]?.preset,
            out: target,
            sound,
          });
          if (frames) parts.push(target);
        } else {
          // Each layout runs up to the next change. The change is a short
          // stretch of its own, in which the screen and camera glide to their
          // new places. Stretches are counted in whole frames of the section.
          const change = Math.min(
            0.45,
            ...pieces.map((p) => (p.end - p.start) / 2),
          );
          let done = 0;
          const stretch = async (until, preset, towards) => {
            const count = Math.min(frames, Math.round(until * FPS)) - done;
            if (count <= 0) return;
            const local = done / FPS,
              file = path.join(temp, `segment-${n}-${done}.mp4`);
            await piece({
              ...common,
              from: s.start + local,
              frames: count,
              zooms: zoomsFor(local, count / FPS),
              blurs: blursFor(local, count / FPS),
              preset,
              towards,
              out: file,
            });
            parts.push(file);
            done += count;
          };
          for (let i = 0; i < pieces.length; i++) {
            if (i)
              await stretch(
                pieces[i].start + change,
                pieces[i - 1].preset,
                pieces[i].preset,
              );
            await stretch(
              i < pieces.length - 1 ? pieces[i + 1].start : d,
              pieces[i].preset,
            );
          }
          await piece({ ...common, samples, sound });
        }
        if (samples && n) {
          await pipeline(
            createReadStream(sound),
            createWriteStream(soundtrack, { flags: "a" }),
          );
          rmSync(sound);
        }
        offset = end;
        progress(5 + ((n + 1) / project.segments.length) * 65);
      }
      const list = path.join(temp, "concat.txt");
      writeFileSync(
        list,
        parts.map((p) => `file '${p.replaceAll("'", "'\\''")}'`).join("\n"),
      );
      const combined = path.join(temp, "joined.mp4");
      await exec([
        "-f",
        "concat",
        "-safe",
        "0",
        "-i",
        list,
        "-c",
        "copy",
        combined,
      ]);
      const effects = project.overlays || [];
      const vf = [];
      let previous = "0:v",
        counter = 0;
      const next = () => `v${counter++}`;
      const font = path.resolve(
        fontsDir,
        "rP2tp2ywxg089UriI5-g4vlH9VoD8CmcqZG40F9JadbnoEwARZthTg.ttf",
      );
      // Text, cursors, titles and captions are drawn by libass from styled subtitle
      // files, so that characters the bundled fonts lack fall back to a system font.
      const subtitles = (ass) => {
        if (!ass) return;
        const file = path.join(temp, `titles-${counter}.ass`),
          target = next();
        writeFileSync(file, ass);
        vf.push(
          `[${previous}]subtitles=filename='${filterPath(file)}':fontsdir='${filterPath(fontsDir)}'[${target}]`,
        );
        previous = target;
      };
      // Text and cursors waiting to be drawn: all at once, unless something that
      // comes later is on screen with them and has to be drawn over them.
      let texts = [];
      const drawTexts = () => {
        subtitles(
          buildTextASS({ width: W, height: H, overlays: texts, fps: FPS }),
        );
        texts = [];
      };
      for (const effect of effects) {
        if (effect.type === "zoom" || TITLE_TYPES.includes(effect.type))
          continue;
        if (effect.type === "text" || effect.type === "cursor") {
          texts.push(effect);
          continue;
        }
        // Most blurs were put on the screen picture as it was rendered.
        if (effect.type === "blur" && !fixed.has(effect)) continue;
        if (texts.some((t) => t.start <= effect.end && effect.start <= t.end))
          drawTexts();
        const x = Math.round(effect.x * W),
          y = Math.round(effect.y * H),
          w = Math.max(4, Math.min(W - x, Math.round(effect.w * W))),
          h = Math.max(4, Math.min(H - y, Math.round(effect.h * H))),
          enable = `between(t,${effect.start},${effect.end})`;
        if (effect.type === "blur") {
          for (const [from, to] of fixed.get(effect)) {
            const target = next();
            vf.push(
              `[${previous}]split[base${counter}][blur${counter}]`,
              `[blur${counter}]crop=${w}:${h}:${x}:${y},${blurOf(w, h, W)}[blurred${counter}]`,
              `[base${counter}][blurred${counter}]overlay=${x}:${y}:enable='between(t,${from.toFixed(3)},${to.toFixed(3)})'[${target}]`,
            );
            previous = target;
          }
          continue;
        }
        const target = next();
        if (effect.type === "box")
          vf.push(
            `[${previous}]drawbox=x=${x}:y=${y}:w=${w}:h=${h}:color=${effect.color.replace("#", "0x")}@0.8:t=4:enable='${enable}'[${target}]`,
          );
        else {
          // An arrow: a single character, which the bundled font has.
          const text = path.join(temp, `text-${counter}.txt`);
          writeFileSync(text, effect.text || "→");
          vf.push(
            `[${previous}]drawtext=fontfile='${filterPath(font)}':textfile='${filterPath(text)}':expansion=none:fontsize=${Math.round(H * 0.12)}:fontcolor=${effect.color.replace("#", "0x")}:x=${x}:y=${y}:enable='${enable}'[${target}]`,
          );
        }
        previous = target;
      }
      drawTexts();
      // Captions and titles are drawn together, over everything else.
      subtitles(
        buildASS({
          width: W,
          height: H,
          words: l.captions ? outputWords(project, find) : [],
          captionStyle: l.captions ? l.captionStyle || "clean" : null,
          overlays: effects,
        }),
      );
      progress(75);
      await exec([
        "-i",
        combined,
        ...pcm,
        "-i",
        soundtrack,
        ...(vf.length
          ? ["-filter_complex", vf.join(";"), "-map", `[${previous}]`]
          : ["-map", "0:v:0"]),
        "-map",
        "1:a:0",
        ...(vf.length ? encode(21) : ["-c:v", "copy"]),
        "-af",
        [
          "aformat=channel_layouts=stereo",
          ...(l.audio.normalize ? await loudness() : []),
        ].join(","),
        "-c:a",
        "aac",
        "-ar",
        String(RATE),
        "-ac",
        "2",
        "-movflags",
        "+faststart",
        destination,
      ]);
      let thumbnail = video.thumbnail;
      try {
        const { stdout } = await run(
          ffmpeg,
          [
            "-hide_banner",
            "-loglevel",
            "error",
            "-ss",
            "0.1",
            "-i",
            destination,
            "-frames:v",
            "1",
            "-vf",
            // Fill the 16:9 card rather than letterboxing it.
            "scale=640:360:force_original_aspect_ratio=increase,crop=640:360",
            "-f",
            "image2pipe",
            "-vcodec",
            "mjpeg",
            "pipe:1",
          ],
          { encoding: "buffer", maxBuffer: 4 * 1024 * 1024 },
        );
        thumbnail = `data:image/jpeg;base64,${stdout.toString("base64")}`;
      } catch {}
      progress(99);
      return {
        // The sound is exactly this long, and the picture within half a frame of it.
        duration: offset,
        size: statSync(destination).size,
        thumbnail,
      };
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  }
  return { render, assetsFor, info };
}
