// Links that work for anyone, in two halves.
//
// Receiving: any Relay server takes a finished video from a Relay app that holds its
// access key, and gives back a share link. Publishing the same video again replaces
// it, so the link keeps playing the latest version.
//
// Sending: a Relay app on someone's computer remembers one such server (their own,
// or a hosted one) and publishes videos to it.
import { openAsBlob, rmSync } from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";
import multer from "multer";
import { parseJSON, problem } from "./schema.mjs";
import { outputWords, publishedProject, transcriptWords } from "./project.mjs";

const LOCAL = ["localhost", "127.0.0.1", "[::1]"];
const GB = 1024 * 1024 * 1024;

export function registerCloud({
  app,
  db,
  dataDir,
  owner,
  admin,
  find,
  serialize,
  store,
  removeVideo,
  filesOf,
  discard,
  check,
}) {
  const setting = (key) =>
    db.prepare("SELECT value FROM settings WHERE key=?").get(key)?.value;
  const text = (value, max) =>
    String(value ?? "")
      .trim()
      .slice(0, max);

  // ---- Receiving ----------------------------------------------------------------
  const receive = multer({
    dest: path.join(dataDir, "tmp"),
    limits: { fileSize: GB, files: 1, fields: 8, fieldSize: 8 * 1024 * 1024 },
  });
  const bySource = (source) =>
    db.prepare("SELECT * FROM videos WHERE source_ref=?").get(source);
  const sourceId = (value) => {
    const source = text(value, 80);
    if (!/^[A-Za-z0-9-]{8,80}$/.test(source))
      throw problem(400, "A published video needs the id of its original.");
    return source;
  };
  // The address viewers will use: the configured one, or the one this request came to.
  const origin = (req) =>
    (process.env.PUBLIC_URL || `${req.protocol}://${req.get("host")}`).replace(
      /\/+$/,
      "",
    );
  app.get("/api/integration/workspace", check, (req, res) =>
    res.json({
      relay: true,
      name:
        db.prepare("SELECT name FROM members WHERE id='owner'").get()?.name ||
        "Relay",
    }),
  );
  app.post(
    "/api/integration/publish",
    check,
    receive.single("video"),
    async (req, res) => {
      let source;
      try {
        source = sourceId(req.body.source);
      } catch (e) {
        if (req.file) rmSync(req.file.path, { force: true });
        throw e;
      }
      const saved = await store(req.file, req.body);
      const file = path.join(dataDir, "media", saved.filename);
      let id, stale;
      try {
        const words = req.body.transcript
          ? transcriptWords(
              parseJSON(req.body.transcript, null),
              saved.duration,
            )
          : [];
        const description = text(req.body.description, 20000);
        const existing = bySource(source);
        if (existing) {
          // Same link, new version. A published copy is a finished file, so any
          // edit state it had here no longer applies.
          id = existing.id;
          const old = filesOf(existing);
          // Its source tracks and earlier renders describe the old file, so they go
          // in the same step as the switch to the new one.
          db.exec("BEGIN IMMEDIATE");
          try {
            for (const table of ["project_history", "assets", "versions"])
              db.prepare(`DELETE FROM ${table} WHERE video_id=?`).run(id);
            db.prepare(
              "UPDATE videos SET title=?,description=?,duration=?,size=?,mime=?,filename=?,thumbnail=?,transcript=?,outline='{}',project='{}',published_project='{}',history_cursor=0,revision=revision+1 WHERE id=?",
            ).run(
              saved.title,
              description,
              saved.duration,
              saved.size,
              saved.mime,
              saved.filename,
              saved.thumbnail,
              JSON.stringify(words),
              id,
            );
            db.exec("COMMIT");
          } catch (e) {
            db.exec("ROLLBACK");
            throw e;
          }
          stale = old;
        } else {
          id = saved.id;
          db.prepare(
            "INSERT INTO videos(id,title,description,duration,size,mime,filename,thumbnail,created,transcript,source_ref) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
          ).run(
            id,
            saved.title,
            description,
            saved.duration,
            saved.size,
            saved.mime,
            saved.filename,
            saved.thumbnail,
            new Date().toISOString(),
            JSON.stringify(words),
            source,
          );
        }
      } catch (e) {
        // The row still points at the old file, or was never written.
        rmSync(file, { force: true });
        throw e;
      }
      if (stale) {
        discard(stale);
        rmSync(path.join(dataDir, "media", "hls", id), {
          recursive: true,
          force: true,
        });
      }
      let v = find(id);
      if (!v.token) {
        db.prepare("UPDATE videos SET token=? WHERE id=?").run(
          randomBytes(24).toString("base64url"),
          id,
        );
        v = find(id);
      }
      res.status(201).json({
        id,
        url: `${origin(req)}/s/${v.token}`,
        revision: v.revision,
      });
    },
  );
  app.delete("/api/integration/publish/:source", check, (req, res) => {
    const v = bySource(sourceId(req.params.source));
    if (v) removeVideo(v);
    res.json({ ok: true });
  });

  // ---- Sending ------------------------------------------------------------------
  const server = () => {
    const c = parseJSON(setting("cloud"), null);
    return c?.url && c?.key ? c : null;
  };
  const describe = () => {
    const c = server();
    return c
      ? { connected: true, url: c.url, name: c.name }
      : { connected: false };
  };
  const address = (value) => {
    let url;
    try {
      url = new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`);
    } catch {
      throw problem(400, "Enter the server’s address, like relay.example.com.");
    }
    if (url.username || url.password)
      throw problem(400, "Leave any username or password out of the address.");
    if (url.protocol !== "https:" && !LOCAL.includes(url.hostname))
      throw problem(400, "The server’s address must start with https://.");
    return url.origin;
  };
  // One request to a connected server, with errors a person can act on.
  const call = async (c, route, init = {}, timeout = 15000) => {
    let response;
    try {
      response = await fetch(c.url + route, {
        ...init,
        headers: { ...init.headers, Authorization: `Bearer ${c.key}` },
        redirect: "error",
        signal: AbortSignal.timeout(timeout),
      });
    } catch {
      throw problem(502, "Couldn’t reach that server. Check the address.");
    }
    if (response.status === 401)
      throw problem(400, "That server didn’t accept the access key.");
    const body = await response.json().catch(() => null);
    if (!response.ok)
      throw problem(
        response.status === 413 ? 413 : 502,
        response.status === 413
          ? "This video is over the server’s 1 GB limit."
          : body?.error
            ? `The server said: ${text(body.error, 300)}`
            : "The server couldn’t take this video. Is it running Relay 0.7 or later?",
      );
    if (!body) throw problem(502, "No Relay server answered at that address.");
    return body;
  };
  app.get("/api/cloud", owner, (req, res) => res.json(describe()));
  app.put("/api/cloud", admin, async (req, res) => {
    const key = text(req.body.key, 200);
    if (key.length < 16) throw problem(400, "Paste the server’s access key.");
    const c = { url: address(text(req.body.url, 300)), key };
    const found = await call(c, "/api/integration/workspace");
    if (found.relay !== true)
      throw problem(502, "No Relay server answered at that address.");
    db.prepare(
      "INSERT INTO settings VALUES('cloud',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
    ).run(JSON.stringify({ ...c, name: text(found.name, 80) }));
    res.json(describe());
  });
  app.delete("/api/cloud", admin, (req, res) => {
    db.prepare("DELETE FROM settings WHERE key='cloud'").run();
    res.json(describe());
  });
  const sending = new Set();
  app.post("/api/videos/:id/cloud", owner, async (req, res) => {
    const v = find(req.params.id),
      c = server();
    if (!c) throw problem(409, "Connect a server in Settings first.");
    if (sending.has(v.id))
      throw problem(409, "This video is already being sent.");
    if (v.size > GB) throw problem(413, "This video is over the 1 GB limit.");
    sending.add(v.id);
    try {
      const form = new FormData();
      form.set("source", v.id);
      form.set("title", v.title);
      form.set("description", v.description || "");
      form.set("duration", String(v.duration));
      if (v.thumbnail) form.set("thumbnail", v.thumbnail);
      // What the finished file says, on its own timeline.
      const words = outputWords(publishedProject(v), find).map((w) => ({
        text: w.text,
        start: w.start,
        end: w.end,
        granularity: w.granularity,
      }));
      if (words.length) form.set("transcript", JSON.stringify(words));
      form.set(
        "video",
        await openAsBlob(path.join(dataDir, "media", v.filename), {
          type: v.mime,
        }),
        v.filename,
      );
      const sent = await call(
        c,
        "/api/integration/publish",
        { method: "POST", body: form },
        30 * 60 * 1000,
      );
      if (typeof sent.url !== "string" || !/^https?:\/\//.test(sent.url))
        throw problem(502, "The server didn’t return a link.");
      db.prepare("UPDATE videos SET cloud=? WHERE id=?").run(
        JSON.stringify({
          url: sent.url,
          revision: v.revision,
          at: new Date().toISOString(),
        }),
        v.id,
      );
      res.json(serialize(find(v.id)));
    } finally {
      sending.delete(v.id);
    }
  });
  app.delete("/api/videos/:id/cloud", owner, async (req, res) => {
    const v = find(req.params.id),
      c = server();
    if (!c) throw problem(409, "Connect a server in Settings first.");
    await call(c, `/api/integration/publish/${v.id}`, { method: "DELETE" });
    db.prepare("UPDATE videos SET cloud='{}' WHERE id=?").run(v.id);
    res.json(serialize(find(v.id)));
  });
}
