import { zoomFilter } from "./autozoom.mjs";
import { createArtwork, planLayout } from "./compose.mjs";
import { buildASS, TITLE_TYPES } from "./titles.mjs";

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
import { existsSync as exists } from "node:fs";
import { fileURLToPath } from "node:url";
// Fonts ship in public/ from source and in dist/ in production images.
const appRoot = fileURLToPath(new URL("../..", import.meta.url));
const fontsDir =
  ["public/fonts", "dist/fonts"]
    .map((p) => path.join(appRoot, p))
    .find((p) => exists(p)) || path.join(appRoot, "public/fonts");
import ffmpeg from "../ffmpeg.mjs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  rmSync,
  existsSync,
  statSync,
} from "node:fs";
import path from "node:path";
import { parseJSON, problem } from "./schema.mjs";
import { captions, outputWords } from "./project.mjs";
const run = promisify(execFile);
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
export function createRenderer({ db, dataDir, find }) {
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
    const exec = (args) =>
      run(ffmpeg, args, { timeout: 1800000, maxBuffer: 2 * 1024 * 1024 });
    // Renders one stretch of a section in a single layout.
    async function piece({
      byRole,
      primary,
      aspect,
      from,
      d,
      zooms,
      preset,
      withVideo = true,
      withAudio = true,
      crf = 21,
      out,
    }) {
      const args = ["-hide_banner", "-loglevel", "error", "-nostdin", "-y"];
      let index = 0;
      const input = (asset) => {
        args.push(
          "-ss",
          String(from),
          "-t",
          String(d),
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
          "30",
          "-t",
          String(d),
          "-i",
          file,
        );
        return index++;
      };
      const graph = [];
      const maps = [];
      const cameraAsset = byRole.screen && byRole.camera ? byRole.camera : null;
      if (withVideo) {
        const plan = planLayout(l, preset, aspect, Boolean(cameraAsset));
        const onBackground = [
          plan.screen,
          plan.preset === "pip" ? null : plan.camera,
        ].filter(Boolean);
        const bg = still(
          await art.background(
            `${plan.preset}:${aspect.toFixed(4)}`,
            onBackground,
          ),
        );
        graph.push(
          `[${bg}:v]fps=30,format=rgb24,setsar=1,trim=duration=${d}[bg]`,
        );
        let last = "bg";
        const rounded = async (label, box) => {
          if (!(box.r > 0)) return label;
          const m = still(await art.mask(box));
          graph.push(
            `[${label}]format=rgba[${label}c]`,
            `[${m}:v]fps=30,format=gray[${label}m]`,
            `[${label}c][${label}m]alphamerge[${label}r]`,
          );
          return `${label}r`;
        };
        if (plan.screen) {
          const b = plan.screen,
            pi = input(primary),
            zoom = zoomFilter(zooms, b.w, b.h);
          graph.push(
            `[${pi}:v]setpts=PTS-STARTPTS,scale=${b.w}:${b.h},setsar=1,fps=30,tpad=stop_mode=clone:stop_duration=${d},trim=duration=${d}${zoom ? `,${zoom}` : ""}[scr]`,
          );
          const label = await rounded("scr", b);
          graph.push(
            `[${last}][${label}]overlay=${b.x}:${b.y}:shortest=1[withscreen]`,
          );
          last = "withscreen";
        }
        if (plan.camera) {
          const b = plan.camera,
            ci = input(cameraAsset);
          if (plan.preset === "pip" && art.hasShadow) {
            const sh = still(await art.shadow(b));
            graph.push(
              `[${last}][${sh}:v]overlay=${b.x - art.margin}:${b.y - art.margin + Math.round(art.margin / 5)}:shortest=1[withshadow]`,
            );
            last = "withshadow";
          }
          graph.push(
            `[${ci}:v]setpts=PTS-STARTPTS,scale=${b.w}:${b.h}:force_original_aspect_ratio=increase,crop=${b.w}:${b.h},setsar=1,fps=30,tpad=stop_mode=clone:stop_duration=${d},trim=duration=${d}[cam]`,
          );
          const label = await rounded("cam", b);
          graph.push(
            `[${last}][${label}]overlay=${b.x}:${b.y}:shortest=1[withcamera]`,
          );
          last = "withcamera";
        }
        graph.push(`[${last}]format=yuv420p[video]`);
        maps.push("-map", "[video]");
      }
      if (withAudio) {
        const audio = [];
        if (byRole.microphone && l.audio.microphone > 0)
          audio.push({
            index: input(byRole.microphone),
            gain: l.audio.microphone,
          });
        if (byRole.system && l.audio.system > 0)
          audio.push({ index: input(byRole.system), gain: l.audio.system });
        if (
          !audio.length &&
          (await info(primary)).hasAudio &&
          l.audio.microphone > 0
        )
          audio.push({ index: input(primary), gain: l.audio.microphone });
        if (audio.length) {
          audio.forEach((a, i) =>
            graph.push(
              `[${a.index}:a]asetpts=PTS-STARTPTS,aresample=48000,volume=${a.gain}${l.audio.denoise ? ",afftdn=nf=-25" : ""},apad,atrim=duration=${d}[a${i}]`,
            ),
          );
          graph.push(
            `${audio.map((_, i) => `[a${i}]`).join("")}amix=inputs=${audio.length}:normalize=0${l.audio.normalize ? ",loudnorm=I=-16:TP=-1.5:LRA=11" : ""},aresample=48000,apad,atrim=duration=${d}[audio]`,
          );
        } else
          graph.push(`anullsrc=r=48000:cl=stereo,atrim=duration=${d}[audio]`);
        maps.push("-map", "[audio]");
      }
      args.push("-filter_complex", graph.join(";"), ...maps, "-t", String(d));
      if (withVideo) args.push(...encode(crf));
      if (withAudio) args.push("-c:a", "aac", "-ar", "48000", "-ac", "2");
      args.push(out);
      await exec(args);
      return out;
    }
    try {
      const parts = [];
      let offset = 0;
      for (let n = 0; n < project.segments.length; n++) {
        const s = project.segments[n],
          source = find(s.sourceId),
          assets = assetsFor(source),
          byRole = Object.fromEntries(assets.map((a) => [a.role, a]));
        const primary = byRole.screen || byRole.primary || byRole.camera;
        if (!primary) throw problem(400, "A source recording is missing.");
        const d = s.end - s.start,
          shape = await info(primary),
          aspect = (shape.width || 16) / (shape.height || 9),
          target = path.join(temp, `segment-${n}.mp4`);
        // Zooms act on the screen layer only, so the camera stays put.
        const zoomsFor = (local, length) =>
          (project.overlays || [])
            .filter((o) => o.type === "zoom")
            .map((o) => ({
              ...o,
              start: o.start - offset - local,
              end: o.end - offset - local,
            }))
            .filter((o) => o.end > 0 && o.start < length);
        const pieces = layoutPieces(
          project.scenes || [],
          offset,
          d,
          l.preset || "pip",
        );
        const common = { byRole, primary, aspect };
        if (pieces.length === 1)
          await piece({
            ...common,
            from: s.start,
            d,
            zooms: zoomsFor(0, d),
            preset: pieces[0].preset,
            out: target,
          });
        else {
          // Each layout overlaps the next briefly, then they are blended, so the
          // picture glides from one arrangement to the other.
          const blend = Math.min(
            0.45,
            ...pieces.map((p) => (p.end - p.start) / 2),
          );
          const files = [];
          for (let i = 0; i < pieces.length; i++) {
            const p = pieces[i],
              length = p.end - p.start + (i < pieces.length - 1 ? blend : 0);
            files.push(
              await piece({
                ...common,
                from: s.start + p.start,
                d: length,
                zooms: zoomsFor(p.start, length),
                preset: p.preset,
                withAudio: false,
                crf: 16,
                out: path.join(temp, `segment-${n}-${i}.mp4`),
              }),
            );
          }
          const sound = await piece({
            ...common,
            from: s.start,
            d,
            withVideo: false,
            out: path.join(temp, `segment-${n}.m4a`),
          });
          const args = ["-hide_banner", "-loglevel", "error", "-nostdin", "-y"];
          for (const f of files) args.push("-i", f);
          args.push("-i", sound);
          const graph = files.map((_, i) => `[${i}:v]settb=AVTB,fps=30[p${i}]`);
          let last = "p0";
          for (let i = 1; i < files.length; i++) {
            graph.push(
              `[${last}][p${i}]xfade=transition=fade:duration=${blend.toFixed(3)}:offset=${pieces[i].start.toFixed(3)}[x${i}]`,
            );
            last = `x${i}`;
          }
          args.push(
            "-filter_complex",
            graph.join(";"),
            "-map",
            `[${last}]`,
            "-map",
            `${files.length}:a`,
            "-t",
            String(d),
            ...encode(21),
            "-c:a",
            "copy",
            target,
          );
          await exec(args);
        }
        offset += d;
        parts.push(target);
        progress(5 + ((n + 1) / project.segments.length) * 65);
      }
      const list = path.join(temp, "concat.txt");
      writeFileSync(
        list,
        parts.map((p) => `file '${p.replaceAll("'", "'\\''")}'`).join("\n"),
      );
      const combined = path.join(temp, "joined.mp4");
      await run(
        ffmpeg,
        [
          "-hide_banner",
          "-loglevel",
          "error",
          "-nostdin",
          "-y",
          "-f",
          "concat",
          "-safe",
          "0",
          "-i",
          list,
          "-c",
          "copy",
          "-movflags",
          "+faststart",
          combined,
        ],
        { timeout: 600000, maxBuffer: 1024 * 1024 },
      );
      const effects = project.overlays || [];
      const vf = [];
      let previous = "0:v",
        counter = 0;
      const next = () => `v${counter++}`;
      const font = path.resolve(
        fontsDir,
        "rP2tp2ywxg089UriI5-g4vlH9VoD8CmcqZG40F9JadbnoEwARZthTg.ttf",
      );
      for (const effect of effects) {
        if (effect.type === "zoom" || TITLE_TYPES.includes(effect.type))
          continue;
        const target = next(),
          x = Math.round(effect.x * W),
          y = Math.round(effect.y * H),
          w = Math.max(4, Math.min(W - x, Math.round(effect.w * W))),
          h = Math.max(4, Math.min(H - y, Math.round(effect.h * H))),
          enable = `between(t,${effect.start},${effect.end})`;
        if (effect.type === "blur") {
          vf.push(
            `[${previous}]split[base${counter}][blur${counter}]`,
            `[blur${counter}]crop=${w}:${h}:${x}:${y},boxblur=lr=${Math.max(1, Math.min(16, Math.floor(Math.min(w, h) / 4)))}:lp=2:cr=${Math.max(1, Math.min(8, Math.floor(Math.min(w, h) / 8)))}:cp=2[blurred${counter}]`,
            `[base${counter}][blurred${counter}]overlay=${x}:${y}:enable='${enable}'[${target}]`,
          );
        } else if (effect.type === "box")
          vf.push(
            `[${previous}]drawbox=x=${x}:y=${y}:w=${w}:h=${h}:color=${effect.color.replace("#", "0x")}@0.8:t=4:enable='${enable}'[${target}]`,
          );
        else {
          const text = path.join(temp, `text-${counter}.txt`);
          writeFileSync(
            text,
            effect.type === "arrow"
              ? "→"
              : effect.type === "cursor"
                ? "●"
                : effect.text,
          );
          vf.push(
            `[${previous}]drawtext=fontfile='${filterPath(font)}':textfile='${filterPath(text)}':expansion=none:fontsize=${effect.type === "arrow" ? Math.round(H * 0.12) : effect.type === "cursor" ? 40 : Math.max(18, Math.round(H * 0.045))}:fontcolor=${effect.color.replace("#", "0x")}:x=${x}:y=${y}:box=${effect.type === "text" ? 1 : 0}:boxcolor=black@0.55:boxborderw=10:enable='${enable}'[${target}]`,
          );
        }
        previous = target;
      }
      // Captions and titles are drawn together from one styled subtitle file.
      const ass = buildASS({
        width: W,
        height: H,
        words: l.captions ? outputWords(project, find) : [],
        captionStyle: l.captions ? l.captionStyle || "clean" : null,
        overlays: effects,
      });
      if (ass) {
        const file = path.join(temp, "titles.ass");
        writeFileSync(file, ass);
        const target = next();
        vf.push(
          `[${previous}]subtitles=filename='${filterPath(file)}':fontsdir='${filterPath(fontsDir)}'[${target}]`,
        );
        previous = target;
      }
      if (vf.length) {
        const script = path.join(temp, "effects.filter");
        writeFileSync(script, vf.join(";"));
        await run(
          ffmpeg,
          [
            "-hide_banner",
            "-loglevel",
            "error",
            "-nostdin",
            "-y",
            "-i",
            combined,
            "-filter_complex",
            readFileSync(script, "utf8"),
            "-map",
            `[${previous}]`,
            "-map",
            "0:a:0",
            "-c:v",
            "libx264",
            "-preset",
            "veryfast",
            "-crf",
            "21",
            "-pix_fmt",
            "yuv420p",
            "-c:a",
            "copy",
            "-threads",
            "2",
            "-movflags",
            "+faststart",
            destination,
          ],
          { timeout: 1800000, maxBuffer: 2 * 1024 * 1024 },
        );
      } else
        await run(
          ffmpeg,
          [
            "-hide_banner",
            "-loglevel",
            "error",
            "-nostdin",
            "-y",
            "-i",
            combined,
            "-c",
            "copy",
            "-movflags",
            "+faststart",
            destination,
          ],
          { timeout: 600000, maxBuffer: 1024 * 1024 },
        );
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
        duration: project.segments.reduce((n, s) => n + s.end - s.start, 0),
        size: statSync(destination).size,
        thumbnail,
      };
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  }
  return { render, assetsFor, info };
}
