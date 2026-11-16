import express from "express";
import { randomUUID, createHash } from "node:crypto";
import {
  mkdirSync,
  writeFileSync,
  existsSync,
  readFileSync,
  statSync,
  createWriteStream,
  createReadStream,
  renameSync,
  rmSync,
} from "node:fs";
import { pipeline } from "node:stream/promises";
import { finished } from "node:stream/promises";
import path from "node:path";
import ffmpeg from "../ffmpeg.mjs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { parseJSON, problem, safeMime } from "./schema.mjs";
import { autoZoom } from "./autozoom.mjs";
import { initialProject, cutRanges, validateProject } from "./project.mjs";
const run = promisify(execFile);
const roles = ["screen", "camera", "microphone", "system"];
const isId = (id) => /^[a-f0-9-]{36}$/.test(id);
export function registerRecordings({
  app,
  db,
  dataDir,
  owner,
  jobs,
  find,
  serialize,
  renderer,
}) {
  const root = path.join(dataDir, "recordings");
  mkdirSync(root, { recursive: true });
  const get = (id) => {
    const row = db.prepare("SELECT * FROM recordings WHERE id=?").get(id);
    if (!row) throw problem(404, "This recording session was not found.");
    return row;
  };
  const expose = (row) => ({
    ...row,
    meta: parseJSON(row.meta, {}),
    parts: db
      .prepare(
        "SELECT role,MAX(seq) AS last_seq,COUNT(*) AS count,SUM(size) AS size FROM recording_parts WHERE recording_id=? GROUP BY role",
      )
      .all(row.id),
  });
  app.get("/api/recordings", owner, (req, res) =>
    res.json(
      db
        .prepare(
          "SELECT * FROM recordings WHERE status NOT IN ('complete','discarded') ORDER BY created DESC",
        )
        .all()
        .map(expose),
    ),
  );
  app.post("/api/recordings", owner, (req, res) => {
    const id = req.body.id || randomUUID();
    if (!isId(id)) throw problem(400, "Invalid recording session.");
    const existing = db.prepare("SELECT * FROM recordings WHERE id=?").get(id);
    if (existing) return res.json(expose(existing));
    const meta = req.body.meta || {};
    if (
      !Array.isArray(meta.roles) ||
      !meta.roles.length ||
      meta.roles.some((r) => !roles.includes(r))
    )
      throw problem(400, "Choose valid recording tracks.");
    mkdirSync(path.join(root, id), { recursive: true });
    db.prepare(
      "INSERT INTO recordings(id,title,created,status,meta) VALUES(?,?,?,?,?)",
    ).run(
      id,
      String(req.body.title || "Recovered recording").slice(0, 160),
      new Date().toISOString(),
      "recording",
      JSON.stringify(meta),
    );
    res.status(201).json(expose(get(id)));
  });
  app.put(
    "/api/recordings/:id/parts/:role/:seq",
    owner,
    express.raw({ type: () => true, limit: "32mb" }),
    (req, res) => {
      const row = get(req.params.id),
        { role } = req.params,
        seq = Number(req.params.seq);
      if (
        !roles.includes(role) ||
        !Number.isInteger(seq) ||
        seq < 0 ||
        seq > 100000 ||
        !Buffer.isBuffer(req.body) ||
        !req.body.length
      )
        throw problem(400, "Invalid recording chunk.");
      const hash = createHash("sha256").update(req.body).digest("hex"),
        old = db
          .prepare(
            "SELECT * FROM recording_parts WHERE recording_id=? AND role=? AND seq=?",
          )
          .get(row.id, role, seq);
      if (old) {
        if (old.digest !== hash)
          throw problem(
            409,
            "A different chunk already occupies this sequence.",
          );
        return res.json({ ok: true, duplicate: true });
      }
      if (!["recording", "interrupted"].includes(row.status))
        throw problem(409, "This recording is already being processed.");
      const total = db
        .prepare(
          "SELECT COALESCE(SUM(size),0) AS size FROM recording_parts WHERE recording_id=?",
        )
        .get(row.id).size;
      if (total + req.body.length > 8 * 1024 ** 3)
        throw problem(
          413,
          "The recording session exceeds the 8 GB safety limit.",
        );
      const folder = path.join(root, row.id, role);
      mkdirSync(folder, { recursive: true });
      const target = path.join(folder, String(seq).padStart(8, "0"));
      writeFileSync(target + ".tmp", req.body, { flush: true });
      renameSync(target + ".tmp", target);
      const mime = String(req.get("x-track-mime") || "video/webm").slice(
        0,
        100,
      );
      if (safeMime(mime) === "application/octet-stream")
        throw problem(415, "Unsupported track type.");
      db.prepare("INSERT INTO recording_parts VALUES(?,?,?,?,?,?)").run(
        row.id,
        role,
        seq,
        mime,
        req.body.length,
        hash,
      );
      const end = Number(req.get("x-part-end"));
      if (Number.isFinite(end) && end > 0 && end <= 86400)
        db.prepare(
          "UPDATE recordings SET duration=MAX(duration,?) WHERE id=?",
        ).run(end, row.id);
      res.json({ ok: true });
    },
  );
  app.get("/api/recordings/:id", owner, (req, res) =>
    res.json(expose(get(req.params.id))),
  );
  app.post("/api/recordings/:id/finish", owner, (req, res) => {
    const row = get(req.params.id);
    if (row.status === "complete")
      return res.json({
        status: "complete",
        result: { videoId: row.video_id },
      });
    if (row.job_id) {
      const job = jobs.get(row.job_id);
      if (["queued", "running", "complete"].includes(job.status))
        return res.json(job);
    }
    const duration = Number(req.body.duration || row.duration);
    if (!Number.isFinite(duration) || duration <= 0 || duration > 86400)
      throw problem(400, "Enter a recording duration between 0 and 24 hours.");
    const meta = { ...parseJSON(row.meta, {}), ...req.body.meta };
    if (meta.excluded && !Array.isArray(meta.excluded))
      throw problem(400, "Invalid retake information.");
    const rolesPresent = db
      .prepare("SELECT DISTINCT role FROM recording_parts WHERE recording_id=?")
      .all(row.id)
      .map((p) => p.role);
    if (!rolesPresent.some((r) => r === "screen" || r === "camera"))
      throw problem(400, "No video chunks have arrived yet.");
    db.prepare(
      "UPDATE recordings SET status='processing',title=?,duration=?,meta=? WHERE id=?",
    ).run(
      String(req.body.title || row.title).slice(0, 160),
      duration,
      JSON.stringify(meta),
      row.id,
    );
    const job = jobs.enqueue("finish-recording", { recordingId: row.id });
    db.prepare("UPDATE recordings SET job_id=? WHERE id=?").run(job.id, row.id);
    res.status(202).json(job);
  });
  app.delete("/api/recordings/:id", owner, (req, res) => {
    const row = get(req.params.id);
    if (row.status === "processing")
      throw problem(409, "Wait for this recording to finish processing.");
    db.prepare("UPDATE recordings SET status='discarded' WHERE id=?").run(
      row.id,
    );
    rmSync(path.join(root, row.id), { recursive: true, force: true });
    db.prepare("DELETE FROM recording_parts WHERE recording_id=?").run(row.id);
    res.json({ ok: true });
  });
  jobs.register("finish-recording", async ({ recordingId }, progress) => {
    const row = get(recordingId);
    if (
      row.video_id &&
      db.prepare("SELECT id FROM videos WHERE id=?").get(row.video_id)
    )
      return { videoId: row.video_id };
    const meta = parseJSON(row.meta, {}),
      trackRows = db
        .prepare(
          "SELECT role,MIN(mime) AS mime FROM recording_parts WHERE recording_id=? GROUP BY role",
        )
        .all(row.id),
      videoId = randomUUID(),
      assets = [],
      created = [],
      filename = `${videoId}-r1.mp4`,
      destination = path.join(dataDir, "media", filename);
    // Everything from the first remux on is undone together if any step fails,
    // so a retry never leaves an orphaned video behind.
    try {
      for (let i = 0; i < trackRows.length; i++) {
        const track = trackRows[i],
          parts = db
            .prepare(
              "SELECT * FROM recording_parts WHERE recording_id=? AND role=? ORDER BY seq",
            )
            .all(row.id, track.role);
        for (let j = 0; j < parts.length; j++)
          if (parts[j].seq !== j)
            throw problem(
              409,
              `The ${track.role} track has a missing chunk. Reconnect and retry.`,
            );
        const joined = path.join(root, row.id, `${track.role}.stream`),
          stream = createWriteStream(joined);
        for (const p of parts) {
          const file = path.join(
            root,
            row.id,
            track.role,
            String(p.seq).padStart(8, "0"),
          );
          for await (const data of createReadStream(file))
            if (!stream.write(data))
              await new Promise((r) => stream.once("drain", r));
        }
        stream.end();
        await finished(stream);
        const ext = track.mime.includes("mp4") ? "mp4" : "webm",
          trackFile = `${videoId}-${track.role}.${ext}`,
          target = path.join(dataDir, "media", trackFile);
        created.push(trackFile);
        await run(
          ffmpeg,
          [
            "-hide_banner",
            "-loglevel",
            "error",
            "-nostdin",
            "-y",
            // Name the container explicitly rather than trusting the bytes.
            "-f",
            ext === "mp4" ? "mov" : "matroska",
            "-i",
            joined,
            "-c",
            "copy",
            ...(ext === "mp4" ? ["-movflags", "+faststart"] : []),
            target,
          ],
          { timeout: 600000, maxBuffer: 1024 * 1024 },
        );
        const info = await renderer.info({
          video_id: videoId,
          role: track.role,
          filename: trackFile,
          info: "{}",
        });
        assets.push({
          role: track.role,
          filename: trackFile,
          mime: safeMime(track.mime),
          duration: info.duration || row.duration,
          info,
        });
        progress(5 + ((i + 1) / trackRows.length) * 15);
      }
      const primary =
        assets.find((a) => a.role === "screen") ||
        assets.find((a) => a.role === "camera");
      db.prepare(
        "INSERT INTO videos(id,title,duration,size,mime,filename,created) VALUES(?,?,?,?,?,?,?)",
      ).run(
        videoId,
        row.title,
        row.duration,
        statSync(path.join(dataDir, "media", primary.filename)).size,
        "video/webm",
        primary.filename,
        new Date().toISOString(),
      );
      for (const asset of assets)
        db.prepare("INSERT INTO assets VALUES(?,?,?,?,?,?)").run(
          videoId,
          asset.role,
          asset.filename,
          asset.mime,
          asset.duration,
          JSON.stringify(asset.info),
        );
      let project = initialProject(find(videoId));
      const sourceWidth = primary.info.width || 1280,
        sourceHeight = primary.info.height || 720,
        scale = Math.min(1, 3840 / sourceWidth, 2160 / sourceHeight);
      project.layout.width = Math.max(
        320,
        Math.round((sourceWidth * scale) / 2) * 2,
      );
      project.layout.height = Math.max(
        180,
        Math.round((sourceHeight * scale) / 2) * 2,
      );
      // Screen recordings are framed on a wallpaper by default.
      if (assets.some((x) => x.role === "screen"))
        Object.assign(project.layout, {
          wallpaper: "aurora",
          padding: Math.round((project.layout.width * 0.045) / 2) * 2,
          radius: 0.012,
          shadow: 0.7,
        });
      if (meta.layout)
        project.layout = {
          ...project.layout,
          ...meta.layout,
          camera: { ...project.layout.camera, ...meta.layout.camera },
          audio: { ...project.layout.audio, ...meta.layout.audio },
        };
      for (const range of meta.excluded || []) {
        if (
          Number.isFinite(range.start) &&
          Number.isFinite(range.end) &&
          range.start >= 0 &&
          range.end <= row.duration
        )
          project = cutRanges(project, videoId, [range]);
      }
      // Desktop recordings zoom into key moments automatically. Each zoom is an
      // ordinary, removable effect in the project.
      if (meta.autoZoom && Array.isArray(meta.pointers) && meta.pointers.length)
        project.overlays = [
          ...(project.overlays || []),
          ...autoZoom(meta.pointers, {
            segments: project.segments,
            sourceId: videoId,
            duration: row.duration,
          }),
        ].slice(0, 60);
      // Client-supplied layout reaches the render, so it is always validated.
      project = validateProject(project, find);
      const rendered = await renderer.render(
        find(videoId),
        project,
        destination,
        (n) => progress(20 + n * 0.78),
      );
      db.prepare(
        "UPDATE videos SET project=?,published_project=?,filename=?,mime=?,size=?,thumbnail=?,duration=?,revision=1 WHERE id=?",
      ).run(
        JSON.stringify(project),
        JSON.stringify(project),
        filename,
        "video/mp4",
        rendered.size,
        rendered.thumbnail,
        rendered.duration,
        videoId,
      );
      db.prepare("INSERT OR IGNORE INTO project_history VALUES(?,?,?,?)").run(
        videoId,
        0,
        JSON.stringify(project),
        new Date().toISOString(),
      );
      db.prepare(
        "UPDATE recordings SET status='complete',video_id=? WHERE id=?",
      ).run(videoId, row.id);
      jobs.enqueue("stream", { videoId });
      rmSync(path.join(root, row.id), { recursive: true, force: true });
      db.prepare("DELETE FROM recording_parts WHERE recording_id=?").run(
        row.id,
      );
      return { videoId };
    } catch (e) {
      db.prepare("DELETE FROM assets WHERE video_id=?").run(videoId);
      db.prepare("DELETE FROM videos WHERE id=?").run(videoId);
      for (const file of created)
        rmSync(path.join(dataDir, "media", file), { force: true });
      rmSync(destination, { force: true });
      throw e;
    }
  });
  return { get };
}
