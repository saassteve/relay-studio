import { fileURLToPath } from "node:url";
import ffmpeg from "../ffmpeg.mjs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeFileSync, rmSync, mkdtempSync, existsSync } from "node:fs";
import path from "node:path";
import { parseJSON, problem } from "./schema.mjs";
import { getProject, outputWords } from "./project.mjs";
const run = promisify(execFile);
export function createTranscription({ db, dataDir, find, renderer }) {
  const models = [
    "Xenova/whisper-tiny.en",
    "Xenova/whisper-tiny",
    "Xenova/whisper-base.en",
  ];
  // The bundled ONNX runtime has no Intel Mac build.
  const supported = !(process.platform === "darwin" && process.arch === "x64");
  const unsupported = () =>
    problem(
      501,
      "On-device transcription needs an Apple Silicon Mac. You can import captions (SRT or VTT) instead.",
    );
  const modelReady = (model) =>
    existsSync(path.join(dataDir, "models", model, "config.json")) &&
    existsSync(path.join(dataDir, "models", model, "onnx"));
  async function prepare({ model = "Xenova/whisper-tiny.en" }, progress) {
    if (!supported) throw unsupported();
    if (!models.includes(model))
      throw problem(400, "Choose a supported local transcription model.");
    progress(5);
    await worker(["-", path.join(dataDir, "models"), model, "prepare"], (n) =>
      progress(Math.min(99, n)),
    );
    return { model, ready: true };
  }
  async function transcribe(
    { videoId, model = "Xenova/whisper-tiny.en" },
    progress,
  ) {
    if (!models.includes(model))
      throw problem(400, "Choose a supported local transcription model.");
    if (!supported) throw unsupported();
    const v = find(videoId),
      assets = renderer.assetsFor(v),
      source =
        assets.find((a) => a.role === "microphone") ||
        assets.find((a) => a.role === "primary") ||
        assets.find((a) => a.role === "screen") ||
        assets[0];
    if (!(await renderer.info(source)).hasAudio)
      throw problem(400, "This recording has no audio track to transcribe.");
    const dir = mkdtempSync(path.join(dataDir, "tmp", "asr-")),
      audio = path.join(dir, "audio.f32");
    try {
      progress(5);
      await run(
        ffmpeg,
        [
          "-hide_banner",
          "-loglevel",
          "error",
          "-nostdin",
          "-i",
          path.join(dataDir, "media", source.filename),
          "-vn",
          "-ac",
          "1",
          "-ar",
          "16000",
          "-f",
          "f32le",
          audio,
        ],
        { timeout: 600000, maxBuffer: 1024 * 1024 },
      );
      progress(15);
      const result = await worker(
        [audio, path.join(dataDir, "models"), model],
        progress,
      );
      const chunks = (result.chunks || [])
        .map((c) => ({
          text: String(c.text).trim(),
          start: Math.max(0, Number(c.timestamp?.[0]) || 0),
          end: Math.min(
            source.duration,
            Number(c.timestamp?.[1]) || source.duration,
          ),
          granularity: "word",
        }))
        .filter((w) => w.text && w.end > w.start);
      db.prepare("UPDATE videos SET transcript=? WHERE id=?").run(
        JSON.stringify(chunks),
        v.id,
      );
      return { videoId: v.id, words: chunks, text: result.text, model };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  async function worker(args, progress) {
    const child = execFile(
      process.execPath,
      [fileURLToPath(new URL("./asr-worker.mjs", import.meta.url)), ...args],
      {
        env: {
          ...process.env,
          ELECTRON_RUN_AS_NODE: process.env.ELECTRON_RUN_AS_NODE || "",
        },
        timeout: 1800000,
        maxBuffer: 20 * 1024 * 1024,
      },
    );
    child.stderr.on("data", (data) => {
      const matches = String(data).matchAll(/RELAY_PROGRESS:(\d+)/g);
      for (const m of matches) progress(15 + Number(m[1]) * 0.65);
    });
    return await new Promise((resolve, reject) => {
      let output = "",
        error = "";
      child.stdout.on("data", (d) => (output += d));
      child.stderr.on("data", (d) => (error += d));
      child.on("error", reject);
      child.on("close", (code) => {
        if (code !== 0)
          return reject(
            problem(
              503,
              `Local AI could not run: ${error
                .split("\n")
                .filter((l) => !l.startsWith("RELAY_PROGRESS"))
                .slice(-8)
                .join(" ")
                .slice(0, 500)}`,
            ),
          );
        try {
          resolve(JSON.parse(output));
        } catch {
          reject(problem(500, "The local AI returned an unreadable result."));
        }
      });
    });
  }
  async function summarize(
    { videoId, provider = "local", consent = false },
    progress,
  ) {
    const v = find(videoId),
      words = outputWords(getProject(v), find);
    if (!words.length) throw problem(400, "Transcribe this recording first.");
    const text = words.map((w) => w.text).join(" ");
    let summary;
    if (provider === "local") {
      if (!supported) throw unsupported();
      const dir = mkdtempSync(path.join(dataDir, "tmp", "summary-"));
      try {
        const input = path.join(dir, "input.txt");
        writeFileSync(input, text);
        summary = (
          await worker(
            [input, path.join(dataDir, "models"), "", "summarize"],
            progress,
          )
        ).summary;
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    } else if (provider === "ollama") {
      if (!consent)
        throw problem(
          400,
          "Confirm that the transcript can be sent to your configured AI server.",
        );
      const url = process.env.OLLAMA_URL || "http://127.0.0.1:11434";
      const parsed = new URL(url);
      if (
        parsed.protocol !== "https:" &&
        !["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname)
      )
        throw problem(400, "The AI server must use HTTPS or localhost.");
      const response = await fetch(`${url.replace(/\/$/, "")}/api/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: process.env.OLLAMA_MODEL || "llama3.2",
          stream: false,
          prompt: `Summarize this transcript faithfully in a short paragraph. Do not invent facts.\n\n${text.slice(0, 30000)}`,
        }),
        signal: AbortSignal.timeout(300000),
      });
      if (!response.ok)
        throw problem(
          503,
          "The configured AI server could not summarize this video.",
        );
      summary = (await response.json()).response;
    } else
      throw problem(400, "Choose local AI or your configured Ollama server.");
    const chapters = [];
    let next = 0;
    for (const word of words) {
      if (word.start >= next) {
        const at = words.indexOf(word);
        chapters.push({
          time: word.start,
          title: words
            .slice(at, at + 9)
            .map((w) => w.text)
            .join(" "),
        });
        next = word.start + 60;
      }
    }
    const sentences = text.match(/[^.!?]+[.!?]?/g) || [text];
    const actionItems = sentences
      .filter((s) =>
        /\b(need to|will|please|next step|action|todo|to do|follow up|should)\b/i.test(
          s,
        ),
      )
      .slice(0, 12)
      .map((s) => s.trim());
    const outline = {
      summary: String(summary || "").trim(),
      chapters,
      actionItems,
      provider,
      generated: new Date().toISOString(),
      projectSegments: JSON.stringify(getProject(v).segments),
      title: chapters[0]?.title || v.title,
    };
    db.prepare("UPDATE videos SET outline=? WHERE id=?").run(
      JSON.stringify(outline),
      v.id,
    );
    return { videoId: v.id, outline };
  }
  async function suggestions(videoId) {
    const v = find(videoId),
      assets = renderer.assetsFor(v),
      asset =
        assets.find((a) => a.role === "microphone") ||
        assets.find((a) => a.role === "primary") ||
        assets.find((a) => a.role === "screen") ||
        assets[0];
    let silence = [];
    if ((await renderer.info(asset)).hasAudio) {
      let output = "";
      try {
        const r = await run(
          ffmpeg,
          [
            "-hide_banner",
            "-nostdin",
            "-i",
            path.join(dataDir, "media", asset.filename),
            "-vn",
            "-af",
            "silencedetect=noise=-35dB:d=0.65",
            "-f",
            "null",
            "-",
          ],
          { timeout: 600000, maxBuffer: 4 * 1024 * 1024 },
        );
        output = r.stderr;
      } catch (e) {
        output = e.stderr || "";
      }
      let start;
      for (const m of output.matchAll(/silence_(start|end): ([\d.]+)/g)) {
        if (m[1] === "start") start = +m[2];
        else if (start !== undefined) {
          silence.push({
            sourceId: v.id,
            start: Math.max(0, start + 0.1),
            end: Math.min(v.duration, +m[2] - 0.1),
            kind: "silence",
          });
          start = undefined;
        }
      }
      if (start !== undefined && v.duration - start > 0.65)
        silence.push({
          sourceId: v.id,
          start: start + 0.1,
          end: v.duration,
          kind: "silence",
        });
    }
    const filler = parseJSON(v.transcript, [])
      .filter((w) => /^(um+|uh+|erm+|ah+)\W*$/i.test(w.text.trim()))
      .map((w) => ({
        sourceId: v.id,
        start: w.start,
        end: w.end,
        kind: "filler",
        text: w.text,
      }));
    return [...silence.filter((s) => s.end - s.start > 0.1), ...filler];
  }
  return {
    transcribe,
    summarize,
    suggestions,
    prepare,
    modelReady,
    models,
    supported,
  };
}
