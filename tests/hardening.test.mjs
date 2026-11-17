import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createApp, trustProxy } from "../server/app.mjs";
import { passwordHash } from "../server/studio/auth.mjs";
import { parseCaptions } from "../server/studio/project.mjs";

// A password-protected workspace with an owner, an editor and a viewer.
async function workspace(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "relay-hardening-"));
  const { app, db, close } = createApp({
    dataDir: dir,
    password: "owner-password-123",
  });
  const now = new Date().toISOString();
  for (const [id, role] of [
    ["v1", "viewer"],
    ["e1", "editor"],
  ])
    db.prepare("INSERT INTO members VALUES(?,?,?,?,?,?)").run(
      id,
      `${role}@example.com`,
      role,
      role,
      passwordHash(`${role}-password-1`),
      now,
    );
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    await new Promise((r) => server.close(r));
    close();
    rmSync(dir, { recursive: true, force: true });
  });
  const login = async (role) =>
    (
      await fetch(`${base}/api/session`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          role === "owner"
            ? { password: "owner-password-123" }
            : { email: `${role}@example.com`, password: `${role}-password-1` },
        ),
      })
    ).headers
      .get("set-cookie")
      .split(";")[0];
  // A library row without a file behind it, which is all these checks need.
  const video = (id, { token = null, share = {} } = {}) =>
    db
      .prepare(
        "INSERT INTO videos(id,title,duration,size,mime,filename,created,token,share_config) VALUES(?,?,?,?,?,?,?,?,?)",
      )
      .run(
        id,
        "Roadmap",
        10,
        1,
        "video/mp4",
        `${id}.mp4`,
        now,
        token,
        JSON.stringify(share),
      );
  const send = (p, method, body, cookie) =>
    fetch(base + p, {
      method,
      headers: {
        "Content-Type": "application/json",
        ...(cookie ? { cookie } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  return { base, db, dir, login, video, send };
}

test("a viewer can't reach a restricted video by percent-encoding its id", async (t) => {
  const { base, login, video } = await workspace(t);
  const invited = "11111111-1111-1111-1111-111111111111",
    noDownload = "22222222-2222-2222-2222-222222222222";
  video(invited, { share: { access: "invited", invitedEmails: [] } });
  video(noDownload, { share: { download: false } });
  const viewer = await login("viewer"),
    editor = await login("editor");
  const encoded = "%31" + invited.slice(1);
  for (const p of [
    `/api/videos/${invited}`,
    `/api/videos/${encoded}`,
    `/api/videos/${encoded}/`,
    `/api/media/${encoded}`,
    `/api/videos/${encoded}/captions.vtt`,
    `/api/videos/${encoded}/tracks/main`,
    `/api/videos/${encoded}/stream/master.m3u8`,
    `/api/videos/${invited.replaceAll("-", "%2d")}`,
    `/api/media/%32${noDownload.slice(1)}?download=1`,
  ]) {
    const r = await fetch(base + p, { headers: { cookie: viewer } });
    assert.equal(r.status, 403, `${p} must be refused for a viewer`);
  }
  // The same spelling does reach the video for someone allowed to see it.
  const allowed = await fetch(`${base}/api/videos/${encoded}`, {
    headers: { cookie: editor },
  });
  assert.equal(allowed.status, 200);
  assert.equal((await allowed.json()).id, invited);
  // An address that can't be decoded is turned away rather than guessed at.
  const broken = await fetch(`${base}/api/videos/%E0%A4%A`, {
    headers: { cookie: viewer },
  });
  assert.equal(broken.status, 400);
});

test("re-spelling an address doesn't reset its rate limit", async (t) => {
  const { video, send } = await workspace(t);
  video("33333333-3333-3333-3333-333333333333", { token: "token-abcdef" });
  for (let i = 0; i < 30; i++)
    assert.equal(
      (await send("/api/share/token-abcdef/view", "POST", {})).status,
      200,
    );
  for (const p of [
    "/api/share/token-abcdef/view",
    "/api/share/%74oken-abcdef/view",
    "/api/share/token-abcdef/view/",
    "/api/share/token%2Dabcdef/view/",
  ])
    assert.equal((await send(p, "POST", {})).status, 429, p);
  // Another link, and another kind of request to the same link, are counted apart.
  assert.equal((await send("/api/share/unknown/view", "POST", {})).status, 404);
  assert.equal(
    (await send("/api/share/token-abcdef/reactions", "POST", { emoji: "🎉" }))
      .status,
    200,
  );
});

test("several viewers behind one address can all report playback", async (t) => {
  const { video, send } = await workspace(t);
  video("44444444-4444-4444-4444-444444444444", { token: "token-events" });
  const report = (sessionId) =>
    send("/api/share/token-events/events", "POST", {
      sessionId,
      event: "play",
    });
  // Three people watching for a minute, each reporting every four seconds.
  for (let i = 0; i < 15; i++)
    for (const viewer of [
      "viewer-session-a",
      "viewer-session-b",
      "viewer-session-c",
    ])
      assert.equal((await report(viewer)).status, 200);
  // One session on its own is still held to a limit.
  let last;
  for (let i = 0; i < 50; i++) last = await report("viewer-session-a");
  assert.equal(last.status, 429);
  assert.equal((await report("viewer-session-b")).status, 200);
});

test("TRUST_PROXY accepts true, false, a hop count or a list of addresses", () => {
  assert.equal(trustProxy(undefined), false);
  assert.equal(trustProxy(""), false);
  assert.equal(trustProxy("false"), false);
  assert.equal(trustProxy("true"), true);
  assert.equal(trustProxy("1"), 1);
  assert.deepEqual(trustProxy("10.0.0.0/8, 127.0.0.1"), [
    "10.0.0.0/8",
    "127.0.0.1",
  ]);
});

test("a hostile caption file is read quickly", async (t) => {
  const hostile = [
    "-->" + " ".repeat(200000),
    "1 ".repeat(100000) + "-->",
    " ".repeat(200000) + "-->",
    "00:01.000 --> 00:02.000\n" + "<".repeat(200000),
    ("\n" + " ".repeat(49)).repeat(4000) + "x",
  ];
  for (const content of hostile) {
    const began = performance.now();
    try {
      parseCaptions(content);
    } catch (e) {
      assert.equal(e.status, 400);
    }
    assert.ok(performance.now() - began < 500, "each file is read in one pass");
  }
  assert.throws(() => parseCaptions("x".repeat(1000001)), { status: 400 });
  // Ordinary SRT and WebVTT still import, without their markup.
  assert.deepEqual(
    parseCaptions(
      "WEBVTT\n\n1\n00:00:01,000 --> 00:00:02,500 line:0\n<v Sam>Hello <b>there</b>\nfriend\n\n00:03.000 --> 00:04.000\n3 < 4",
    ),
    [
      {
        start: 1,
        end: 2.5,
        text: "Hello there friend",
        granularity: "segment",
      },
      { start: 3, end: 4, text: "3 < 4", granularity: "segment" },
    ],
  );
  // The same holds through the API, where it would otherwise stall every request.
  const { login, video, send } = await workspace(t);
  const id = "55555555-5555-5555-5555-555555555555";
  video(id);
  const editor = await login("editor");
  const began = performance.now();
  const reply = await send(
    `/api/videos/${id}/transcript`,
    "PUT",
    { content: hostile[0] },
    editor,
  );
  assert.equal(reply.status, 400);
  assert.ok(performance.now() - began < 2000);
});

test("with public links turned off, an editor can't open up an existing link", async (t) => {
  const { login, video, send } = await workspace(t);
  const id = "66666666-6666-6666-6666-666666666666",
    soon = new Date(Date.now() + 86400000).toISOString(),
    later = new Date(Date.now() + 30 * 86400000).toISOString(),
    sooner = new Date(Date.now() + 3600000).toISOString();
  video(id, {
    token: "token-policy",
    share: {
      access: "workspace",
      passwordHash: passwordHash("video-secret"),
      expiresAt: soon,
      version: 1,
    },
  });
  const owner = await login("owner"),
    editor = await login("editor");
  const set = (body, cookie) =>
    send(`/api/videos/${id}/share-settings`, "PUT", body, cookie);
  // While the workspace allows public links, an editor may loosen and restore one.
  assert.equal((await set({ expiresAt: later }, editor)).status, 200);
  assert.equal((await set({ expiresAt: soon }, editor)).status, 200);
  assert.equal(
    (
      await send(
        "/api/settings",
        "PUT",
        { sharing: { publicLinks: false } },
        owner,
      )
    ).status,
    200,
  );
  for (const body of [
    { access: "link" },
    { access: "link", password: "" },
    { password: "" },
    { expiresAt: null },
    { expiresAt: later },
  ]) {
    const refused = await set(body, editor);
    assert.equal(refused.status, 403, JSON.stringify(body));
    assert.match((await refused.json()).error, /Public sharing is disabled/);
  }
  // Tightening a link, or saving it as it is, stays possible.
  for (const body of [
    { download: false },
    { access: "workspace", expiresAt: soon },
    { expiresAt: sooner },
    { access: "invited", invitedEmails: ["viewer@example.com"] },
    { password: "another-secret" },
  ])
    assert.equal((await set(body, editor)).status, 200, JSON.stringify(body));
  const after = (await (await set({}, editor)).json()).shareConfig;
  assert.equal(after.access, "invited");
  assert.equal(after.hasPassword, true);
  assert.equal(after.expiresAt, sooner);
  // The owner is not bound by their own policy.
  const opened = await set(
    { access: "link", password: "", expiresAt: null },
    owner,
  );
  assert.equal(opened.status, 200);
  const config = (await opened.json()).shareConfig;
  assert.equal(config.access, "link");
  assert.equal(config.hasPassword, false);
});

test("malformed requests are refused instead of crashing or cutting everything", async (t) => {
  const { db, login, video, send } = await workspace(t);
  const id = "77777777-7777-7777-7777-777777777777";
  video(id, { token: "token-inputs" });
  const owner = await login("owner"),
    editor = await login("editor");

  // Cuts need real stretches of the video.
  for (const ranges of [
    [{}],
    5,
    "all",
    [null],
    [{ start: "1", end: "2" }],
    [{ start: 4, end: 2 }],
    [{ start: 1, end: Infinity }],
    Array.from({ length: 501 }, () => ({ start: 1, end: 2 })),
  ]) {
    const reply = await send(
      `/api/videos/${id}/project/cut`,
      "POST",
      { ranges },
      editor,
    );
    assert.equal(reply.status, 400, JSON.stringify(ranges).slice(0, 60));
  }
  const untouched = await (
    await send(`/api/videos/${id}/project`, "GET", undefined, editor)
  ).json();
  assert.deepEqual(untouched.project.segments, [
    { sourceId: id, start: 0, end: 10 },
  ]);
  const cut = await send(
    `/api/videos/${id}/project/cut`,
    "POST",
    { ranges: [{ start: 2, end: 4 }] },
    editor,
  );
  assert.equal(cut.status, 200);
  assert.deepEqual(
    (await cut.json()).project.segments.map((s) => [s.start, s.end]),
    [
      [0, 2],
      [4, 10],
    ],
  );

  // A project with holes in it is a bad request, not a server error.
  for (const body of [
    { version: 1, segments: [null] },
    { version: 1, segments: ["x"] },
    {
      version: 1,
      segments: [{ sourceId: id, start: 0, end: 5 }],
      overlays: [null],
    },
    {
      version: 1,
      segments: [{ sourceId: id, start: 0, end: 5 }],
      scenes: [null],
    },
  ])
    assert.equal(
      (await send(`/api/videos/${id}/project`, "PUT", body, editor)).status,
      400,
      JSON.stringify(body),
    );

  // Playback reports and replies must name their session and thread as text.
  for (const sessionId of [["abcdefghijkl"], { a: 1 }, 123456789012, null])
    assert.equal(
      (
        await send("/api/share/token-inputs/events", "POST", {
          sessionId,
          event: "play",
        })
      ).status,
      400,
    );
  for (const parentId of [["x"], { id: "x" }, 7])
    assert.equal(
      (
        await send("/api/share/token-inputs/comments", "POST", {
          author: "Ada",
          body: "Hello",
          time: 1,
          parentId,
        })
      ).status,
      400,
    );

  // Inviting someone again replaces their earlier invitation.
  const invite = async () =>
    (
      await send(
        "/api/team/invitations",
        "POST",
        { email: "new@example.com", role: "editor" },
        owner,
      )
    ).json();
  const first = await invite(),
    second = await invite();
  assert.equal((await send(`/api/invitations/${first.token}`)).status, 404);
  const accept = (token) =>
    send(`/api/invitations/${token}/accept`, "POST", {
      password: "a-long-enough-password",
    });
  assert.equal((await accept(second.token)).status, 201);
  // An older invitation for someone who has since joined is a conflict.
  // Only a hash of an invitation's link is stored, never the link.
  assert.deepEqual(
    db
      .prepare("SELECT token FROM invitations")
      .all()
      .filter((row) => [first.token, second.token].includes(row.token)),
    [],
  );
  db.prepare("INSERT INTO invitations VALUES(?,?,?,?,?,0)").run(
    createHash("sha256").update("leftover-invitation").digest("hex"),
    "new@example.com",
    "New",
    "editor",
    Date.now() + 86400000,
  );
  const again = await accept("leftover-invitation");
  assert.equal(again.status, 409);
  assert.match((await again.json()).error, /already in this workspace/);
});

test("share links: missing files, uninvited members, mentions and notifications", async (t) => {
  const { db, dir, login, video, send } = await workspace(t);
  const open = "88888888-8888-8888-8888-888888888888",
    closed = "99999999-9999-9999-9999-999999999999";
  video(open, { token: "token-open" });
  video(closed, {
    token: "token-closed",
    share: { access: "invited", invitedEmails: [] },
  });
  const viewer = await login("viewer"),
    owner = await login("owner");

  // A file that has gone missing is a plain 404 that names no server folder.
  for (const [p, cookie] of [
    ["/api/share/token-open/media"],
    [`/api/media/${open}`, owner],
    [`/api/videos/${open}/tracks/main`, owner],
  ]) {
    const missing = await send(p, "GET", undefined, cookie);
    assert.equal(missing.status, 404, p);
    assert.match(missing.headers.get("content-type"), /json/);
    const body = await missing.text();
    assert.match(body, /This video file is missing/);
    assert.ok(!body.includes(dir) && !body.includes("ENOENT"), body);
  }
  // Oversized JSON is not described as a video.
  const big = await send(
    `/api/videos/${open}`,
    "PATCH",
    { description: "x".repeat(3 * 1024 * 1024) },
    owner,
  );
  assert.equal(big.status, 413);
  assert.equal((await big.json()).error, "That upload is too large.");

  // Signing in again can't help a member who isn't invited, so they aren't asked to.
  const stranger = await send("/api/share/token-closed");
  assert.equal(stranger.status, 401);
  assert.equal((await stranger.json()).requiresLogin, true);
  const uninvited = await send(
    "/api/share/token-closed",
    "GET",
    undefined,
    viewer,
  );
  assert.equal(uninvited.status, 403);
  assert.equal((await uninvited.json()).requiresLogin, undefined);

  // Naming someone many times tells them once.
  const posted = await send("/api/share/token-open/comments", "POST", {
    author: "Ada",
    body: "@owner ".repeat(280) + "@owner@relay.local @Viewer @VIEWER",
    time: 1,
  });
  assert.equal(posted.status, 201);
  const mentions = db
    .prepare(
      "SELECT member_id FROM notifications WHERE kind='mention' ORDER BY member_id",
    )
    .all();
  assert.deepEqual(
    mentions.map((m) => m.member_id),
    ["owner", "v1"],
  );
  await send(
    `/api/videos/${open}/comments`,
    "POST",
    { body: "From the team", time: 2 },
    owner,
  );
  const comments = (await (await send("/api/share/token-open")).json())
    .comments;
  assert.deepEqual(
    comments.map((c) => c.member),
    [false, true],
  );
  assert.ok(!("member_id" in comments[0]));

  // A viewer clears their own notifications, not the workspace's.
  const unseen = () =>
    db
      .prepare(
        "SELECT member_id FROM notifications WHERE seen=0 ORDER BY member_id",
      )
      .all()
      .map((n) => n.member_id);
  const shared = db
    .prepare("SELECT id FROM notifications WHERE member_id IS NULL")
    .get().id;
  await send("/api/notifications/all/read", "POST", {}, viewer);
  await send(`/api/notifications/${shared}/read`, "POST", {}, viewer);
  assert.deepEqual(unseen(), [null, null, "owner"]);
  await send("/api/notifications/all/read", "POST", {}, owner);
  assert.deepEqual(unseen(), []);
});

test("changing ADMIN_PASSWORD signs the owner out", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "relay-hardening-"));
  try {
    let instance = createApp({ dataDir: dir, password: "first-password-123" });
    instance.db
      .prepare("INSERT INTO member_sessions VALUES(?,?,?)")
      .run("a".repeat(64), "owner", Date.now() + 86400000);
    const sessions = () =>
      instance.db.prepare("SELECT id FROM member_sessions").all().length;
    instance.close();
    // The same password on the next start keeps the session.
    instance = createApp({ dataDir: dir, password: "first-password-123" });
    assert.equal(sessions(), 1);
    instance.close();
    instance = createApp({ dataDir: dir, password: "second-password-456" });
    assert.equal(sessions(), 0);
    instance.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an imported outline keeps only fields of the right kind", async () => {
  const { cleanOutline } = await import("../server/studio/project.mjs");
  assert.deepEqual(cleanOutline({ chapters: "x", actionItems: 5 }), {});
  assert.deepEqual(cleanOutline("nope"), {});
  assert.deepEqual(
    cleanOutline({
      summary: "A tour",
      chapters: [
        { time: 0, title: "Intro" },
        { time: "later", title: "Skipped" },
        null,
        { time: 12, title: { html: "<b>" } },
      ],
      actionItems: ["Ship it", { nested: true }, 4],
      provider: "local",
      projectSegments: "[]",
      __proto__: { polluted: true },
      extra: { anything: 1 },
    }),
    {
      summary: "A tour",
      chapters: [{ time: 0, title: "Intro" }],
      actionItems: ["Ship it"],
      provider: "local",
      projectSegments: "[]",
    },
  );
});

test("invitation links sent before they were stored as hashes keep working", async (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "relay-invite-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  // A library as an earlier version left it: the link itself in the database.
  const before = createApp({ dataDir: dir, password: "owner-password-123" });
  before.db
    .prepare("INSERT INTO invitations VALUES(?,?,?,?,?,0)")
    .run(
      "a-link-sent-last-week",
      "sam@example.com",
      "Sam",
      "editor",
      Date.now() + 86400000,
    );
  before.db
    .prepare("DELETE FROM settings WHERE key='invitations_hashed'")
    .run();
  before.close();
  const { app, db, close } = createApp({
    dataDir: dir,
    password: "owner-password-123",
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  t.after(async () => {
    await new Promise((r) => server.close(r));
    close();
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.deepEqual(
    db
      .prepare("SELECT token FROM invitations")
      .all()
      .map((r) => r.token.length),
    [64],
  );
  const opened = await fetch(`${base}/api/invitations/a-link-sent-last-week`);
  assert.equal(opened.status, 200);
  assert.equal((await opened.json()).email, "sam@example.com");
  // What the database holds is not a link anyone can use.
  const stored = db.prepare("SELECT token FROM invitations").get().token;
  assert.equal((await fetch(`${base}/api/invitations/${stored}`)).status, 404);
});
