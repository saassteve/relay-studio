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
      H = l.height,
      pad = Math.round(l.padding / 2) * 2,
      innerW = W - pad * 2,
      innerH = H - pad * 2,
      color = l.background.replace("#", "0x");
    try {
      const parts = [];
      for (let n = 0; n < project.segments.length; n++) {
        const s = project.segments[n],
          source = find(s.sourceId),
          assets = assetsFor(source),
          byRole = Object.fromEntries(assets.map((a) => [a.role, a]));
        const primary = byRole.screen || byRole.primary || byRole.camera;
        if (!primary) throw problem(400, "A source recording is missing.");
        const d = s.end - s.start,
          args = ["-hide_banner", "-loglevel", "error", "-nostdin", "-y"];
        let index = 0;
        const inputs = [];
        const input = (asset, role) => {
          args.push(
            "-ss",
            String(s.start),
            "-t",
            String(d),
            "-i",
            media(asset.filename),
          );
          const item = { index: index++, asset, role };
          inputs.push(item);
          return item.index;
        };
        const pi = input(primary, "primary");
        const camera =
          byRole.screen && byRole.camera && l.camera.visible
            ? input(byRole.camera, "camera")
            : null;
        const audio = [];
        if (byRole.microphone && l.audio.microphone > 0)
          audio.push({
            index: input(byRole.microphone, "microphone"),
            gain: l.audio.microphone,
          });
        if (byRole.system && l.audio.system > 0)
          audio.push({
            index: input(byRole.system, "system"),
            gain: l.audio.system,
          });
        if (
          !audio.length &&
          (await info(primary)).hasAudio &&
          l.audio.microphone > 0
        )
          audio.push({ index: pi, gain: l.audio.microphone });
        let filter = `[${pi}:v]setpts=PTS-STARTPTS,scale=${innerW}:${innerH}:force_original_aspect_ratio=decrease,pad=${innerW}:${innerH}:(ow-iw)/2:(oh-ih)/2:color=${color},setsar=1,fps=30,tpad=stop_mode=clone:stop_duration=${d},trim=duration=${d}[screen];color=c=${color}:s=${W}x${H}:r=30:d=${d}[background];[background][screen]overlay=${pad}:${pad}:shortest=1[base]`;
        let visual = "base";
        if (camera !== null) {
          const cw = Math.max(32, Math.round((W * l.camera.size) / 2) * 2),
            ch =
              l.camera.shape === "portrait"
                ? Math.round((cw * 1.35) / 2) * 2
                : cw,
            x = Math.min(W - cw, Math.max(0, Math.round(W * l.camera.x))),
            y = Math.min(H - ch, Math.max(0, Math.round(H * l.camera.y)));
          filter += `;[${camera}:v]setpts=PTS-STARTPTS,scale=${cw}:${ch}:force_original_aspect_ratio=increase,crop=${cw}:${ch},tpad=stop_mode=clone:stop_duration=${d},trim=duration=${d},format=rgba`;
          if (l.camera.shape === "circle")
            filter += `,geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='if(lte(pow(X-W/2,2)+pow(Y-H/2,2),pow(W/2,2)),255,0)'`;
          filter += `[camera];[base][camera]overlay=${x}:${y}:shortest=1[composite]`;
          visual = "composite";
        }
        if (audio.length) {
          audio.forEach((a, i) => {
            filter += `;[${a.index}:a]asetpts=PTS-STARTPTS,aresample=48000,volume=${a.gain}${l.audio.denoise ? ",afftdn=nf=-25" : ""},apad,atrim=duration=${d}[a${i}]`;
          });
          filter += `;${audio.map((_, i) => `[a${i}]`).join("")}amix=inputs=${audio.length}:normalize=0${l.audio.normalize ? ",loudnorm=I=-16:TP=-1.5:LRA=11" : ""},aresample=48000,apad,atrim=duration=${d}[audio]`;
        } else
          filter += `;anullsrc=r=48000:cl=stereo,atrim=duration=${d}[audio]`;
        const script = path.join(temp, `segment-${n}.filter`);
        writeFileSync(script, filter);
        const target = path.join(temp, `segment-${n}.mp4`);
        args.push(
          "-filter_complex",
          readFileSync(script,'utf8'),
          "-map",
          `[${visual}]`,
          "-map",
          "[audio]",
          "-t",
          String(d),
          "-c:v",
          "libx264",
          "-preset",
          "veryfast",
          "-crf",
          "21",
          "-pix_fmt",
          "yuv420p",
          "-c:a",
          "aac",
          "-ar",
          "48000",
          "-ac",
          "2",
          "-threads",
          "2",
          target,
        );
        await run(ffmpeg, args, {
          timeout: 1800000,
          maxBuffer: 2 * 1024 * 1024,
        });
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
        "public/fonts/rP2tp2ywxg089UriI5-g4vlH9VoD8CmcqZG40F9JadbnoEwARZthTg.ttf",
      );
      for (const effect of effects) {
        const target = next(),
          x = Math.round(effect.x * W),
          y = Math.round(effect.y * H),
          w = Math.max(4, Math.min(W - x, Math.round(effect.w * W))),
          h = Math.max(4, Math.min(H - y, Math.round(effect.h * H))),
          enable = `between(t,${effect.start},${effect.end})`;
        if (effect.type === "blur") {
          vf.push(
            `[${previous}]split[base${counter}][blur${counter}]`,
            `[blur${counter}]crop=${w}:${h}:${x}:${y},boxblur=lr=${Math.max(1,Math.min(16,Math.floor(Math.min(w,h)/4)))}:lp=2:cr=${Math.max(1,Math.min(8,Math.floor(Math.min(w,h)/8)))}:cp=2[blurred${counter}]`,
            `[base${counter}][blurred${counter}]overlay=${x}:${y}:enable='${enable}'[${target}]`,
          );
        } else if (effect.type === "zoom") {
          const zw = Math.round(W / effect.scale / 2) * 2,
            zh = Math.round(H / effect.scale / 2) * 2,
            zx = Math.min(W - zw, Math.max(0, x - zw / 2)),
            zy = Math.min(H - zh, Math.max(0, y - zh / 2));
          vf.push(
            `[${previous}]split[base${counter}][zoom${counter}]`,
            `[zoom${counter}]crop=${zw}:${zh}:${zx}:${zy},scale=${W}:${H}[zoomed${counter}]`,
            `[base${counter}][zoomed${counter}]overlay=0:0:enable='${enable}'[${target}]`,
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
      if (l.captions) {
        const words = outputWords(project, find);
        if (words.length) {
          const file = path.join(temp, "captions.srt");
          writeFileSync(file, captions(words, "srt"));
          const target = next();
          vf.push(
            `[${previous}]subtitles=filename='${filterPath(file)}':fontsdir='${filterPath(path.resolve("public/fonts"))}':force_style='FontName=DM Sans,FontSize=22,Outline=2,MarginV=30'[${target}]`,
          );
          previous = target;
        }
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
            readFileSync(script,'utf8'),
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
            "scale=640:360:force_original_aspect_ratio=decrease,pad=640:360:(ow-iw)/2:(oh-ih)/2",
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
