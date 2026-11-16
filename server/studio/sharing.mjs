import { randomBytes, randomUUID } from "node:crypto";
import path from "node:path";
import { existsSync } from "node:fs";
import { parseJSON, problem, mediaHeaders, downloadName } from "./schema.mjs";
import { passwordHash, passwordMatches } from "./auth.mjs";
import {
  captions,
  outputWords,
  getProject,
  publishedProject,
} from "./project.mjs";
const cookie = (req, name) =>
  req.headers.cookie
    ?.split(";")
    .map((p) => p.trim())
    .find((p) => p.startsWith(name + "="))
    ?.slice(name.length + 1);
export function registerSharing({
  app,
  db,
  dataDir,
  owner,
  admin,
  rateLimit,
  find,
  serialize,
}) {
  const config = (v) => ({
    access: "link",
    download: true,
    version: 0,
    ...parseJSON(v.share_config, {}),
  });
  const byToken = (token) => {
    const v = db.prepare("SELECT * FROM videos WHERE token=?").get(token);
    if (!v) throw problem(404, "This link is unavailable or has been revoked.");
    return v;
  };
  const guard = (req, v) => {
    const c = config(v);
    if (c.expiresAt && Date.parse(c.expiresAt) <= Date.now())
      throw problem(410, "This share link has expired.");
    const member = req.user,
      workspace = Boolean(member),
      invited = member && (c.invitedEmails || []).includes(member.email);
    if (c.access === "workspace" && !workspace)
      throw problem(401, "Sign in to this workspace to watch this video.", {
        details: { requiresLogin: true },
      });
    if (c.access === "invited" && !invited && member?.role !== "owner")
      throw problem(
        401,
        "This video is restricted to invited workspace members.",
        { details: { requiresLogin: true } },
      );
    if (c.passwordHash && member?.role !== "owner") {
      const grant = cookie(req, `relay_view_${v.token}`);
      const valid =
        grant &&
        db
          .prepare(
            "SELECT id FROM viewer_grants WHERE id=? AND token=? AND version=? AND expires>?",
          )
          .get(grant, v.token, c.version, Date.now());
      if (!valid)
        throw problem(401, "Enter this video’s password to continue.", {
          details: { requiresPassword: true },
        });
    }
    return c;
  };
  // Workspace-wide sharing choices made by the owner.
  const policy = () =>
    parseJSON(
      db.prepare("SELECT value FROM settings WHERE key='sharing'").get()?.value,
      {},
    );
  const shareData = (v) => {
    const result = serialize(v, true),
      c = config(v);
    delete result.project;
    return {
      ...result,
      downloadAllowed: c.download !== false,
      // The "Made with Relay" line, which the owner can turn off.
      credit: policy().credit !== false,
      // Who shared it, so viewers see a name rather than a placeholder.
      author: (() => {
        const name = db
          .prepare("SELECT name FROM members WHERE id='owner'")
          .get()?.name;
        return name && name !== "Workspace owner" ? name : "";
      })(),
      outline: (() => {
        const o = parseJSON(v.outline, {});
        return o.projectSegments ===
          JSON.stringify(publishedProject(v).segments)
          ? o
          : {};
      })(),
      transcript: outputWords(publishedProject(v), find),
      cta: publishedProject(v).cta || {},
    };
  };
  const notify = (videoId, kind, message, memberId = null) =>
    db
      .prepare("INSERT INTO notifications VALUES(?,?,?,?,?,0,?)")
      .run(
        randomUUID(),
        videoId,
        kind,
        message,
        memberId,
        new Date().toISOString(),
      );
  app.post("/api/videos/:id/share", owner, (req, res) => {
    const v = find(req.params.id);
    if (policy().publicLinks === false && req.user?.role !== "owner")
      throw problem(403, "Public sharing is disabled by your workspace owner.");
    if (!v.token)
      db.prepare("UPDATE videos SET token=? WHERE id=?").run(
        randomBytes(24).toString("base64url"),
        v.id,
      );
    res.json(serialize(find(v.id)));
  });
  app.put("/api/videos/:id/share-settings", owner, (req, res) => {
    const v = find(req.params.id),
      previous = config(v),
      b = req.body;
    if (!["link", "workspace", "invited"].includes(b.access || previous.access))
      throw problem(400, "Choose a supported access level.");
    if (b.expiresAt && !Number.isFinite(Date.parse(b.expiresAt)))
      throw problem(400, "Choose a valid expiration date.");
    const c = {
      ...previous,
      access: b.access || previous.access,
      download:
        b.download !== undefined ? Boolean(b.download) : previous.download,
      expiresAt:
        b.expiresAt === undefined ? previous.expiresAt : b.expiresAt || null,
      invitedEmails: Array.isArray(b.invitedEmails)
        ? b.invitedEmails
            .map((e) => String(e).trim().toLowerCase())
            .slice(0, 100)
        : previous.invitedEmails || [],
      version: previous.version + 1,
    };
    if (b.password !== undefined) {
      if (b.password && String(b.password).length < 6)
        throw problem(400, "Use a video password of at least six characters.");
      c.passwordHash = b.password ? passwordHash(String(b.password)) : null;
    }
    db.prepare("UPDATE videos SET share_config=? WHERE id=?").run(
      JSON.stringify(c),
      v.id,
    );
    res.json(serialize(find(v.id)));
  });
  app.delete("/api/videos/:id/share", owner, (req, res) => {
    const v = find(req.params.id);
    if (v.token)
      db.prepare("DELETE FROM viewer_grants WHERE token=?").run(v.token);
    db.prepare("UPDATE videos SET token=NULL WHERE id=?").run(v.id);
    res.json({ ok: true });
  });
  app.post("/api/share/:token/unlock", rateLimit, (req, res) => {
    const v = byToken(req.params.token),
      c = config(v);
    if (c.expiresAt && Date.parse(c.expiresAt) <= Date.now())
      throw problem(410, "This share link has expired.");
    if (
      !c.passwordHash ||
      !passwordMatches(req.body.password || "", c.passwordHash)
    )
      throw problem(401, "That video password does not match.");
    const id = randomBytes(32).toString("hex"),
      expires = Math.min(
        Date.now() + 86400000,
        c.expiresAt ? Date.parse(c.expiresAt) : Infinity,
      );
    db.prepare("INSERT INTO viewer_grants VALUES(?,?,?,?)").run(
      id,
      v.token,
      c.version,
      expires,
    );
    res.cookie(`relay_view_${v.token}`, id, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.PUBLIC_URL?.startsWith("https://") || false,
      maxAge: expires - Date.now(),
    });
    res.json({ ok: true });
  });
  app.get("/api/share/:token", (req, res) => {
    const v = byToken(req.params.token);
    guard(req, v);
    res.json(shareData(v));
  });
  app.get("/api/share/:token/media", (req, res) => {
    const v = byToken(req.params.token),
      c = guard(req, v);
    if (req.query.download && c.download === false)
      throw problem(403, "The owner has disabled downloads.");
    mediaHeaders(res, v.mime);
    if (req.query.download) res.attachment(downloadName(v));
    res.sendFile(v.filename, { root: path.join(dataDir, "media") });
  });
  app.get("/api/share/:token/captions.:format", (req, res) => {
    const v = byToken(req.params.token);
    guard(req, v);
    if (!["srt", "vtt"].includes(req.params.format))
      throw problem(404, "Caption format not found.");
    res
      .type(req.params.format === "vtt" ? "text/vtt" : "text/plain")
      .send(
        captions(outputWords(publishedProject(v), find), req.params.format),
      );
  });
  const stream = (req, res, v) => {
    const file = req.params.file;
    if (!/^(master|\d+p)\.m3u8$|^\d+p_\d+\.ts$/.test(file))
      throw problem(404, "Stream segment not found.");
    const root = path.join(dataDir, "media", "hls", v.id, String(v.revision));
    if (!existsSync(path.join(root, file)))
      throw problem(404, "The adaptive stream is not ready yet.");
    res.set("Cache-Control", "private, no-store");
    res.type(
      file.endsWith(".m3u8") ? "application/vnd.apple.mpegurl" : "video/mp2t",
    );
    res.sendFile(file, { root });
  };
  app.get("/api/share/:token/stream/:file", (req, res) => {
    const v = byToken(req.params.token);
    guard(req, v);
    stream(req, res, v);
  });
  app.get("/api/videos/:id/stream/:file", owner, (req, res) =>
    stream(req, res, find(req.params.id)),
  );
  app.post("/api/share/:token/view", rateLimit, (req, res) => {
    const v = byToken(req.params.token);
    guard(req, v);
    res.json({ ok: true, counted: false });
  });
  const merge = (intervals) => {
    const sorted = intervals.sort((a, b) => a[0] - b[0]),
      result = [];
    for (const range of sorted) {
      const tail = result.at(-1);
      if (tail && range[0] <= tail[1] + 0.15)
        tail[1] = Math.max(tail[1], range[1]);
      else result.push([...range]);
    }
    return result;
  };
  app.post("/api/share/:token/events", rateLimit, (req, res) => {
    const v = byToken(req.params.token);
    guard(req, v);
    const b = req.body;
    if (
      !/^[a-zA-Z0-9-]{12,80}$/.test(b.sessionId || "") ||
      !["play", "progress", "ended", "cta"].includes(b.event)
    )
      throw problem(400, "Invalid playback event.");
    if (req.user?.role === "owner") return res.json({ ok: true, owner: true });
    const old = db
        .prepare(
          "SELECT * FROM viewer_sessions WHERE video_id=? AND session_id=?",
        )
        .get(v.id, b.sessionId),
      intervals = parseJSON(old?.intervals, []);
    const from = Number(b.from),
      to = Number(b.to);
    if (["progress", "ended"].includes(b.event)) {
      if (
        !Number.isFinite(from) ||
        !Number.isFinite(to) ||
        from < 0 ||
        to > v.duration + 0.25 ||
        to < from ||
        to - from > 15.5
      )
        throw problem(
          400,
          "Playback intervals must represent at most 15 seconds.",
        );
      if (to > from) intervals.push([from, Math.min(v.duration, to)]);
    }
    const watched = merge(intervals).slice(0, 1000),
      seconds = watched.reduce((n, r) => n + r[1] - r[0], 0),
      qualified = seconds >= Math.min(5, v.duration * 0.75),
      time = new Date().toISOString();
    db.prepare(
      "INSERT INTO viewer_sessions VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(video_id,session_id) DO UPDATE SET intervals=excluded.intervals,qualified=excluded.qualified,plays=excluded.plays,cta=excluded.cta,updated=excluded.updated",
    ).run(
      v.id,
      b.sessionId,
      JSON.stringify(watched),
      Number(qualified),
      Number(old?.plays || 0) + (b.event === "play" ? 1 : 0),
      Number(old?.cta || 0) + (b.event === "cta" ? 1 : 0),
      req.user?.id || null,
      old?.created || time,
      time,
    );
    if (qualified && !old?.qualified) {
      db.prepare("UPDATE videos SET views=views+1 WHERE id=?").run(v.id);
      notify(v.id, "view", `Someone watched “${v.title}”.`);
    }
    res.json({ ok: true, qualified });
  });
  app.get("/api/videos/:id/analytics", owner, (req, res) => {
    const v = find(req.params.id),
      rows = db
        .prepare("SELECT * FROM viewer_sessions WHERE video_id=?")
        .all(v.id),
      qualified = rows.filter((r) => r.qualified),
      bins = Array.from({ length: 20 }, () => 0);
    let total = 0;
    for (const row of rows) {
      const intervals = parseJSON(row.intervals, []);
      total += intervals.reduce((n, r) => n + r[1] - r[0], 0);
      for (let i = 0; i < 20; i++) {
        const from = (i / 20) * v.duration,
          to = ((i + 1) / 20) * v.duration;
        if (intervals.some((r) => r[0] < to && r[1] > from)) bins[i]++;
      }
    }
    res.json({
      views: qualified.length,
      sessions: rows.length,
      averageCompletion: rows.length
        ? Math.min(1, total / (rows.length * v.duration))
        : 0,
      watchSeconds: total,
      ctaClicks: rows.reduce((n, r) => n + r.cta, 0),
      bins,
    });
  });
  const comment = (v, b, req) => {
    const author = String(req.user?.name || b.author || "")
        .trim()
        .slice(0, 60),
      body = String(b.body || "")
        .trim()
        .slice(0, 2000),
      time = Number(b.time);
    if (
      !author ||
      !body ||
      !Number.isFinite(time) ||
      time < 0 ||
      time > v.duration + 0.1
    )
      throw problem(400, "Add your name, comment and a valid timestamp.");
    let parent = null;
    if (b.parentId) {
      const row = db
        .prepare("SELECT id,parent_id FROM comments WHERE id=? AND video_id=?")
        .get(b.parentId, v.id);
      if (!row) throw problem(400, "The reply target was not found.");
      parent = row.parent_id || row.id;
    }
    const mentions = [
      ...body.matchAll(/@([a-zA-Z0-9_.+-]+(?:@[a-zA-Z0-9.-]+)?)/g),
    ].map((m) => m[1]);
    db.prepare(
      "INSERT INTO comments(id,video_id,author,body,time,created,parent_id,mentions,member_id) VALUES(?,?,?,?,?,?,?,?,?)",
    ).run(
      randomUUID(),
      v.id,
      author,
      body,
      time,
      new Date().toISOString(),
      parent,
      JSON.stringify(mentions),
      req.user?.id || null,
    );
    notify(v.id, "comment", `${author}: ${body.slice(0, 180)}`);
    for (const mention of mentions) {
      const m = db
        .prepare(
          "SELECT id FROM members WHERE lower(name)=? OR lower(email)=? OR lower(substr(email,1,instr(email,'@')-1))=?",
        )
        .get(
          mention.toLowerCase(),
          mention.toLowerCase(),
          mention.toLowerCase(),
        );
      if (m)
        notify(
          v.id,
          "mention",
          `${author} mentioned you in “${v.title}”.`,
          m.id,
        );
    }
  };
  app.post("/api/videos/:id/comments", owner, rateLimit, (req, res) => {
    const v = find(req.params.id);
    comment(v, req.body, req);
    res.status(201).json(serialize(v));
  });
  app.post("/api/share/:token/comments", rateLimit, (req, res) => {
    const v = byToken(req.params.token);
    guard(req, v);
    comment(v, req.body, req);
    res.status(201).json(shareData(v));
  });
  app.patch("/api/videos/:id/comments/:commentId", owner, (req, res) => {
    const v = find(req.params.id);
    const row = db
      .prepare("SELECT id,parent_id FROM comments WHERE id=? AND video_id=?")
      .get(req.params.commentId, v.id);
    if (!row) throw problem(404, "This thread was not found.");
    const root = row.parent_id || row.id;
    db.prepare(
      "UPDATE comments SET resolved=? WHERE (id=? OR parent_id=?) AND video_id=?",
    ).run(Number(Boolean(req.body.resolved)), root, root, v.id);
    res.json(serialize(v));
  });
  app.delete("/api/videos/:id/comments/:commentId", owner, (req, res) => {
    const v = find(req.params.id);
    db.prepare(
      "DELETE FROM comments WHERE (id=? OR parent_id=?) AND video_id=?",
    ).run(req.params.commentId, req.params.commentId, v.id);
    res.json(serialize(v));
  });
  app.post("/api/share/:token/reactions", rateLimit, (req, res) => {
    const v = byToken(req.params.token);
    guard(req, v);
    const emoji = req.body.emoji;
    if (!["❤️", "👏", "💡", "🎉"].includes(emoji))
      throw problem(400, "Choose a supported reaction.");
    db.prepare(
      "INSERT INTO reactions VALUES(?,?,1) ON CONFLICT(video_id,emoji) DO UPDATE SET count=count+1",
    ).run(v.id, emoji);
    res.json(shareData(find(v.id)));
  });
  app.get("/api/notifications", owner, (req, res) =>
    res.json(
      db
        .prepare(
          "SELECT * FROM notifications WHERE member_id IS NULL OR member_id=? ORDER BY created DESC LIMIT 100",
        )
        .all(req.user.id)
        .filter((n) => {
          if (req.user.role !== "viewer" || !n.video_id) return true;
          const c = parseJSON(
            db
              .prepare("SELECT share_config FROM videos WHERE id=?")
              .get(n.video_id)?.share_config,
            {},
          );
          return (
            c.access !== "invited" ||
            (c.invitedEmails || []).includes(req.user.email)
          );
        }),
    ),
  );
  app.post("/api/notifications/:id/read", owner, (req, res) => {
    if (req.params.id === "all")
      db.prepare(
        "UPDATE notifications SET seen=1 WHERE member_id IS NULL OR member_id=?",
      ).run(req.user.id);
    else
      db.prepare(
        "UPDATE notifications SET seen=1 WHERE id=? AND (member_id IS NULL OR member_id=?)",
      ).run(req.params.id, req.user.id);
    res.json({ ok: true });
  });
  app.get("/api/settings", owner, (req, res) =>
    res.json({
      sharing: parseJSON(
        db.prepare("SELECT value FROM settings WHERE key='sharing'").get()
          ?.value,
        { publicLinks: true, credit: true },
      ),
      ai: { local: true, ollamaConfigured: Boolean(process.env.OLLAMA_URL) },
      member: req.user
        ? {
            id: req.user.id,
            name: req.user.name,
            role: req.user.role,
            email: req.user.email,
          }
        : null,
    }),
  );
  app.put("/api/settings", admin, (req, res) => {
    db.prepare(
      "INSERT INTO settings VALUES('sharing',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
    ).run(
      JSON.stringify({
        publicLinks: req.body.sharing?.publicLinks !== false,
        credit: req.body.sharing?.credit !== false,
      }),
    );
    res.json({ ok: true });
  });
  return { guard, byToken, shareData, notify };
}
