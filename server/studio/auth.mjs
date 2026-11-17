import {
  createHash,
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
export function createAuth({ app, db, password, rateLimit, limiter }) {
  const decoy = passwordHash("relay-decoy-password");
  const publicMember = (m) =>
    m && { id: m.id, email: m.email, name: m.name, role: m.role };
  const appliedPassword = () =>
    db
      .prepare("SELECT value FROM settings WHERE key='owner_password_from'")
      .get()?.value;
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
  } else if (password) {
    // ADMIN_PASSWORD is where the owner's password starts, and how it is set
    // again if it is forgotten: a new value there replaces whatever the owner
    // had. The same value as last time leaves a password the owner has since
    // chosen in Relay alone. Before Relay kept track, the two always matched.
    const applied = appliedPassword();
    if (!passwordMatches(password, applied || root.password)) {
      db.prepare("UPDATE members SET password=? WHERE id='owner'").run(
        passwordHash(password),
      );
      // A new ADMIN_PASSWORD signs the owner out wherever the old one was used.
      db.prepare("DELETE FROM member_sessions WHERE member_id='owner'").run();
    }
  }
  // Which ADMIN_PASSWORD has been applied is remembered as a hash, like any
  // other password.
  if (password && !passwordMatches(password, appliedPassword() || ""))
    db.prepare(
      "INSERT INTO settings VALUES('owner_password_from',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
    ).run(passwordHash(password));
  const attach = (req, res, next) => {
    const key = req.headers.cookie?.match(
      /(?:^|;\s*)relay_session=([a-f0-9]{64})(?:;|$)/,
    )?.[1];
    req.sessionKey = key;
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
        (req.method === "PUT" &&
          /^\/api\/(preferences|profile|password)$/.test(req.path))
      )
    )
      return res
        .status(403)
        .json({ error: "Your workspace role is view-only." });
    if (req.user.role === "viewer") {
      // Express decodes the :id in a route, so these checks read the path decoded too.
      let lower;
      try {
        lower = decodeURIComponent(req.path).toLowerCase();
      } catch {
        return res.status(400).json({ error: "That address isn’t valid." });
      }
      if (
        /^\/api\/(jobs|recordings)(\/|$)/.test(lower) ||
        /^\/api\/videos\/[^/]+\/(project(?:[/.]|$)|tracks(?:\/|$)|transcript(?:\/|$)|focus-suggestions|analytics)/.test(
          lower,
        )
      )
        return res.status(403).json({
          error:
            "Source footage and editing projects are restricted to workspace editors.",
        });
      // The id the route itself will use, when this is a route for one video.
      const id = /^\/api\/(?:videos|media)\//.test(lower)
        ? req.params?.id ||
          lower.match(
            /^\/api\/(?:videos|media)\/([a-f0-9-]{36})(?:[/.]|$)/,
          )?.[1]
        : null;
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
    // Always run the hash so response time doesn't reveal which emails exist.
    const matches = passwordMatches(
      String(req.body.password || ""),
      member?.password || decoy,
    );
    if (!member || !matches)
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
  // Every password a member chooses is held to the same rule.
  const chosen = (value) => {
    const text = String(value || "");
    if (text.length < 12)
      throw problem(400, "Use a password of at least 12 characters.");
    return text;
  };
  const changeable = () => {
    if (!password) throw problem(400, "This workspace doesn’t use passwords.");
  };
  // Stores a new password and signs the member out wherever the old one was
  // used, apart from `keep`, the session making the change. Reset links that
  // were waiting stop working too.
  const setPassword = (id, value, keep = "") => {
    const hash = passwordHash(value);
    db.exec("BEGIN IMMEDIATE");
    try {
      db.prepare("UPDATE members SET password=? WHERE id=?").run(hash, id);
      db.prepare("DELETE FROM member_sessions WHERE member_id=? AND id!=?").run(
        id,
        keep,
      );
      db.prepare("DELETE FROM password_resets WHERE member_id=?").run(id);
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  };
  app.put("/api/password", rateLimit, owner, (req, res) => {
    changeable();
    if (!passwordMatches(String(req.body.current || ""), req.user.password))
      throw problem(403, "That isn’t your current password.");
    setPassword(req.user.id, chosen(req.body.password), req.sessionKey || "");
    res.json({ ok: true });
  });
  // A member who forgot their password gets a link from the owner, since a
  // self-hosted server has no email to send one. Only a hash of the link is
  // kept, and the link is looked up by that hash, so neither a copy of the
  // database nor the time a lookup takes gives a working link away.
  const digest = (token) =>
    createHash("sha256").update(String(token)).digest("hex");
  app.post("/api/team/:id/password-reset", admin, (req, res) => {
    const member = db
      .prepare("SELECT id FROM members WHERE id=?")
      .get(req.params.id);
    if (!member) throw problem(404, "That person isn’t in this workspace.");
    changeable();
    // Only the owner makes reset links, and an owner who can sign in to make
    // one can change their password in Settings. One who can't sets a new
    // ADMIN_PASSWORD on the server, which needs no link.
    if (member.id === "owner")
      throw problem(
        400,
        "Change your own password in Settings. If you have forgotten it, set a new ADMIN_PASSWORD on the server and restart Relay.",
      );
    const token = randomBytes(32).toString("base64url"),
      expires = Date.now() + 86400000;
    // A new link replaces the one sent before. Expired ones are cleared as well.
    db.prepare(
      "DELETE FROM password_resets WHERE member_id=? OR expires<?",
    ).run(member.id, Date.now());
    db.prepare("INSERT INTO password_resets VALUES(?,?,?)").run(
      digest(token),
      member.id,
      expires,
    );
    res.status(201).json({ token, expires });
  });
  // Guesses from one address are counted together, whichever link they name.
  const resetLimit = limiter(10, undefined, (req) => req.route.path);
  const resetFor = (token) => {
    const member = db
      .prepare(
        "SELECT m.id,m.name,m.email FROM password_resets r JOIN members m ON m.id=r.member_id WHERE r.token_hash=? AND r.expires>?",
      )
      .get(digest(token), Date.now());
    // One answer for a link that never existed, has expired or was used.
    if (!member)
      throw problem(
        404,
        "This reset link has expired or was already used. Ask the workspace owner for a new one.",
      );
    return member;
  };
  app.get("/api/password-resets/:token", resetLimit, (req, res) => {
    const member = resetFor(req.params.token);
    res.json({ name: member.name, email: member.email });
  });
  app.post("/api/password-resets/:token", resetLimit, (req, res) => {
    const member = resetFor(req.params.token);
    setPassword(member.id, chosen(req.body.password));
    res.json({ ok: true });
  });
  // Per-member studio preferences live with the library, not in browser storage,
  // so onboarding and recorder defaults survive origin or port changes.
  const preferenceRules = {
    onboarded: (v) => typeof v === "boolean",
    onboardingStep: (v) => typeof v === "string" && v.length <= 40,
    afterRecording: (v) => ["copy-link", "open-editor"].includes(v),
    countdown: (v) => [0, 3, 5].includes(v),
    hideWindow: (v) => typeof v === "boolean",
    keyShortcuts: (v) => typeof v === "boolean",
    bubble: (v) => typeof v === "boolean",
    bubbleSize: (v) => ["s", "m", "l"].includes(v),
    quality: (v) => [1280, 1920, 3840].includes(v),
    mode: (v) => ["screen-camera", "screen", "camera"].includes(v),
    microphoneId: (v) => typeof v === "string" && v.length <= 300,
    cameraId: (v) => typeof v === "string" && v.length <= 300,
    systemAudio: (v) => typeof v === "boolean",
    autoZoom: (v) => typeof v === "boolean",
    cameraFilter: (v) =>
      ["none", "vivid", "warm", "cool", "mono", "film", "soft"].includes(v),
    cameraBackground: (v) =>
      typeof v === "string" &&
      /^(none|blur|pine|dusk|studio|sunrise|custom|#[0-9a-f]{6})$/i.test(v),
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
      // How this member's password is looked after: there is none ("none", a
      // workspace without passwords), it is theirs to change and the owner can
      // reset it ("own"), or it is theirs to change and the server's settings
      // reset it ("server", the owner).
      password: !password ? "none" : req.user.id === "owner" ? "server" : "own",
      members: db
        .prepare(
          "SELECT id,email,name,role,created FROM members ORDER BY created",
        )
        .all(),
      invitations:
        req.user.role === "owner"
          ? db
              .prepare(
                "SELECT token AS id,email,name,role,expires FROM invitations WHERE accepted=0 AND expires>?",
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
    // Inviting someone again replaces the link they were sent before.
    db.prepare("DELETE FROM invitations WHERE email=? AND accepted=0").run(
      email,
    );
    // Only a hash of the link is kept, as for a password reset: the link is
    // shown to the owner once, here, and a copy of the database gives none away.
    db.prepare("INSERT INTO invitations VALUES(?,?,?,?,?,0)").run(
      digest(token),
      email,
      name,
      role,
      expires,
    );
    res.status(201).json({ token, email, name, role, expires });
  });
  // Revoked by the name the owner's list knows it by, which is not the link.
  app.delete("/api/team/invitations/:id", admin, (req, res) => {
    db.prepare("DELETE FROM invitations WHERE token=?").run(req.params.id);
    res.json({ ok: true });
  });
  const invitation = (token) => {
    const row = db
      .prepare(
        "SELECT * FROM invitations WHERE token=? AND expires>? AND accepted=0",
      )
      .get(digest(token), Date.now());
    if (!row)
      throw problem(404, "This invitation has expired or was already used.");
    return row;
  };
  // Guesses from one address are counted together, whichever link they name.
  const inviteLimit = limiter(10, undefined, (req) => req.route.path);
  app.get("/api/invitations/:token", inviteLimit, (req, res) => {
    const row = invitation(req.params.token);
    res.json({ email: row.email, name: row.name, role: row.role });
  });
  app.post("/api/invitations/:token/accept", inviteLimit, (req, res) => {
    const row = invitation(req.params.token),
      value = chosen(req.body.password);
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
      throw /UNIQUE constraint/.test(e.message)
        ? problem(409, "That person is already in this workspace.")
        : e;
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
