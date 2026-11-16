import { randomUUID } from "node:crypto";
import {
  mkdirSync,
  existsSync,
  writeFileSync,
  readFileSync,
  rmSync,
} from "node:fs";
import path from "node:path";
import { createJobs } from "./jobs.mjs";
import { createRenderer, engine, probe } from "./render.mjs";
import { registerRecordings } from "./recordings.mjs";
import { registerSharing } from "./sharing.mjs";
import { createTranscription } from "./transcription.mjs";
import { parseJSON, problem, mediaHeaders, sendMedia } from "./schema.mjs";
import {
  getProject,
  validateProject,
  publishedProject,
  outputWords,
  transcriptWords,
  captions,
  parseCaptions,
  cutRanges,
  cleanOutline,
} from "./project.mjs";
import { registerPortable } from "./portable.mjs";
import { autoZoom } from "./autozoom.mjs";
import { createAssistantEdits } from "./assistant-edits.mjs";
import { registerAI } from "./ai/index.mjs";
import { registerIntegrations } from "./integrations.mjs";
const packageVersion = JSON.parse(
  readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
).version;
export function registerStudio(context) {
  const { app, db, dataDir, owner, admin, find, serialize } = context,
    jobs = createJobs(db),
    renderer = createRenderer(context),
    transcription = createTranscription({ ...context, renderer });
  const sharing = registerSharing(context);
  const sourceFind = (id) => {
    const v = find(id),
      assets = renderer.assetsFor(v),
      primary =
        assets.find((a) => a.role === "screen") ||
        assets.find((a) => a.role === "primary") ||
        assets.find((a) => a.role === "camera");
    return { ...v, duration: primary?.duration || v.duration };
  };
  const projectResponse = (v) => ({
    project: getProject(v),
    // What the shared video currently shows, to tell when edits are unpublished.
    published: publishedProject(v),
    revision: v.revision,
    canUndo: v.history_cursor > 0,
    canRedo: Boolean(
      db
        .prepare(
          "SELECT cursor FROM project_history WHERE video_id=? AND cursor=?",
        )
        .get(v.id, v.history_cursor + 1),
    ),
    sources: renderer.assetsFor(v).map((a) => ({
      role: a.role,
      mime: a.mime,
      duration: a.duration,
      info: parseJSON(a.info, {}),
    })),
    sourceDuration: sourceFind(v.id).duration,
  });
  const save = (v, p) => {
    if (
      !db
        .prepare("SELECT cursor FROM project_history WHERE video_id=?")
        .get(v.id)
    )
      db.prepare("INSERT INTO project_history VALUES(?,?,?,?)").run(
        v.id,
        v.history_cursor,
        JSON.stringify(getProject(v)),
        new Date().toISOString(),
      );
    db.prepare("DELETE FROM project_history WHERE video_id=? AND cursor>?").run(
      v.id,
      v.history_cursor,
    );
    const cursor = v.history_cursor + 1;
    db.prepare("INSERT INTO project_history VALUES(?,?,?,?)").run(
      v.id,
      cursor,
      JSON.stringify(p),
      new Date().toISOString(),
    );
    db.prepare("UPDATE videos SET project=?,history_cursor=? WHERE id=?").run(
      JSON.stringify(p),
      cursor,
      v.id,
    );
    return projectResponse(find(v.id));
  };
  app.get("/api/jobs", owner, (req, res) => res.json(jobs.list()));
  app.put("/api/videos/:id/outline", owner, (req, res) => {
    const v = find(req.params.id),
      b = req.body;
    const outline = cleanOutline({
      ...parseJSON(v.outline, {}),
      summary: String(b.summary || ""),
      actionItems: Array.isArray(b.actionItems)
        ? b.actionItems.slice(0, 30).map(String)
        : [],
      projectSegments: JSON.stringify(getProject(v).segments),
    });
    db.prepare("UPDATE videos SET outline=? WHERE id=?").run(
      JSON.stringify(outline),
      v.id,
    );
    res.json(serialize(find(v.id)));
  });
  app.get("/api/jobs/:id", owner, (req, res) =>
    res.json(jobs.get(req.params.id)),
  );
  app.post("/api/jobs/:id/retry", owner, (req, res) =>
    res.json(jobs.retry(req.params.id)),
  );
  app.get("/api/videos/:id/project", owner, (req, res) =>
    res.json(projectResponse(find(req.params.id))),
  );
  app.put("/api/videos/:id/project", owner, (req, res) => {
    const v = find(req.params.id);
    res.json(save(v, validateProject(req.body, sourceFind)));
  });
  for (const [direction, delta] of [
    ["undo", -1],
    ["redo", 1],
  ])
    app.post(`/api/videos/:id/project/${direction}`, owner, (req, res) => {
      const v = find(req.params.id),
        cursor = v.history_cursor + delta,
        history = db
          .prepare(
            "SELECT * FROM project_history WHERE video_id=? AND cursor=?",
          )
          .get(v.id, cursor);
      if (!history) throw problem(409, `Nothing to ${direction}.`);
      db.prepare("UPDATE videos SET project=?,history_cursor=? WHERE id=?").run(
        history.project,
        cursor,
        v.id,
      );
      res.json(projectResponse(find(v.id)));
    });
  app.post("/api/videos/:id/project/cut", owner, (req, res) => {
    const v = find(req.params.id),
      ranges = req.body.ranges ?? [];
    if (
      !Array.isArray(ranges) ||
      ranges.length > 500 ||
      ranges.some(
        (r) =>
          !Number.isFinite(r?.start) ||
          !Number.isFinite(r?.end) ||
          r.start >= r.end,
      )
    )
      throw problem(400, "Choose valid stretches of the video to cut.");
    const p = cutRanges(
      getProject(v),
      String(req.body.sourceId || v.id),
      ranges,
    );
    res.json(save(v, validateProject(p, sourceFind)));
  });
  app.get("/api/videos/:id/tracks/:role", owner, (req, res, next) => {
    const v = find(req.params.id),
      assets = renderer.assetsFor(v),
      // "main" is whichever track carries the picture; "voice" is the microphone.
      wanted =
        req.params.role === "main"
          ? ["screen", "primary", "camera"]
          : req.params.role === "voice"
            ? ["microphone"]
            : [req.params.role],
      asset = wanted.map((r) => assets.find((a) => a.role === r)).find(Boolean);
    if (!asset) throw problem(404, "This source track was not found.");
    mediaHeaders(res, asset.mime);
    sendMedia(res, asset.filename, path.join(dataDir, "media"), next);
  });
  app.post("/api/videos/:id/render", owner, (req, res) => {
    const v = find(req.params.id),
      project = validateProject(req.body.project || getProject(v), sourceFind);
    if (req.body.project) save(v, project);
    res.status(202).json(
      jobs.enqueue("render", {
        videoId: v.id,
        project,
        copy: Boolean(req.body.copy),
      }),
    );
  });
  jobs.register("render", async ({ videoId, project, copy }, progress) => {
    const v = find(videoId),
      id = copy ? randomUUID() : v.id,
      revision = copy ? 1 : v.revision + 1,
      filename = `${id}-r${revision}-${randomUUID().slice(0, 8)}.mp4`,
      target = path.join(dataDir, "media", filename);
    try {
      const rendered = await renderer.render(v, project, target, progress);
      if (copy) {
        db.prepare(
          "INSERT INTO videos(id,title,description,duration,size,mime,filename,thumbnail,created,folder,project,published_project,revision) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
        ).run(
          id,
          `${v.title} (edited)`.slice(0, 160),
          v.description,
          rendered.duration,
          rendered.size,
          "video/mp4",
          filename,
          rendered.thumbnail,
          new Date().toISOString(),
          v.folder,
          JSON.stringify(project),
          JSON.stringify(project),
          revision,
        );
      } else {
        db.prepare("INSERT INTO versions VALUES(?,?,?,?,?,?)").run(
          randomUUID(),
          v.id,
          v.revision,
          v.filename,
          v.published_project,
          new Date().toISOString(),
        );
        db.prepare(
          "UPDATE videos SET filename=?,mime=?,duration=?,size=?,thumbnail=?,revision=?,published_project=? WHERE id=?",
        ).run(
          filename,
          "video/mp4",
          rendered.duration,
          rendered.size,
          rendered.thumbnail,
          revision,
          JSON.stringify(project),
          v.id,
        );
      }
      sharing.notify(
        id,
        "render",
        `“${v.title}” is ready. The share link now plays the latest revision.`,
      );
      jobs.enqueue("stream", { videoId: id });
      return { videoId: id, revision };
    } catch (e) {
      if (existsSync(target)) rmSync(target);
      throw e;
    }
  });
  app.post("/api/videos/:id/transcribe", owner, (req, res) => {
    find(req.params.id);
    res.status(202).json(
      jobs.enqueue("transcribe", {
        videoId: req.params.id,
        model: req.body.model || "Xenova/whisper-tiny.en",
      }),
    );
  });
  jobs.register("transcribe", transcription.transcribe);
  jobs.register("prepare-ai", transcription.prepare);
  app.get("/api/ai/status", owner, (req, res) =>
    res.json({
      supported: transcription.supported,
      models: transcription.models.map((model) => ({
        model,
        ready: transcription.modelReady(model),
      })),
    }),
  );
  app.post("/api/ai/prepare", owner, (req, res) => {
    const model = String(req.body.model || "Xenova/whisper-tiny.en");
    if (!transcription.models.includes(model))
      return res
        .status(400)
        .json({ error: "Choose a supported local transcription model." });
    if (transcription.modelReady(model))
      return res.json({ status: "complete", progress: 100, model });
    res.status(202).json(jobs.enqueue("prepare-ai", { model }));
  });
  app.get("/api/videos/:id/transcript", owner, (req, res) => {
    const v = find(req.params.id);
    res.json({
      words: parseJSON(v.transcript, []),
      outputWords: outputWords(getProject(v), find),
      outline: parseJSON(v.outline, {}),
    });
  });
  app.put("/api/videos/:id/transcript", owner, (req, res) => {
    const v = sourceFind(req.params.id);
    let words = req.body.content
      ? parseCaptions(req.body.content)
      : req.body.words;
    words = transcriptWords(words, v.duration);
    db.prepare("UPDATE videos SET transcript=? WHERE id=?").run(
      JSON.stringify(words),
      v.id,
    );
    res.json({ words });
  });
  app.get("/api/videos/:id/captions.:format", owner, (req, res) => {
    const v = find(req.params.id);
    if (!["vtt", "srt"].includes(req.params.format))
      throw problem(404, "Caption format not found.");
    res
      .type(req.params.format === "vtt" ? "text/vtt" : "text/plain")
      .send(
        captions(
          outputWords(
            req.user?.role === "viewer" ? publishedProject(v) : getProject(v),
            find,
          ),
          req.params.format,
        ),
      );
  });
  app.post("/api/videos/:id/summarize", owner, (req, res) => {
    find(req.params.id);
    res.status(202).json(
      jobs.enqueue("summarize", {
        videoId: req.params.id,
        provider: req.body.provider || "local",
        consent: Boolean(req.body.consent),
      }),
    );
  });
  jobs.register("summarize", transcription.summarize);
  app.get("/api/videos/:id/focus-suggestions", owner, (req, res) => {
    const v = find(req.params.id),
      recording = db
        .prepare("SELECT meta FROM recordings WHERE video_id=?")
        .get(v.id),
      points = parseJSON(recording?.meta, {}).pointers || [],
      project = getProject(v);
    const existing = project.overlays.filter((o) => o.type === "zoom");
    // Skip moments that already have a zoom.
    res.json(
      autoZoom(points, {
        segments: project.segments,
        sourceId: v.id,
        // The length of the footage, not of the published video.
        duration: sourceFind(v.id).duration,
      }).filter(
        (z) => !existing.some((e) => z.start < e.end && z.end > e.start),
      ),
    );
  });
  app.post("/api/videos/:id/suggestions", owner, async (req, res) =>
    res.json(await transcription.suggestions(req.params.id)),
  );
  app.post("/api/videos/:id/stream", owner, (req, res) => {
    find(req.params.id);
    res.status(202).json(jobs.enqueue("stream", { videoId: req.params.id }));
  });
  jobs.register("stream", async ({ videoId }, progress) => {
    const v = find(videoId),
      root = path.join(dataDir, "media", "hls", v.id, String(v.revision));
    if (existsSync(path.join(root, "master.m3u8")))
      return { videoId, ready: true };
    mkdirSync(root, { recursive: true });
    const variants = [
      { height: 360, rate: "650k", bandwidth: 850000 },
      { height: 720, rate: "1800k", bandwidth: 2100000 },
    ];
    const info = await probe(path.join(dataDir, "media", v.filename));
    const selected = variants.filter((v) => v.height <= info.height);
    if (!selected.length)
      selected.push({
        height: Math.max(180, Math.floor((info.height || 360) / 2) * 2),
        rate: "650k",
        bandwidth: 850000,
      });
    const master = ["#EXTM3U", "#EXT-X-VERSION:3"];
    for (let i = 0; i < selected.length; i++) {
      const variant = selected[i],
        name = `${variant.height}p`;
      await engine([
        "-y",
        "-i",
        path.join(dataDir, "media", v.filename),
        "-vf",
        `scale=-2:${variant.height}`,
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-b:v",
        variant.rate,
        "-c:a",
        "aac",
        "-b:a",
        "96k",
        "-g",
        "120",
        "-sc_threshold",
        "0",
        "-threads",
        "2",
        "-hls_time",
        "4",
        "-hls_list_size",
        "0",
        "-hls_playlist_type",
        "vod",
        "-hls_segment_filename",
        path.join(root, `${name}_%05d.ts`),
        path.join(root, `${name}.m3u8`),
      ]);
      master.push(
        `#EXT-X-STREAM-INF:BANDWIDTH=${variant.bandwidth}`,
        `${name}.m3u8`,
      );
      progress(((i + 1) / selected.length) * 95);
    }
    writeFileSync(path.join(root, "master.m3u8"), master.join("\n") + "\n");
    return { videoId, ready: true };
  });
  const recordings = registerRecordings({
    ...context,
    jobs,
    renderer,
    autoTranscribe: (videoId) => {
      const model = "Xenova/whisper-tiny.en";
      if (transcription.supported && transcription.modelReady(model))
        jobs.enqueue("transcribe", { videoId, model });
    },
  });
  registerPortable({ ...context, renderer, sourceFind });
  registerAI({ app, db, owner, admin, find, jobs });
  const edits = createAssistantEdits({
    db,
    find,
    sourceFind,
    save,
    validateProject,
    suggestions: transcription.suggestions,
  });
  const { check } = registerIntegrations({
    ...context,
    sharing,
    jobs,
    edits,
    version: packageVersion,
  });
  return {
    jobs,
    renderer,
    recordings,
    sharing,
    check,
    close: () => jobs.close(),
  };
}
