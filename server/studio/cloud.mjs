// Links that work for anyone, in two halves.
//
// Receiving: any Relay server takes a finished video from a Relay app that holds its
// access key, and gives back a share link. Publishing the same video again replaces
// it, so the link keeps playing the latest version.
//
// Sending: a Relay app on someone's computer remembers one such server (their own,
// or a hosted one) and publishes videos to it.
import { openAsBlob, rmSync } from "node:fs";
import { randomBytes, timingSafeEqual } from "node:crypto";
import path from "node:path";
import multer from "multer";
import { parseJSON, problem } from "./schema.mjs";
import { outputWords, publishedProject, transcriptWords } from "./project.mjs";
import { sharingConfig, updatedSharingConfig } from "./sharing.mjs";

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

  db.prepare(
    "INSERT OR IGNORE INTO settings(key,value) VALUES('publishingToken',?)",
  ).run(randomBytes(32).toString("hex"));
  // A device connection can publish its finished videos without access to the
  // workspace library or editing API. Existing integration keys keep working.
  const sharingKeyMatches = (req) => {
    const given = Buffer.from(
      String(req.get("authorization") || "").replace(/^Bearer /, ""),
    );
    const expected = Buffer.from(setting("publishingToken") || "");
    return (
      expected.length > 0 &&
      given.length === expected.length &&
      timingSafeEqual(given, expected)
    );
  };
  const publishCheck = (req, res, next) => {
    if (sharingKeyMatches(req)) {
      req.relayKeyScope = "sharing";
      return next();
    }
    req.relayKeyScope = "workspace";
    return check(req, res, next);
  };
  app.get("/api/cloud/key", admin, (req, res) =>
    res.json({ key: setting("publishingToken") }),
  );
  app.post("/api/cloud/key/reset", admin, (req, res) => {
    db.prepare("UPDATE settings SET value=? WHERE key='publishingToken'").run(
      randomBytes(32).toString("hex"),
    );
    res.json({ ok: true });
  });
  const visibility = (v) => {
    const c = sharingConfig(v);
    return {
      access: c.access,
      download: c.download !== false,
      expiresAt: c.expiresAt || null,
      hasPassword: Boolean(c.passwordHash),
    };
  };

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
  app.get("/api/integration/workspace", publishCheck, (req, res) =>
    res.json({
      relay: true,
      publicUrl: origin(req),
      privacySupported: true,
      publicLinksAllowed:
        parseJSON(setting("sharing"), {}).publicLinks !== false,
      keyScope: req.relayKeyScope,
      name:
        db.prepare("SELECT name FROM members WHERE id='owner'").get()?.name ||
        "Relay",
    }),
  );
  app.post(
    "/api/integration/publish",
    publishCheck,
    receive.single("video"),
    async (req, res) => {
      let source, requested;
      try {
        source = sourceId(req.body.source);
        if (req.body.sharing !== undefined) {
          requested = parseJSON(req.body.sharing, null);
          if (
            !requested ||
            typeof requested !== "object" ||
            Array.isArray(requested)
          )
            throw problem(
              400,
              "Choose who can watch before sharing this video.",
            );
          updatedSharingConfig(
            sharingConfig(bySource(source) || {}),
            requested,
            12,
          );
        }
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
        db.exec("BEGIN IMMEDIATE");
        try {
          if (req.relayKeyScope === "sharing" && !sharingKeyMatches(req))
            throw problem(
              401,
              "The workspace connection key changed. Reconnect with the new key.",
            );
          const existing = bySource(source);
          const share = requested
            ? updatedSharingConfig(sharingConfig(existing || {}), requested, 12)
            : sharingConfig(existing || {});
          if (
            parseJSON(setting("sharing"), {}).publicLinks === false &&
            share.access === "link"
          )
            throw problem(
              403,
              "Your workspace only allows sharing with signed-in members.",
            );
          if (existing) {
            // Same link, new version. A published copy is a finished file, so any
            // edit state it had here no longer applies.
            id = existing.id;
            const old = filesOf(existing);
            // Its source tracks and earlier renders describe the old file, so they go
            // in the same step as the switch to the new one.
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
            db.prepare("UPDATE videos SET share_config=? WHERE id=?").run(
              JSON.stringify(share),
              id,
            );
            stale = old;
          } else {
            id = saved.id;
            db.prepare(
              "INSERT INTO videos(id,title,description,duration,size,mime,filename,thumbnail,created,transcript,source_ref,share_config) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
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
              JSON.stringify(share),
            );
          }
          db.exec("COMMIT");
        } catch (e) {
          db.exec("ROLLBACK");
          throw e;
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
        share: visibility(v),
        manageUrl: `${origin(req)}/video/${v.id}`,
      });
    },
  );
  app.get("/api/integration/publish/:source", publishCheck, (req, res) => {
    const v = bySource(sourceId(req.params.source));
    if (!v || !v.token)
      throw problem(
        404,
        "This shared copy is unavailable. It may have been removed.",
      );
    res.json({
      url: `${origin(req)}/s/${v.token}`,
      share: visibility(v),
      manageUrl: `${origin(req)}/video/${v.id}`,
    });
  });
  app.delete("/api/integration/publish/:source", publishCheck, (req, res) => {
    const v = bySource(sourceId(req.params.source));
    if (v) removeVideo(v);
    res.json({ ok: true });
  });

  // ---- Sending ------------------------------------------------------------------
  const server = () => {
    const c = parseJSON(setting("cloud"), null);
    return c?.url && c?.key ? c : null;
  };
  const describe = (c = server()) => {
    return c
      ? {
          connected: true,
          url: c.url,
          name: c.name,
          privacySupported: c.privacySupported === true,
          publicLinksAllowed: c.publicLinksAllowed !== false,
          keyScope: c.keyScope,
        }
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
    if (
      !["https:", "http:"].includes(url.protocol) ||
      (url.protocol === "http:" && !LOCAL.includes(url.hostname))
    )
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
    if (!response.ok) {
      const messages = {
        400: "The workspace rejected these video or sharing details. Review the options and try again.",
        403: "Workspace permissions prevent this sharing option. Ask its owner for help.",
        404: "This shared copy is unavailable. It may have been removed.",
        409: "This video is being updated. Wait a moment and try again.",
        413: "This video is over the workspace’s 1 GB limit.",
      };
      throw problem(
        messages[response.status] ? response.status : 502,
        messages[response.status] ||
          "The workspace couldn’t complete this request. Ask its administrator to check it.",
      );
    }
    if (!body) throw problem(502, "No Relay server answered at that address.");
    return body;
  };
  const checkAddress = (found, c) => {
    let publicUrl;
    try {
      publicUrl = found.publicUrl ? new URL(found.publicUrl) : null;
    } catch {
      throw problem(
        400,
        "The workspace returned an invalid public address. Ask its administrator to check its setup.",
      );
    }
    if (
      publicUrl &&
      (publicUrl.origin !== c.url || publicUrl.username || publicUrl.password)
    )
      throw problem(
        400,
        "The workspace’s public address differs from this address. Ask its administrator for the address viewers should use.",
      );
  };
  app.get("/api/cloud", owner, async (req, res) => {
    const c = server();
    if (!c) return res.json({ connected: false });
    try {
      const found = await call(c, "/api/integration/workspace");
      checkAddress(found, c);
      res.json({
        ...describe(c),
        privacySupported: found.privacySupported === true,
        publicLinksAllowed: found.publicLinksAllowed !== false,
        keyScope: found.keyScope === "sharing" ? "sharing" : "workspace",
        reachable: true,
      });
    } catch (e) {
      res.json({ ...describe(c), reachable: false, error: e.message });
    }
  });
  app.put("/api/cloud", admin, async (req, res) => {
    if (sending.size)
      throw problem(
        409,
        "Wait for the current video upload to finish before changing workspaces.",
      );
    const key = text(req.body.key, 200);
    if (key.length < 16) throw problem(400, "Paste the server’s access key.");
    const c = { url: address(text(req.body.url, 300)), key };
    const found = await call(c, "/api/integration/workspace");
    if (found.relay !== true)
      throw problem(502, "No Relay server answered at that address.");
    checkAddress(found, c);
    if (sending.size)
      throw problem(
        409,
        "Wait for the current upload to finish before changing workspaces.",
      );
    db.prepare(
      "INSERT INTO settings VALUES('cloud',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
    ).run(
      JSON.stringify({
        ...c,
        name: text(found.name, 80),
        privacySupported: found.privacySupported === true,
        publicLinksAllowed: found.publicLinksAllowed !== false,
        keyScope: found.keyScope === "sharing" ? "sharing" : "workspace",
      }),
    );
    res.json(describe());
  });
  app.delete("/api/cloud", admin, (req, res) => {
    if (sending.size)
      throw problem(
        409,
        "Wait for the current video upload to finish before disconnecting.",
      );
    db.prepare("DELETE FROM settings WHERE key='cloud'").run();
    res.json(describe());
  });
  const sending = new Set();
  const connectedFor = (v) => {
    const c = server();
    if (!c)
      throw problem(409, "Connect your online workspace in Settings first.");
    const published = parseJSON(v.cloud, {});
    if (published.url && new URL(published.url).origin !== c.url)
      throw problem(
        409,
        `Reconnect to ${new URL(published.url).origin} to manage this shared copy.`,
      );
    return c;
  };
  const linkDetails = (sent, c) => {
    let url;
    try {
      url = new URL(sent.url);
    } catch {
      throw problem(
        502,
        "The workspace returned an unreadable link. Ask its administrator to check its public address.",
      );
    }
    if (
      url.origin !== c.url ||
      url.username ||
      url.password ||
      !/^\/s\/[A-Za-z0-9_-]+$/.test(url.pathname) ||
      url.search ||
      url.hash
    )
      throw problem(
        502,
        "The workspace returned an unexpected link. Ask its administrator to check its public address.",
      );
    let manageUrl;
    if (sent.manageUrl) {
      let manage;
      try {
        manage = new URL(sent.manageUrl);
      } catch {
        manage = null;
      }
      if (
        manage &&
        manage.origin === c.url &&
        /^\/video\/[A-Za-z0-9-]+$/.test(manage.pathname) &&
        !manage.username &&
        !manage.password &&
        !manage.search &&
        !manage.hash
      )
        manageUrl = manage.href;
    }
    const s = sent.share;
    const share =
      s && ["link", "workspace", "invited"].includes(s.access)
        ? {
            access: s.access,
            download: s.download === true,
            expiresAt: s.expiresAt || null,
            hasPassword: s.hasPassword === true,
          }
        : undefined;
    return { url: url.href, manageUrl, share };
  };
  app.get("/api/videos/:id/cloud", owner, async (req, res) => {
    const v = find(req.params.id),
      c = connectedFor(v);
    const sent = await call(c, `/api/integration/publish/${v.id}`);
    const details = linkDetails(sent, c);
    const previous = parseJSON(v.cloud, {});
    if (previous.unverified)
      db.prepare("UPDATE videos SET cloud=? WHERE id=? AND cloud=?").run(
        JSON.stringify({ ...previous, ...details, unverified: false }),
        v.id,
        v.cloud,
      );
    res.json(details);
  });
  app.post("/api/videos/:id/cloud", owner, async (req, res) => {
    const v = find(req.params.id),
      c = connectedFor(v);
    if (req.body.workspaceUrl !== undefined && req.body.workspaceUrl !== c.url)
      throw problem(
        409,
        "The connected workspace changed. Reopen Send and review the destination before uploading.",
      );
    if (sending.has(v.id))
      throw problem(409, "This video is already being sent.");
    if (v.size > GB) throw problem(413, "This video is over the 1 GB limit.");
    sending.add(v.id);
    try {
      const capabilities = await call(c, "/api/integration/workspace");
      checkAddress(capabilities, c);
      if (req.body.sharing !== undefined) {
        if (capabilities.privacySupported !== true)
          throw problem(
            409,
            "Ask the workspace administrator to update Relay before choosing who can watch from this app.",
          );
        updatedSharingConfig(sharingConfig({}), req.body.sharing, 12);
        if (
          capabilities.publicLinksAllowed === false &&
          req.body.sharing.access !== "workspace" &&
          req.body.sharing.access !== "invited"
        )
          throw problem(
            403,
            "Your workspace only allows sharing with signed-in members.",
          );
      }
      const form = new FormData();
      if (req.body.sharing !== undefined)
        form.set("sharing", JSON.stringify(req.body.sharing));
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
      // Keep the destination if a dropped connection leaves the upload uncertain.
      if (!parseJSON(v.cloud, {}).url)
        db.prepare("UPDATE videos SET cloud=? WHERE id=?").run(
          JSON.stringify({
            url: c.url,
            unverified: true,
            revision: v.revision,
            at: new Date().toISOString(),
          }),
          v.id,
        );
      const sent = await call(
        c,
        "/api/integration/publish",
        { method: "POST", body: form },
        30 * 60 * 1000,
      );
      const details = linkDetails(sent, c);
      db.prepare("UPDATE videos SET cloud=? WHERE id=?").run(
        JSON.stringify({
          ...details,
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
      c = connectedFor(v);
    if (sending.has(v.id))
      throw problem(
        409,
        "Wait for this video upload to finish before stopping sharing.",
      );
    sending.add(v.id);
    try {
      const removed = await call(c, `/api/integration/publish/${v.id}`, {
        method: "DELETE",
      });
      if (removed.ok !== true)
        throw problem(
          502,
          "The workspace did not confirm removal. Check the shared copy in your online workspace.",
        );
      db.prepare("UPDATE videos SET cloud='{}' WHERE id=?").run(v.id);
      res.json(serialize(find(v.id)));
    } finally {
      sending.delete(v.id);
    }
  });
}
