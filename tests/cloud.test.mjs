import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import ffmpeg from "ffmpeg-static";
import { createApp } from "../server/app.mjs";

const start = async (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "relay-cloud-"));
  const instance = createApp({ dataDir: dir });
  const listener = instance.app.listen(0, "127.0.0.1");
  await new Promise((r) => listener.once("listening", r));
  t.after(async () => {
    await new Promise((r) => listener.close(r));
    instance.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${listener.address().port}`;
  return {
    dir,
    base,
    db: instance.db,
    request: (p, o) => fetch(base + p, o),
  };
};
const JSONBody = (method, body) => ({
  method,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

test("a Relay app publishes a video to a server, updates it in place and takes it down", async (t) => {
  const server = await start(t),
    app = await start(t);
  const { token: key } = await (
    await server.request("/api/integrations")
  ).json();

  const fixture = path.join(app.dir, "fixture.mp4");
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
  form.append("title", "Launch walkthrough");
  form.append("duration", "3");
  const video = await (
    await app.request("/api/videos", { method: "POST", body: form })
  ).json();
  await app.request(
    `/api/videos/${video.id}/transcript`,
    JSONBody("PUT", {
      words: [
        { text: "Hello", start: 0.2, end: 0.6 },
        { text: "there", start: 0.7, end: 1.1 },
      ],
    }),
  );

  // Nothing is connected yet.
  assert.deepEqual(await (await app.request("/api/cloud")).json(), {
    connected: false,
  });
  assert.equal(
    (await app.request(`/api/videos/${video.id}/cloud`, { method: "POST" }))
      .status,
    409,
  );

  // A wrong key, a plain-http address and a non-Relay address are all refused.
  const wrongKey = await app.request(
    "/api/cloud",
    JSONBody("PUT", { url: server.base, key: "x".repeat(64) }),
  );
  assert.equal(wrongKey.status, 400);
  assert.match((await wrongKey.json()).error, /access key/);
  assert.equal(
    (
      await app.request(
        "/api/cloud",
        JSONBody("PUT", { url: "http://relay.example.com", key }),
      )
    ).status,
    400,
  );
  assert.equal(
    (
      await app.request(
        "/api/cloud",
        JSONBody("PUT", { url: "http://127.0.0.1:9", key }),
      )
    ).status,
    502,
  );

  const connected = await app.request(
    "/api/cloud",
    JSONBody("PUT", { url: server.base + "/some/path", key }),
  );
  assert.equal(connected.status, 200);
  const state = await connected.json();
  assert.equal(state.connected, true);
  assert.equal(state.url, server.base);
  // The key itself never comes back.
  assert.ok(!JSON.stringify(state).includes(key));
  assert.ok(
    !JSON.stringify(await (await app.request("/api/cloud")).json()).includes(
      key,
    ),
  );

  // The server only takes videos from someone holding its key.
  assert.equal(
    (
      await server.request("/api/integration/publish", {
        method: "POST",
        body: new FormData(),
      })
    ).status,
    401,
  );

  const first = await app.request(`/api/videos/${video.id}/cloud`, {
    method: "POST",
  });
  assert.equal(first.status, 200);
  const published = await first.json();
  assert.match(published.cloud.url, new RegExp(`^${server.base}/s/`));
  const shareToken = published.cloud.url.split("/s/")[1];
  const watch = await (await server.request(`/api/share/${shareToken}`)).json();
  assert.equal(watch.title, "Launch walkthrough");
  assert.equal(watch.transcript.map((w) => w.text).join(" "), "Hello there");
  const media = await server.request(`/api/share/${shareToken}/media`);
  assert.equal(media.status, 200);
  assert.ok((await media.arrayBuffer()).byteLength > 1000);

  // Opening the published video in the server's editor notes which file it plays.
  const hosted = (await (await server.request("/api/videos")).json())[0];
  const opened = await server.request(`/api/videos/${hosted.id}/project`);
  assert.equal(opened.status, 200);
  assert.equal((await opened.json()).sources[0].role, "primary");

  // Publishing again keeps the link and replaces the file rather than piling up copies.
  const files = () =>
    readdirSync(path.join(server.dir, "media")).filter((f) =>
      f.endsWith(".mp4"),
    );
  assert.equal(files().length, 1);
  await app.request(
    `/api/videos/${video.id}`,
    JSONBody("PATCH", { title: "Launch walkthrough v2" }),
  );
  const again = await (
    await app.request(`/api/videos/${video.id}/cloud`, { method: "POST" })
  ).json();
  assert.equal(again.cloud.url, published.cloud.url);
  assert.equal(files().length, 1);
  assert.equal(
    (await (await server.request(`/api/share/${shareToken}`)).json()).title,
    "Launch walkthrough v2",
  );
  assert.equal((await (await server.request("/api/videos")).json()).length, 1);
  // The server's editor follows to the new file instead of the one just deleted.
  const track = await server.request(`/api/videos/${hosted.id}/tracks/main`);
  assert.equal(track.status, 200);
  assert.ok((await track.arrayBuffer()).byteLength > 1000);
  assert.deepEqual(
    server.db
      .prepare("SELECT filename FROM assets")
      .all()
      .map((a) => a.filename),
    files(),
  );
  assert.equal(server.db.prepare("SELECT id FROM versions").all().length, 0);

  // Taking it down removes it from the server and forgets the link.
  const removed = await (
    await app.request(`/api/videos/${video.id}/cloud`, { method: "DELETE" })
  ).json();
  assert.equal(removed.cloud, undefined);
  assert.equal((await server.request(`/api/share/${shareToken}`)).status, 404);
  assert.equal(files().length, 0);

  const off = await (
    await app.request("/api/cloud", { method: "DELETE" })
  ).json();
  assert.deepEqual(off, { connected: false });
});
