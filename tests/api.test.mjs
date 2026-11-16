import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import ffmpeg from "ffmpeg-static";
import { createApp } from "../server/app.mjs";

test("recording lifecycle: durable upload, byte ranges, real trim, sharing, feedback, revoke and deletion", async (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "relay-test-"));
  let instance = createApp({ dataDir: dir });
  let server = instance.app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  let base = `http://127.0.0.1:${server.address().port}`;
  const request = (p, o) => fetch(base + p, o);
  t.after(async () => {
    await new Promise((r) => server.close(r));
    instance.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const fixture = path.join(dir, "fixture.mp4");
  execFileSync(ffmpeg, [
    "-hide_banner",
    "-loglevel",
    "error",
    "-f",
    "lavfi",
    "-i",
    "testsrc2=size=320x180:rate=24",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440:sample_rate=44100",
    "-t",
    "3",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    fixture,
  ]);
  const form = new FormData();
  form.append(
    "video",
    new Blob([readFileSync(fixture)], { type: "video/mp4" }),
    "test.mp4",
  );
  form.append("title", "My first recording");
  form.append("duration", "3");
  const uploaded = await request("/api/videos", { method: "POST", body: form });
  assert.equal(uploaded.status, 201);
  const video = await uploaded.json();
  assert.equal(video.title, "My first recording");
  assert.ok(video.size > 1000);
  const range = await request(`/api/media/${video.id}`, {
    headers: { Range: "bytes=0-15" },
  });
  assert.equal(range.status, 206);
  assert.equal((await range.arrayBuffer()).byteLength, 16);
  // Restart the database and server to check actual persistence.
  await new Promise((r) => server.close(r));
  instance.close();
  instance = createApp({ dataDir: dir });
  server = instance.app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await (await request("/api/videos")).json())[0].id, video.id);
  const trimmedResponse = await request(`/api/videos/${video.id}/trim`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ start: 0.5, end: 2 }),
  });
  assert.equal(trimmedResponse.status, 201);
  const trimmed = await trimmedResponse.json();
  assert.equal(trimmed.duration, 1.5);
  assert.equal(trimmed.mime, "video/mp4");
  assert.notEqual(trimmed.id, video.id);
  const decoded = execFileSync(
    ffmpeg,
    [
      "-hide_banner",
      "-i",
      path.join(dir, "media", `${trimmed.id}.mp4`),
      "-f",
      "null",
      "-",
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  assert.ok(decoded);
  const invalid = await request(`/api/videos/${video.id}/trim`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ start: 2, end: 1 }),
  });
  assert.equal(invalid.status, 400);
  const shared = await (
    await request(`/api/videos/${video.id}/share`, { method: "POST" })
  ).json();
  assert.equal(shared.token.length, 32);
  const pub = await (await request(`/api/share/${shared.token}`)).json();
  assert.equal(pub.title, video.title);
  assert.equal(pub.token, undefined);
  // The "Made with Relay" line is on by default and the owner can turn it off.
  assert.equal(pub.credit, true);
  await request("/api/settings", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sharing: { publicLinks: true, credit: false } }),
  });
  assert.equal(
    (await (await request(`/api/share/${shared.token}`)).json()).credit,
    false,
  );
  await request("/api/settings", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sharing: { publicLinks: true } }),
  });
  assert.equal(pub.folder, undefined);
  const posted = await request(`/api/share/${shared.token}/comments`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      author: "Sam",
      body: "Clear explanation!",
      time: 1.2,
    }),
  });
  assert.equal(posted.status, 201);
  assert.equal((await posted.json()).comments[0].time, 1.2);
  const reaction = await request(`/api/share/${shared.token}/reactions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ emoji: "💡" }),
  });
  assert.equal((await reaction.json()).reactions[0].count, 1);
  await request(`/api/videos/${video.id}/share`, { method: "DELETE" });
  assert.equal((await request(`/api/share/${shared.token}`)).status, 404);
  assert.equal((await request(`/api/share/${shared.token}/media`)).status, 404);
  await request(`/api/videos/${video.id}`, { method: "DELETE" });
  assert.equal((await request(`/api/media/${video.id}`)).status, 404);
  assert.equal((await (await request("/api/videos")).json()).length, 1);
});

test("workspace authentication, cross-origin protection, input rejection and session logout", async (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "relay-auth-"));
  const instance = createApp({
    dataDir: dir,
    password: "a-long-test-password",
  });
  const server = instance.app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    await new Promise((r) => server.close(r));
    instance.close();
    rmSync(dir, { recursive: true, force: true });
  });
  assert.equal((await fetch(base + "/api/videos")).status, 401);
  const cross = await fetch(base + "/api/session", {
    method: "POST",
    headers: {
      Origin: "https://another-site.test",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ password: "a-long-test-password" }),
  });
  assert.equal(cross.status, 403);
  const bad = await fetch(base + "/api/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password: "bad" }),
  });
  assert.equal(bad.status, 401);
  const good = await fetch(base + "/api/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password: "a-long-test-password" }),
  });
  assert.equal(good.status, 200);
  const cookie = good.headers.get("set-cookie").split(";")[0];
  assert.match(good.headers.get("set-cookie"), /HttpOnly/);
  assert.equal(
    (await fetch(base + "/api/videos", { headers: { Cookie: cookie } })).status,
    200,
  );
  const form = new FormData();
  form.append("video", new Blob(["not a video"]), "bad.mp4");
  form.append("duration", "3");
  assert.equal(
    (
      await fetch(base + "/api/videos", {
        method: "POST",
        headers: { Cookie: cookie },
        body: form,
      })
    ).status,
    415,
  );
  await fetch(base + "/api/session", {
    method: "DELETE",
    headers: { Cookie: cookie },
  });
  assert.equal(
    (await fetch(base + "/api/videos", { headers: { Cookie: cookie } })).status,
    401,
  );
});
