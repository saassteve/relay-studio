import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import ffmpeg from "../server/ffmpeg.mjs";
import { createApp } from "../server/app.mjs";
import { passwordHash } from "../server/studio/auth.mjs";

async function workspace(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "relay-security-"));
  const { app, db, close } = createApp({
    dataDir: dir,
    password: "owner-password-123",
  });
  const now = new Date().toISOString();
  db.prepare("INSERT INTO members VALUES(?,?,?,?,?,?)").run(
    "v1",
    "viewer@example.com",
    "Viewer",
    "viewer",
    passwordHash("viewer-password-1"),
    now,
  );
  db.prepare("INSERT INTO members VALUES(?,?,?,?,?,?)").run(
    "e1",
    "editor@example.com",
    "Editor",
    "editor",
    passwordHash("editor-password-1"),
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
  const login = async (email, password) =>
    (
      await fetch(`${base}/api/session`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      })
    ).headers
      .get("set-cookie")
      .split(";")[0];
  return { base, db, dir, login };
}

test("role checks can't be bypassed by changing a path's letter case", async (t) => {
  const { base, db, login } = await workspace(t);
  const id = "11111111-1111-1111-1111-111111111111";
  db.prepare(
    "INSERT INTO videos(id,title,duration,size,mime,filename,created,share_config) VALUES(?,?,?,?,?,?,?,?)",
  ).run(
    id,
    "Invite-only",
    10,
    1,
    "video/mp4",
    "x.mp4",
    new Date().toISOString(),
    JSON.stringify({ access: "invited", invitedEmails: [] }),
  );
  const cookie = await login("viewer@example.com", "viewer-password-1");
  for (const p of [
    "/API/jobs",
    "/api/JOBS",
    `/API/videos/${id}`,
    `/api/videos/${id}/Project`,
    `/api/videos/${id}/TRACKS/screen`,
    `/API/media/${id}`,
  ]) {
    const r = await fetch(base + p, { headers: { cookie } });
    assert.ok(
      [403, 404].includes(r.status),
      `${p} must not be readable by a viewer (got ${r.status})`,
    );
  }
  const analytics = await fetch(`${base}/api/videos/${id}/analytics`, {
    headers: { cookie },
  });
  assert.equal(analytics.status, 403);
});

test("recording layout from the client is validated before rendering", async (t) => {
  const { base, dir, login } = await workspace(t);
  const clip = path.join(dir, "clip.webm");
  execFileSync(ffmpeg, [
    "-loglevel",
    "error",
    "-f",
    "lavfi",
    "-i",
    "testsrc=s=320x240:d=1",
    "-c:v",
    "libvpx",
    "-b:v",
    "200k",
    clip,
  ]);
  const cookie = await login("editor@example.com", "editor-password-1");
  const json = { "Content-Type": "application/json", cookie };
  const rec = await (
    await fetch(`${base}/api/recordings`, {
      method: "POST",
      headers: json,
      body: JSON.stringify({ meta: { roles: ["screen"] } }),
    })
  ).json();
  const bad = await fetch(`${base}/api/recordings/${rec.id}/parts/screen/0`, {
    method: "PUT",
    headers: { cookie, "x-track-mime": "text/html" },
    body: readFileSync(clip),
  });
  assert.equal(bad.status, 415, "only audio/video track types are accepted");
  await fetch(`${base}/api/recordings/${rec.id}/parts/screen/0`, {
    method: "PUT",
    headers: { cookie, "x-track-mime": "video/webm" },
    body: readFileSync(clip),
  });
  const job = await (
    await fetch(`${base}/api/recordings/${rec.id}/finish`, {
      method: "POST",
      headers: json,
      body: JSON.stringify({
        duration: 1,
        meta: { layout: { width: 333, height: 241, background: "red;x" } },
      }),
    })
  ).json();
  let state;
  for (let i = 0; i < 300; i++) {
    state = await (
      await fetch(`${base}/api/jobs/${job.id}`, { headers: { cookie } })
    ).json();
    if (["complete", "failed"].includes(state.status)) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.equal(state.status, "failed");
  assert.doesNotMatch(state.error, /filter_complex|\/tmp\/|\/Users\//);
  const videos = await (
    await fetch(`${base}/api/videos`, { headers: { cookie } })
  ).json();
  assert.equal(videos.length, 0, "a failed finish leaves no orphaned video");
});

test("the Mac app's library only answers Relay's own windows", async (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "relay-local-"));
  const secret = "a".repeat(64);
  const { app, close } = createApp({
    dataDir: dir,
    password: "",
    localSecret: secret,
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    await new Promise((r) => server.close(r));
    close();
    rmSync(dir, { recursive: true, force: true });
  });
  for (const p of [
    "/api/videos",
    "/api/integrations",
    "/API/videos",
    "/api/session",
  ])
    assert.equal((await fetch(base + p)).status, 401, p);
  const wrong = await fetch(`${base}/api/videos`, {
    headers: { cookie: `relay_local=${"b".repeat(64)}` },
  });
  assert.equal(wrong.status, 401);
  const own = await fetch(`${base}/api/videos`, {
    headers: { cookie: `relay_local=${secret}` },
  });
  assert.equal(own.status, 200);
  // Shared watch links still work from an ordinary browser.
  assert.equal((await fetch(`${base}/api/share/not-a-real-token`)).status, 404);
});
