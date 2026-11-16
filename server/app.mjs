import express from "express";
import { migrateStudio, parseJSON, downloadName } from "./studio/schema.mjs";
import { createAuth } from "./studio/auth.mjs";
import { registerStudio } from "./studio/index.mjs";
import { mediaHeaders } from "./studio/schema.mjs";
import { outputWords, publishedProject } from "./studio/project.mjs";
import ffmpeg from "./ffmpeg.mjs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const execFileAsync = promisify(execFile);
import multer from "multer";
import { DatabaseSync } from "node:sqlite";
import {
  randomUUID,
  randomBytes,
  timingSafeEqual,
  createHash,
} from "node:crypto";
import {
  mkdirSync,
  existsSync,
  openSync,
  readSync,
  closeSync,
  statSync,
  unlinkSync,
  rmSync,
} from "node:fs";
import path from "node:path";

const fail = (status, message) => Object.assign(new Error(message), { status });
const text = (v, max, fallback = "") =>
  typeof v === "string" ? v.trim().slice(0, max) : fallback;
export function createApp({
  dataDir = path.resolve("data"),
  password = process.env.ADMIN_PASSWORD || "",
  localSecret = "",
} = {}) {
  mkdirSync(path.join(dataDir, "media"), { recursive: true });
  mkdirSync(path.join(dataDir, "tmp"), { recursive: true });
  const db = new DatabaseSync(path.join(dataDir, "relay.sqlite"));
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
    CREATE TABLE IF NOT EXISTS videos (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
      duration REAL NOT NULL, size INTEGER NOT NULL, mime TEXT NOT NULL, filename TEXT NOT NULL,
      thumbnail TEXT, created TEXT NOT NULL, starred INTEGER NOT NULL DEFAULT 0,
      folder TEXT NOT NULL DEFAULT '', token TEXT UNIQUE, views INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS comments (
      id TEXT PRIMARY KEY, video_id TEXT NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
      author TEXT NOT NULL, body TEXT NOT NULL, time REAL NOT NULL, created TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS reactions (
      video_id TEXT NOT NULL REFERENCES videos(id) ON DELETE CASCADE, emoji TEXT NOT NULL,
      count INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(video_id,emoji));`);
  migrateStudio(db);
  const app = express();
  // Route matching must agree with the role checks, which compare exact paths.
  app.set("case sensitive routing", true);
  if (process.env.TRUST_PROXY) app.set("trust proxy", process.env.TRUST_PROXY);
  app.disable("x-powered-by");
  // The Mac app's library is private to Relay's own windows: other programs on the
  // computer can reach the port but don't hold this per-launch secret. Shared
  // watch pages stay open so links work in a browser.
  if (localSecret)
    app.use((req, res, next) => {
      const p = req.path.toLowerCase();
      if (
        (!p.startsWith("/api/") && p !== "/mcp") ||
        p.startsWith("/api/share/")
      )
        return next();
      const given =
        req.headers.cookie?.match(
          /(?:^|;\s*)relay_local=([a-f0-9]{64})(?:;|$)/,
        )?.[1] || "";
      if (p === "/mcp" && req.get("authorization")) return next();
      if (given !== localSecret)
        return res
          .status(401)
          .json({ error: "Open Relay to use this library." });
      next();
    });
  app.use((req, res, next) => {
    if (
      !password &&
      !["127.0.0.1", "localhost", "::1", "[::1]"].includes(req.hostname)
    )
      return res
        .status(403)
        .json({ error: "Local workspaces only accept localhost requests." });
    res.set({
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "same-origin",
      ...(req.path.startsWith("/embed/") || req.path.startsWith("/api/share/")
        ? {}
        : { "X-Frame-Options": "SAMEORIGIN" }),
    });
    if (req.path.startsWith("/api")) res.set("Cache-Control", "no-store");
    if (
      !["GET", "HEAD", "OPTIONS"].includes(req.method) &&
      req.headers.origin
    ) {
      const expected = process.env.PUBLIC_URL
        ? new URL(process.env.PUBLIC_URL).origin
        : `${req.protocol}://${req.get("host")}`;
      if (req.headers.origin !== expected)
        return res
          .status(403)
          .json({ error: "This request came from a different site." });
    }
    next();
  });
  app.use(express.json({ limit: "2mb" }));
  app.use((req, res, next) => {
    req.body ??= {};
    next();
  });
  const attempts = new Map();
  const rateLimit = (req, res, next) => {
    const key = `${req.ip}:${req.path}`,
      now = Date.now();
    let row = attempts.get(key);
    if (!row || row.reset < now) row = { count: 0, reset: now + 60000 };
    attempts.set(key, row);
    if (++row.count > 30)
      return res
        .status(429)
        .json({ error: "A little too fast. Try again in a minute." });
    if (attempts.size > 10000)
      for (const [k, v] of attempts) if (v.reset < now) attempts.delete(k);
    next();
  };
  const { owner, admin } = createAuth({ app, db, password, rateLimit });
  const find = (id) => {
    const v = db.prepare("SELECT * FROM videos WHERE id=?").get(id);
    if (!v) throw fail(404, "This video could not be found.");
    return v;
  };
  const byToken = (token) => {
    const v = db.prepare("SELECT * FROM videos WHERE token=?").get(token);
    if (!v) throw fail(404, "This link is unavailable or has been revoked.");
    return v;
  };
  const serialize = (v, shared = false) => ({
    id: v.id,
    title: v.title,
    description: v.description,
    duration: v.duration,
    size: v.size,
    mime: v.mime,
    thumbnail: v.thumbnail,
    created: v.created,
    starred: Boolean(v.starred),
    folder: shared ? undefined : v.folder,
    token: shared ? undefined : v.token,
    views: v.views,
    revision: v.revision || 0,
    project: shared ? undefined : parseJSON(v.project, {}),
    outline: parseJSON(v.outline, {}),
    transcript: parseJSON(v.transcript, []),
    streamReady: existsSync(
      path.join(
        dataDir,
        "media",
        "hls",
        v.id,
        String(v.revision),
        "master.m3u8",
      ),
    ),
    shareConfig: shared
      ? undefined
      : (() => {
          const c = parseJSON(v.share_config, {});
          return {
            ...c,
            passwordHash: undefined,
            hasPassword: Boolean(c.passwordHash),
          };
        })(),
    comments: db
      .prepare(
        "SELECT id,author,body,time,created,parent_id AS parentId,resolved,mentions FROM comments WHERE video_id=? ORDER BY created",
      )
      .all(v.id),
    reactions: db
      .prepare("SELECT emoji,count FROM reactions WHERE video_id=?")
      .all(v.id),
  });
  const studio = registerStudio({
    app,
    db,
    dataDir,
    owner,
    admin,
    rateLimit,
    find,
    serialize,
  });
  const viewerCanRead = (v, user) =>
    user?.role !== "viewer" ||
    parseJSON(v.share_config, {}).access !== "invited" ||
    (parseJSON(v.share_config, {}).invitedEmails || []).includes(user.email);
  const present = (v, user) => {
    const result = serialize(v);
    if (user?.role === "viewer") {
      const c = parseJSON(v.share_config, {}),
        p = publishedProject(v),
        o = parseJSON(v.outline, {});
      return {
        ...result,
        project: undefined,
        shareConfig: undefined,
        transcript: outputWords(p, find),
        outline: o.projectSegments === JSON.stringify(p.segments) ? o : {},
        downloadAllowed: c.download !== false,
      };
    }
    return result;
  };
  const upload = multer({
    dest: path.join(dataDir, "tmp"),
    limits: {
      fileSize: 1024 * 1024 * 1024,
      files: 1,
      fields: 6,
      fieldSize: 1500000,
    },
  });
  app.get("/api/videos", owner, (req, res) =>
    res.json(
      db
        .prepare("SELECT * FROM videos ORDER BY created DESC")
        .all()
        .filter((v) => viewerCanRead(v, req.user))
        .map((v) => present(v, req.user)),
    ),
  );
  let ingesting = 0;
  app.post(
    "/api/videos",
    owner,
    upload.single("video"),
    async (req, res, next) => {
      const file = req.file;
      let destination,
        admitted = false;
      try {
        if (!file) throw fail(400, "Choose a video first.");
        const fd = openSync(file.path, "r"),
          bytes = Buffer.alloc(32);
        try {
          readSync(fd, bytes, 0, 32, 0);
        } finally {
          closeSync(fd);
        }
        const webm = bytes
          .subarray(0, 4)
          .equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
        const mp4 = bytes.subarray(4, 8).toString() === "ftyp";
        if (!webm && !mp4) throw fail(415, "Please use a WebM or MP4 video.");
        let duration = Number(req.body.duration);
        if (!Number.isFinite(duration) || duration <= 0 || duration > 86400)
          throw fail(400, "The video duration must be between 0 and 24 hours.");
        const id = randomUUID(),
          mime = webm ? "video/webm" : "video/mp4",
          filename = `${id}.${webm ? "webm" : "mp4"}`;
        const thumbnail =
          typeof req.body.thumbnail === "string" &&
          /^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(
            req.body.thumbnail,
          ) &&
          req.body.thumbnail.length < 1200000
            ? req.body.thumbnail
            : null;
        if (ingesting >= 2)
          throw fail(429, "Two videos are being saved. Try again in a moment.");
        if (!ffmpeg || !existsSync(ffmpeg))
          throw fail(
            503,
            "The video processor is unavailable. Reinstall dependencies to restore FFmpeg.",
          );
        ingesting++;
        admitted = true;
        destination = path.join(dataDir, "media", filename);
        // MediaRecorder's streaming WebM has no final duration or seek index.
        // Remux without re-encoding to make the saved file seekable and validate it.
        let progress;
        try {
          ({ stdout: progress } = await execFileAsync(
            ffmpeg,
            [
              "-hide_banner",
              "-loglevel",
              "error",
              "-nostdin",
              "-i",
              file.path,
              "-map",
              "0:v:0",
              "-map",
              "0:a?",
              "-c",
              "copy",
              "-map_metadata",
              "-1",
              ...(mp4 ? ["-movflags", "+faststart"] : []),
              "-progress",
              "pipe:1",
              "-nostats",
              destination,
            ],
            { timeout: 120000, maxBuffer: 1024 * 1024 },
          ));
        } catch {
          throw fail(
            415,
            "This video could not be processed. Try another MP4 or WebM file.",
          );
        }
        const timestamps = [...progress.matchAll(/out_time_us=(\d+)/g)];
        const measured = Number(timestamps.at(-1)?.[1]) / 1000000;
        if (measured > 0) duration = measured;
        if (duration > 86400)
          throw fail(400, "Videos must be shorter than 24 hours.");
        try {
          db.prepare(
            "INSERT INTO videos(id,title,duration,size,mime,filename,thumbnail,created) VALUES(?,?,?,?,?,?,?,?)",
          ).run(
            id,
            text(req.body.title, 160, "Untitled video") || "Untitled video",
            duration,
            statSync(destination).size,
            mime,
            filename,
            thumbnail,
            new Date().toISOString(),
          );
        } catch (e) {
          throw e;
        }
        unlinkSync(file.path);
        res.status(201).json(serialize(find(id)));
      } catch (e) {
        if (file && existsSync(file.path)) unlinkSync(file.path);
        if (destination && existsSync(destination)) unlinkSync(destination);
        next(e);
      } finally {
        if (admitted) ingesting--;
      }
    },
  );
  let rendering = false;
  app.post("/api/videos/:id/trim", owner, async (req, res, next) => {
    let destination;
    try {
      const v = find(req.params.id),
        start = Number(req.body.start),
        end = Number(req.body.end);
      if (
        !Number.isFinite(start) ||
        !Number.isFinite(end) ||
        start < 0 ||
        end > v.duration + 0.05 ||
        end - start < 0.1
      )
        throw fail(400, "Choose a valid range of at least 0.1 seconds.");
      if (rendering)
        throw fail(
          429,
          "Another clip is rendering. Please try again when it finishes.",
        );
      if (!ffmpeg || !existsSync(ffmpeg))
        throw fail(
          503,
          "The video renderer is unavailable. Reinstall dependencies to restore FFmpeg.",
        );
      rendering = true;
      const id = randomUUID(),
        filename = `${id}.mp4`;
      destination = path.join(dataDir, "media", filename);
      try {
        await execFileAsync(
          ffmpeg,
          [
            "-hide_banner",
            "-loglevel",
            "error",
            "-nostdin",
            "-ss",
            String(start),
            "-i",
            path.join(dataDir, "media", v.filename),
            "-t",
            String(end - start),
            "-map",
            "0:v:0",
            "-map",
            "0:a?",
            "-c:v",
            "libx264",
            "-preset",
            "veryfast",
            "-crf",
            "22",
            "-pix_fmt",
            "yuv420p",
            "-vf",
            "scale=trunc(iw/2)*2:trunc(ih/2)*2",
            "-c:a",
            "aac",
            "-movflags",
            "+faststart",
            destination,
          ],
          { timeout: 600000, maxBuffer: 1024 * 1024 },
        );
        const { size } = statSync(destination);
        db.prepare(
          "INSERT INTO videos(id,title,description,duration,size,mime,filename,thumbnail,created,folder) VALUES(?,?,?,?,?,?,?,?,?,?)",
        ).run(
          id,
          `${v.title} (trimmed)`.slice(0, 160),
          v.description,
          end - start,
          size,
          "video/mp4",
          filename,
          v.thumbnail,
          new Date().toISOString(),
          v.folder,
        );
        res.status(201).json(serialize(find(id)));
      } finally {
        rendering = false;
      }
    } catch (e) {
      if (destination && existsSync(destination)) unlinkSync(destination);
      next(e.status ? e : fail(500, "The video could not be rendered."));
    }
  });
  app.get("/api/videos/:id", owner, (req, res) =>
    res.json(present(find(req.params.id), req.user)),
  );
  app.patch("/api/videos/:id", owner, (req, res) => {
    const v = find(req.params.id),
      b = req.body;
    db.prepare(
      "UPDATE videos SET title=?,description=?,starred=?,folder=? WHERE id=?",
    ).run(
      b.title === undefined ? v.title : text(b.title, 160) || "Untitled video",
      b.description === undefined ? v.description : text(b.description, 20000),
      b.starred === undefined ? v.starred : Number(Boolean(b.starred)),
      b.folder === undefined ? v.folder : text(b.folder, 80),
      v.id,
    );
    res.json(serialize(find(v.id)));
  });
  app.delete("/api/videos/:id", owner, (req, res) => {
    const v = find(req.params.id);
    const projects = db
      .prepare(
        "SELECT id,title,project,published_project FROM videos WHERE id!=?",
      )
      .all(v.id);
    const uses = (value) =>
      (parseJSON(value, {}).segments || []).some((s) => s.sourceId === v.id);
    const dependent = projects.find(
      (p) => uses(p.project) || uses(p.published_project),
    );
    const history = db
      .prepare(
        "SELECT video_id,project FROM project_history WHERE video_id!=? UNION ALL SELECT video_id,project FROM versions WHERE video_id!=?",
      )
      .all(v.id, v.id)
      .find((p) => uses(p.project));
    if (dependent || history)
      throw fail(
        409,
        `This footage is used by ${dependent ? `“${dependent.title}”` : "another editable project"}. Export a rendered copy or remove those source references before deleting it.`,
      );
    const files = new Set([
      v.filename,
      ...db
        .prepare(
          "SELECT filename FROM assets WHERE video_id=? UNION SELECT filename FROM versions WHERE video_id=?",
        )
        .all(v.id, v.id)
        .map((a) => a.filename),
    ]);
    db.prepare("DELETE FROM videos WHERE id=?").run(v.id);
    for (const file of files)
      if (!db.prepare("SELECT video_id FROM assets WHERE filename=?").get(file))
        rmSync(path.join(dataDir, "media", file), { force: true });
    rmSync(path.join(dataDir, "media", "hls", v.id), {
      recursive: true,
      force: true,
    });
    for (const r of db
      .prepare("SELECT id FROM recordings WHERE video_id=?")
      .all(v.id)) {
      rmSync(path.join(dataDir, "recordings", r.id), {
        recursive: true,
        force: true,
      });
      db.prepare("DELETE FROM recordings WHERE id=?").run(r.id);
    }
    res.json({ ok: true });
  });
  app.get("/api/media/:id", owner, (req, res) => {
    const v = find(req.params.id);
    mediaHeaders(res, v.mime);
    if (req.query.download) res.attachment(downloadName(v));
    res.sendFile(v.filename, { root: path.join(dataDir, "media") });
  });
  app.use("/api", (req, res) =>
    res.status(404).json({ error: "This endpoint could not be found." }),
  );
  app.use((err, req, res, next) => {
    if (req.file?.path && existsSync(req.file.path)) unlinkSync(req.file.path);
    const status =
      err.code === "LIMIT_FILE_SIZE"
        ? 413
        : err instanceof multer.MulterError
          ? 400
          : err.status || 500;
    if (status >= 500) console.error(err);
    if (!res.headersSent)
      res.status(status).json({
        ...(err.details || {}),
        error:
          status === 413
            ? "This video is over the 1 GB upload limit."
            : status >= 500
              ? "Something went wrong while saving. Please try again."
              : err.message,
      });
    else next(err);
  });
  return {
    app,
    db,
    studio,
    close: () => {
      studio.close();
      db.close();
    },
  };
}
