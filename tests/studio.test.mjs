import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import ffmpeg from "ffmpeg-static";
import { createApp } from "../server/app.mjs";
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
async function harness(t, password = "") {
  const dir = mkdtempSync(path.join(os.tmpdir(), "relay-studio-"));
  let instance = createApp({ dataDir: dir, password }),
    server;
  const h = {
    dir,
    instance,
    base: "",
    async start() {
      server = instance.app.listen(0, "127.0.0.1");
      await new Promise((r) => server.once("listening", r));
      h.base = `http://127.0.0.1:${server.address().port}`;
    },
    async restart() {
      await new Promise((r) => server.close(r));
      instance.close();
      instance = createApp({ dataDir: dir, password });
      h.instance = instance;
      await h.start();
    },
    async request(p, o = {}) {
      try {
        return await fetch(h.base + p, {
          ...o,
          headers: { ...o.headers, Connection: "close" },
        });
      } catch (e) {
        throw new Error(`${o.method || "GET"} ${p}: ${e.message}`, {
          cause: e,
        });
      }
    },
    async json(p, body, method = "POST", headers = {}) {
      const r = await h.request(p, {
        method,
        headers: { "Content-Type": "application/json", ...headers },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const b = await r.json();
      assert.ok(r.ok, `${p}: ${r.status} ${JSON.stringify(b)}`);
      return b;
    },
    async job(j) {
      for (let i = 0; i < 1500; i++) {
        const r = await (await h.request(`/api/jobs/${j.id}`)).json();
        if (r.status === "failed") throw new Error(r.error);
        if (r.status === "complete") return r;
        await delay(20);
      }
      throw new Error("Job timeout");
    },
  };
  await h.start();
  t.after(async () => {
    for (let i = 0; i < 1500; i++) {
      if (
        !instance.studio.jobs
          .list()
          .some((j) => ["running", "queued"].includes(j.status))
      )
        break;
      await delay(20);
    }
    await new Promise((r) => server.close(r));
    instance.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return h;
}
function fixture(file, type) {
  const source =
    type === "audio"
      ? [
          "-f",
          "lavfi",
          "-i",
          "sine=frequency=440:sample_rate=48000",
          "-c:a",
          "libopus",
        ]
      : [
          "-f",
          "lavfi",
          "-i",
          type === "camera"
            ? "color=c=orange:size=120x120:rate=24"
            : "testsrc2=size=320x180:rate=24",
          "-c:v",
          "libvpx",
          "-b:v",
          "300k",
        ];
  execFileSync(ffmpeg, [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    ...source,
    "-t",
    "2.5",
    file,
  ]);
}
test("durable separate tracks survive a restart, compose, edit, publish and round-trip an editable bundle", async (t) => {
  const h = await harness(t),
    id = crypto.randomUUID();
  const screen = path.join(h.dir, "screen.webm"),
    camera = path.join(h.dir, "camera.webm"),
    mic = path.join(h.dir, "mic.webm");
  fixture(screen, "screen");
  fixture(camera, "camera");
  fixture(mic, "audio");
  await h.json("/api/recordings", {
    id,
    title: "Durable multi-track capture",
    meta: { roles: ["screen", "camera", "microphone"] },
  });
  for (const [role, file] of [
    ["screen", screen],
    ["camera", camera],
    ["microphone", mic],
  ]) {
    const buffer = readFileSync(file),
      mid = Math.floor(buffer.length / 2);
    for (const [seq, chunk] of [
      [0, buffer.subarray(0, mid)],
      [1, buffer.subarray(mid)],
    ]) {
      const r = await h.request(`/api/recordings/${id}/parts/${role}/${seq}`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/octet-stream",
          "X-Track-Mime": role === "microphone" ? "audio/webm" : "video/webm",
          "X-Part-End": "2.5",
        },
        body: chunk,
      });
      assert.equal(r.status, 200);
    }
  }
  await h.restart();
  const recovered = await (await h.request("/api/recordings")).json();
  assert.equal(recovered[0].status, "interrupted");
  assert.equal(recovered[0].duration, 2.5);
  const done = await h.job(
    await h.json(`/api/recordings/${id}/finish`, {
      duration: 2.5,
      title: "Recovered multi-track capture",
      // The pointer travels, then rests on one spot: an automatic zoom target.
      meta: {
        autoZoom: true,
        pointers: [
          { time: 0, x: 0.1, y: 0.8 },
          ...Array.from({ length: 9 }, (_, i) => ({
            time: 0.2 + i * 0.15,
            x: 0.7,
            y: 0.3,
          })),
        ],
      },
    }),
  );
  const videoId = done.result.videoId;
  let video = await (await h.request(`/api/videos/${videoId}`)).json();
  assert.equal(video.revision, 1);
  assert.equal(video.mime, "video/mp4");
  assert.ok(video.thumbnail);
  let state = await (await h.request(`/api/videos/${videoId}/project`)).json();
  assert.equal(state.sources.length, 3);
  const auto = state.project.overlays.filter((o) => o.auto);
  assert.equal(auto.length, 1, "first render zooms into the key moment");
  assert.equal(auto[0].type, "zoom");
  assert.ok(
    Math.abs(auto[0].x - 0.7) < 0.01 && Math.abs(auto[0].y - 0.3) < 0.01,
  );
  assert.equal(state.project.layout.width, 320);
  assert.equal(state.project.layout.height, 180);
  const shared = await h.json(`/api/videos/${videoId}/share`);
  const token = shared.token;
  const project = state.project;
  project.segments = [
    { sourceId: videoId, start: 0, end: 0.8 },
    { sourceId: videoId, start: 1.4, end: 2.4 },
  ];
  project.layout.padding = 20;
  project.layout.wallpaper = "dusk";
  project.layout.radius = 0.02;
  project.layout.shadow = 0.8;
  // Switch layout partway: bubble, then side by side, then camera only.
  project.scenes = [
    { id: "s1", start: 0.6, end: 1.2, preset: "side" },
    { id: "s2", start: 1.2, end: 1.8, preset: "camera" },
  ];
  project.layout.camera.shape = "square";
  project.layout.audio.normalize = true;
  project.layout.audio.denoise = true;
  project.layout.captions = true;
  project.overlays = [
    {
      id: crypto.randomUUID(),
      type: "box",
      start: 0,
      end: 1,
      x: 0.1,
      y: 0.1,
      w: 0.3,
      h: 0.2,
      color: "#d6f475",
      text: "",
      scale: 1.5,
    },
  ];
  for (const [type, start, end] of [
    ["text", 0, 0.7],
    ["arrow", 0, 0.7],
    ["blur", 0.3, 1],
    ["zoom", 1, 1.7],
    ["cursor", 1, 1.7],
  ])
    project.overlays.push({
      id: crypto.randomUUID(),
      type,
      start,
      end,
      x: 0.2,
      y: 0.15,
      w: 0.25,
      h: 0.3,
      color: "#d6f475",
      text: "Review this",
      scale: 1.5,
    });
  await h.json(`/api/videos/${videoId}/project`, project, "PUT");
  await h.json(`/api/videos/${videoId}/project/undo`, {});
  state = await (await h.request(`/api/videos/${videoId}/project`)).json();
  assert.equal(state.project.segments.length, 1);
  await h.json(`/api/videos/${videoId}/project/redo`, {});
  await h.json(
    `/api/videos/${videoId}/transcript`,
    {
      words: [
        { text: "Welcome", start: 0, end: 0.4 },
        { text: "to", start: 0.4, end: 0.8 },
        { text: "Relay", start: 1.4, end: 1.8 },
      ],
    },
    "PUT",
  );
  const exported = await h.job(
    await h.json(`/api/videos/${videoId}/render`, {}),
  );
  video = await (await h.request(`/api/videos/${videoId}`)).json();
  assert.equal(video.token, token);
  assert.equal(video.revision, 2);
  assert.ok(Math.abs(video.duration - 1.8) < 0.05);
  const watch = await (await h.request(`/api/share/${token}`)).json();
  assert.equal(watch.transcript.length, 3);
  const vtt = await (
    await h.request(`/api/share/${token}/captions.vtt`)
  ).text();
  assert.match(vtt, /WEBVTT/);
  assert.match(vtt, /Relay/);
  const bundle = await h.request(`/api/videos/${videoId}/project.bundle`);
  assert.equal(bundle.status, 200);
  const form = new FormData();
  form.append("project", new Blob([await bundle.arrayBuffer()]), "test.relay");
  const imported = await h.request("/api/projects/import", {
    method: "POST",
    body: form,
  });
  assert.equal(imported.status, 201, await imported.clone().text());
  const copy = await imported.json();
  assert.notEqual(copy.id, videoId);
  assert.equal(copy.token, null);
  assert.equal(copy.project.segments.length, 2);
  assert.ok(copy.project.segments.every((s) => s.sourceId !== videoId));
  const dependency = structuredClone(copy.project);
  dependency.segments.push({ sourceId: videoId, start: 0, end: 0.5 });
  await h.json(`/api/videos/${copy.id}/project`, dependency, "PUT");
  assert.equal(
    (await h.request(`/api/videos/${videoId}`, { method: "DELETE" })).status,
    409,
  );
  const integration = await (await h.request("/api/integrations")).json();
  const mcp = await h.request("/mcp", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${integration.token}`,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "create_context_draft",
        arguments: { id: videoId, format: "bug" },
      },
    }),
  });
  const context = await mcp.json();
  assert.match(context.result.content[0].text, /Observed walkthrough/);
  assert.equal((await h.request("/api/integration/videos")).status, 401);
  const media = await h.request(`/api/share/${token}/media`);
  assert.equal(media.status, 200);
  const rendered = path.join(h.dir, "render.mp4");
  writeFileSync(rendered, Buffer.from(await media.arrayBuffer()));
  execFileSync(ffmpeg, [
    "-hide_banner",
    "-loglevel",
    "error",
    "-i",
    rendered,
    "-f",
    "null",
    "-",
  ]);
});
test("video gates, expiry, download controls, watched intervals, threaded feedback and workspace roles", async (t) => {
  const h = await harness(t, "a-long-workspace-password");
  const auth = await h.request("/api/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password: "a-long-workspace-password" }),
  });
  const ownerCookie = auth.headers.get("set-cookie").split(";")[0],
    owner = { Cookie: ownerCookie };
  const file = path.join(h.dir, "fixture.webm");
  fixture(file, "screen");
  const form = new FormData();
  form.append("video", new Blob([readFileSync(file)]), "test.webm");
  form.append("duration", "2.5");
  form.append("title", "Private recording");
  const video = await (
    await h.request("/api/videos", {
      method: "POST",
      headers: owner,
      body: form,
    })
  ).json();
  const shared = await h.json(
    `/api/videos/${video.id}/share`,
    {},
    "POST",
    owner,
  );
  const token = shared.token;
  await h.json(
    `/api/videos/${video.id}/share-settings`,
    { password: "video-password", download: false },
    "PUT",
    owner,
  );
  let denied = await h.request(`/api/share/${token}`);
  assert.equal(denied.status, 401);
  assert.equal((await denied.json()).requiresPassword, true);
  const unlock = await h.request(`/api/share/${token}/unlock`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password: "video-password" }),
  });
  assert.equal(unlock.status, 200);
  const viewer = { Cookie: unlock.headers.get("set-cookie").split(";")[0] };
  assert.equal(
    (await h.request(`/api/share/${token}`, { headers: viewer })).status,
    200,
  );
  assert.equal(
    (
      await h.request(`/api/share/${token}/media?download=1`, {
        headers: viewer,
      })
    ).status,
    403,
  );
  const sessionId = crypto.randomUUID();
  await h.json(`/api/share/${token}/view`, {}, "POST", viewer);
  let metrics = await (
    await h.request(`/api/videos/${video.id}/analytics`, { headers: owner })
  ).json();
  assert.equal(metrics.views, 0);
  await h.json(
    `/api/share/${token}/events`,
    { sessionId, event: "progress", from: 0, to: 2.4 },
    "POST",
    viewer,
  );
  metrics = await (
    await h.request(`/api/videos/${video.id}/analytics`, { headers: owner })
  ).json();
  assert.equal(metrics.views, 1);
  assert.ok(metrics.averageCompletion > 0.9);
  let feedback = await h.json(
    `/api/share/${token}/comments`,
    { author: "Sam", body: "Please check this.", time: 1 },
    "POST",
    viewer,
  );
  const parent = feedback.comments[0].id;
  feedback = await h.json(
    `/api/share/${token}/comments`,
    { author: "Alex", body: "Replying here.", time: 1, parentId: parent },
    "POST",
    viewer,
  );
  assert.equal(feedback.comments[1].parentId, parent);
  await h.json(
    `/api/videos/${video.id}/comments/${parent}`,
    { resolved: true },
    "PATCH",
    owner,
  );
  const resolved = await (
    await h.request(`/api/videos/${video.id}`, { headers: owner })
  ).json();
  assert.ok(resolved.comments.every((c) => c.resolved));
  const invitation = await h.json(
    "/api/team/invitations",
    { email: "viewer@example.com", name: "Viewer", role: "viewer" },
    "POST",
    owner,
  );
  const accepted = await h.request(
    `/api/invitations/${invitation.token}/accept`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: "a-long-viewer-password" }),
    },
  );
  assert.equal(accepted.status, 201);
  const memberCookie = accepted.headers.get("set-cookie").split(";")[0];
  const memberHeaders = { Cookie: memberCookie };
  assert.equal(
    (
      await h.request(`/api/videos/${video.id}/project.bundle`, {
        headers: memberHeaders,
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await h.request(`/api/videos/${video.id}/tracks/primary`, {
        headers: memberHeaders,
      })
    ).status,
    403,
  );
  await h.json(
    `/api/videos/${video.id}/share-settings`,
    { access: "invited", invitedEmails: [] },
    "PUT",
    owner,
  );
  assert.equal(
    (await h.request(`/api/videos/${video.id}`, { headers: memberHeaders }))
      .status,
    403,
  );
  assert.equal(
    (await (await h.request("/api/videos", { headers: memberHeaders })).json())
      .length,
    0,
  );
  await h.json(
    `/api/videos/${video.id}/share-settings`,
    { invitedEmails: ["viewer@example.com"] },
    "PUT",
    owner,
  );
  const viewerClip = await (
    await h.request(`/api/videos/${video.id}`, { headers: memberHeaders })
  ).json();
  assert.equal(viewerClip.title, "Private recording");
  assert.equal(viewerClip.project, undefined);
  assert.equal(
    (
      await h.request(`/api/videos/${video.id}/captions.vtt`, {
        headers: memberHeaders,
      })
    ).status,
    200,
  );
  assert.equal(
    (await h.request("/api/videos", { headers: { Cookie: memberCookie } }))
      .status,
    200,
  );
  assert.equal(
    (
      await h.request(`/api/videos/${video.id}`, {
        method: "PATCH",
        headers: { Cookie: memberCookie, "Content-Type": "application/json" },
        body: JSON.stringify({ title: "denied" }),
      })
    ).status,
    403,
  );
  await h.json(
    `/api/videos/${video.id}/share-settings`,
    { expiresAt: new Date(Date.now() - 1000).toISOString() },
    "PUT",
    owner,
  );
  assert.equal(
    (await h.request(`/api/share/${token}`, { headers: viewer })).status,
    410,
  );
});
