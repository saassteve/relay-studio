import {
  randomBytes,
  randomUUID,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";
import { problem, parseJSON } from "./schema.mjs";
export const passwordHash = (value) => {
  const salt = randomBytes(16).toString("hex");
  return `${salt}:${scryptSync(value, salt, 32).toString("hex")}`;
};
export function passwordMatches(value, stored) {
  try {
    const [salt, key] = stored.split(":");
    return timingSafeEqual(
      scryptSync(String(value), salt, 32),
      Buffer.from(key, "hex"),
    );
  } catch {
    return false;
  }
}
export function createAuth({ app, db, password, rateLimit }) {
  const publicMember = (m) =>
    m && { id: m.id, email: m.email, name: m.name, role: m.role };
  let root = db.prepare("SELECT * FROM members WHERE id='owner'").get();
  if (!root) {
    db.prepare("INSERT INTO members VALUES(?,?,?,?,?,?)").run(
      "owner",
      (process.env.ADMIN_EMAIL || "owner@relay.local").trim().toLowerCase(),
      "Workspace owner",
      "owner",
      passwordHash(password),
      new Date().toISOString(),
    );
    root = db.prepare("SELECT * FROM members WHERE id='owner'").get();
  } else if (password && !passwordMatches(password, root.password))
    db.prepare("UPDATE members SET password=? WHERE id='owner'").run(
      passwordHash(password),
    );
  const attach = (req, res, next) => {
    const key = req.headers.cookie?.match(
      /(?:^|;\s*)relay_session=([a-f0-9]{64})(?:;|$)/,
    )?.[1];
    req.user = key
      ? db
          .prepare(
            "SELECT m.* FROM members m JOIN member_sessions s ON s.member_id=m.id WHERE s.id=? AND s.expires>?",
          )
          .get(key, Date.now())
      : null;
    next();
  };
  app.use(attach);
  const owner = (req, res, next) => {
    if (!req.user && !password)
      req.user = db.prepare("SELECT * FROM members WHERE id='owner'").get();
    if (!req.user)
      return res
        .status(401)
        .json({ error: "Unlock your workspace to continue." });
    if (
      req.user.role === "viewer" &&
      !["GET", "HEAD", "OPTIONS"].includes(req.method) &&
      !(
        (req.method === "POST" &&
          /^\/api\/notifications\/[^/]+\/read$/.test(req.path)) ||
        (req.method === "PUT" && /^\/api\/(preferences|profile)$/.test(req.path))
      )
    )
      return res
        .status(403)
        .json({ error: "Your workspace role is view-only." });
    if (req.user.role === "viewer") {
      if (
        /^\/api\/(jobs|recordings)(\/|$)/.test(req.path) ||
        /^\/api\/videos\/[^/]+\/(project(?:[/.]|$)|tracks(?:\/|$)|transcript(?:\/|$)|focus-suggestions)/.test(
          req.path,
        )
      )
        return res
          .status(403)
          .json({
            error:
              "Source footage and editing projects are restricted to workspace editors.",
          });
      const id = req.path.match(
        /^\/api\/(?:videos|media)\/([a-f0-9-]{36})(?:[/.]|$)/,
      )?.[1];
      const row =
          id &&
          db.prepare("SELECT share_config FROM videos WHERE id=?").get(id),
        c = parseJSON(row?.share_config, {});
      if (req.query.download && c.download === false)
        return res
          .status(403)
          .json({ error: "The owner has disabled downloads." });
      if (
        c.access === "invited" &&
        !(c.invitedEmails || []).includes(req.user.email)
      )
        return res
          .status(403)
          .json({ error: "This recording is restricted to invited members." });
    }
    next();
  };
  const admin = (req, res, next) =>
    owner(req, res, () =>
      req.user.role === "owner"
        ? next()
        : res.status(403).json({
            error: "Only the workspace owner can change this setting.",
          }),
    );
  const login = (res, id) => {
    db.prepare("DELETE FROM member_sessions WHERE expires<?").run(Date.now());
    const key = randomBytes(32).toString("hex");
    db.prepare("INSERT INTO member_sessions VALUES(?,?,?)").run(
      key,
      id,
      Date.now() + 7 * 86400000,
    );
    res.cookie("relay_session", key, {
      httpOnly: true,
      sameSite: "strict",
      secure: process.env.PUBLIC_URL?.startsWith("https://") || false,
      maxAge: 7 * 86400000,
    });
  };
  app.get("/api/session", (req, res) =>
    res.json({
      unlocked: !password || Boolean(req.user),
      protected: Boolean(password),
      member: publicMember(req.user || (!password ? root : null)),
    }),
  );
  app.post("/api/session", rateLimit, (req, res) => {
    const email = String(req.body.email || root.email)
      .trim()
      .toLowerCase();
    const member = db.prepare("SELECT * FROM members WHERE email=?").get(email);
    if (
      !member ||
      !passwordMatches(String(req.body.password || ""), member.password)
    )
      throw problem(401, "That email and password don’t match.");
    login(res, member.id);
    res.json({ unlocked: true, member: publicMember(member) });
  });
  app.delete("/api/session", (req, res) => {
    const key = req.headers.cookie?.match(/relay_session=([a-f0-9]{64})/)?.[1];
    if (key) db.prepare("DELETE FROM member_sessions WHERE id=?").run(key);
    res.clearCookie("relay_session");
    res.json({ ok: true });
  });
  app.put("/api/profile", owner, (req, res) => {
    const name = String(req.body.name || "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 80);
    if (!name) throw problem(400, "Add a name so people know who’s talking.");
    db.prepare("UPDATE members SET name=? WHERE id=?").run(name, req.user.id);
    if (req.user.id === "owner")
      root = db.prepare("SELECT * FROM members WHERE id='owner'").get();
    res.json({
      member: publicMember(
        db.prepare("SELECT * FROM members WHERE id=?").get(req.user.id),
      ),
    });
  });
  // Per-member studio preferences live with the library, not in browser storage,
  // so onboarding and recorder defaults survive origin or port changes.
  const preferenceRules = {
    onboarded: (v) => typeof v === "boolean",
    onboardingStep: (v) => typeof v === "string" && v.length <= 40,
    afterRecording: (v) => ["copy-link", "open-editor"].includes(v),
    countdown: (v) => [0, 3, 5].includes(v),
    hideWindow: (v) => typeof v === "boolean",
    bubble: (v) => typeof v === "boolean",
    bubbleSize: (v) => ["s", "m", "l"].includes(v),
    quality: (v) => [1280, 1920, 3840].includes(v),
    mode: (v) => ["screen-camera", "screen", "camera"].includes(v),
    microphoneId: (v) => typeof v === "string" && v.length <= 300,
    cameraId: (v) => typeof v === "string" && v.length <= 300,
    systemAudio: (v) => typeof v === "boolean",
  };
  const readPreferences = (id) =>
    parseJSON(
      db.prepare("SELECT value FROM settings WHERE key=?").get(`prefs:${id}`)
        ?.value,
      {},
    );
  app.get("/api/preferences", owner, (req, res) =>
    res.json(readPreferences(req.user.id)),
  );
  app.put("/api/preferences", owner, (req, res) => {
    const next = { ...readPreferences(req.user.id) };
    for (const [key, value] of Object.entries(req.body || {})) {
      const valid = preferenceRules[key];
      if (!valid) continue;
      if (value === null) delete next[key];
      else if (valid(value)) next[key] = value;
      else throw problem(400, `That ${key} preference isn’t supported.`);
    }
    db.prepare(
      "INSERT INTO settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
    ).run(`prefs:${req.user.id}`, JSON.stringify(next));
    res.json(next);
  });
  app.get("/api/team", owner, (req, res) =>
    res.json({
      member: publicMember(req.user),
      members: db
        .prepare(
          "SELECT id,email,name,role,created FROM members ORDER BY created",
        )
        .all(),
      invitations:
        req.user.role === "owner"
          ? db
              .prepare(
                "SELECT token,email,name,role,expires FROM invitations WHERE accepted=0 AND expires>?",
              )
              .all(Date.now())
          : [],
    }),
  );
  app.post("/api/team/invitations", admin, (req, res) => {
    const email = String(req.body.email || "")
        .trim()
        .toLowerCase(),
      name = String(req.body.name || email)
        .trim()
        .slice(0, 60),
      role = req.body.role;
    if (!/^\S+@\S+\.\S+$/.test(email) || !["editor", "viewer"].includes(role))
      throw problem(400, "Add a valid email and choose editor or viewer.");
    if (db.prepare("SELECT id FROM members WHERE email=?").get(email))
      throw problem(409, "That person is already in this workspace.");
    const token = randomBytes(24).toString("base64url"),
      expires = Date.now() + 7 * 86400000;
    db.prepare("INSERT INTO invitations VALUES(?,?,?,?,?,0)").run(
      token,
      email,
      name,
      role,
      expires,
    );
    res.status(201).json({ token, email, name, role, expires });
  });
  app.delete("/api/team/invitations/:token", admin, (req, res) => {
    db.prepare("DELETE FROM invitations WHERE token=?").run(req.params.token);
    res.json({ ok: true });
  });
  const invitation = (token) => {
    const row = db
      .prepare(
        "SELECT * FROM invitations WHERE token=? AND expires>? AND accepted=0",
      )
      .get(token, Date.now());
    if (!row)
      throw problem(404, "This invitation has expired or was already used.");
    return row;
  };
  app.get("/api/invitations/:token", (req, res) => {
    const row = invitation(req.params.token);
    res.json({ email: row.email, name: row.name, role: row.role });
  });
  app.post("/api/invitations/:token/accept", rateLimit, (req, res) => {
    const row = invitation(req.params.token),
      value = String(req.body.password || "");
    if (value.length < 12)
      throw problem(400, "Use a password of at least 12 characters.");
    const id = randomUUID();
    db.exec("BEGIN IMMEDIATE");
    try {
      db.prepare("INSERT INTO members VALUES(?,?,?,?,?,?)").run(
        id,
        row.email,
        row.name,
        row.role,
        passwordHash(value),
        new Date().toISOString(),
      );
      db.prepare("UPDATE invitations SET accepted=1 WHERE token=?").run(
        row.token,
      );
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
    login(res, id);
    res.status(201).json({
      member: publicMember(
        db.prepare("SELECT * FROM members WHERE id=?").get(id),
      ),
    });
  });
  app.patch("/api/team/:id", admin, (req, res) => {
    if (req.params.id === "owner")
      throw problem(400, "The owner role cannot be changed.");
    if (!["editor", "viewer"].includes(req.body.role))
      throw problem(400, "Choose editor or viewer.");
    db.prepare("UPDATE members SET role=? WHERE id=?").run(
      req.body.role,
      req.params.id,
    );
    res.json({ ok: true });
  });
  app.delete("/api/team/:id", admin, (req, res) => {
    if (req.params.id === "owner")
      throw problem(400, "The workspace owner cannot be removed.");
    db.prepare("DELETE FROM members WHERE id=?").run(req.params.id);
    res.json({ ok: true });
  });
  return { owner, admin, publicMember };
}
