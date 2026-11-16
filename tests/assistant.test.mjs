import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import ffmpeg from "../server/ffmpeg.mjs";
import { createApp } from "../server/app.mjs";
import { buildASS } from "../server/studio/titles.mjs";

test("an assistant can read, edit and publish a video through the connector", async (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "relay-assistant-"));
  const { app, close } = createApp({ dataDir: dir });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    await new Promise((r) => server.close(r));
    close();
    rmSync(dir, { recursive: true, force: true });
  });
  const J = { "Content-Type": "application/json" };
  const clip = path.join(dir, "clip.webm");
  execFileSync(ffmpeg, [
    "-loglevel",
    "error",
    "-f",
    "lavfi",
    "-i",
    "testsrc=s=320x180:d=6",
    "-c:v",
    "libvpx",
    "-b:v",
    "200k",
    clip,
  ]);
  const job = async (j) => {
    for (let i = 0; i < 600; i++) {
      const s = await (await fetch(`${base}/api/jobs/${j.id}`)).json();
      if (s.status === "complete") return s;
      if (s.status === "failed") throw new Error(s.error);
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error("job timed out");
  };
  const rec = await (
    await fetch(`${base}/api/recordings`, {
      method: "POST",
      headers: J,
      body: JSON.stringify({ meta: { roles: ["screen"] } }),
    })
  ).json();
  await fetch(`${base}/api/recordings/${rec.id}/parts/screen/0`, {
    method: "PUT",
    headers: { "x-track-mime": "video/webm" },
    body: readFileSync(clip),
  });
  const id = (
    await job(
      await (
        await fetch(`${base}/api/recordings/${rec.id}/finish`, {
          method: "POST",
          headers: J,
          body: JSON.stringify({ duration: 6, title: "Untitled" }),
        })
      ).json(),
    )
  ).result.videoId;
  await fetch(`${base}/api/videos/${id}/transcript`, {
    method: "PUT",
    headers: J,
    body: JSON.stringify({
      words: ["So", "this", "is", "the", "new", "dashboard"].map((text, i) => ({
        text,
        start: 0.5 + i * 0.8,
        end: 1.1 + i * 0.8,
      })),
    }),
  });

  const { token } = await (await fetch(`${base}/api/integrations`)).json();
  let n = 0;
  const mcp = async (method, params, auth = token) => {
    const r = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { ...J, Authorization: `Bearer ${auth}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++n, method, params }),
    });
    return { status: r.status, body: r.status === 200 ? await r.json() : null };
  };
  const call = async (name, args) => {
    const { body } = await mcp("tools/call", { name, arguments: args });
    if (body.error) throw new Error(body.error.message);
    return JSON.parse(body.result.content[0].text);
  };
  assert.equal((await mcp("tools/list", {}, "wrong")).status, 401);
  const tools = (await mcp("tools/list")).body.result.tools.map((x) => x.name);
  for (const name of [
    "get_project",
    "edit_video",
    "render_video",
    "get_render_status",
  ])
    assert.ok(tools.includes(name), name);

  const before = await call("get_project", { id });
  assert.equal(before.duration, 6);
  assert.equal(before.layout.wallpaper, "aurora");
  assert.match(before.transcript.map((c) => c.text).join(" "), /new dashboard/);

  const edited = await call("edit_video", {
    id,
    operations: [
      { op: "cut", start: 1, end: 2 },
      // Given on the original timeline; it should land one second earlier.
      {
        op: "add_title",
        style: "lowerthird",
        start: 3,
        end: 5,
        title: "Alex Rivera",
        subtitle: "Product",
      },
      {
        op: "add_title",
        style: "title",
        start: 0,
        end: 1,
        title: "The new dashboard",
      },
      { op: "add_zoom", start: 4, end: 5.5, x: 0.7, y: 0.3, scale: 2 },
      { op: "set_look", wallpaper: "dusk", corners: 0.02 },
      { op: "set_captions", enabled: true, style: "highlight" },
      {
        op: "set_details",
        title: "Dashboard tour",
        description: "What changed this week.",
      },
    ],
  });
  assert.equal(edited.video.duration, 5);
  assert.equal(edited.video.title, "Dashboard tour");
  assert.equal(edited.video.layout.wallpaper, "dusk");
  assert.equal(edited.video.layout.caption_style, "highlight");
  const lower = edited.video.titles.find((x) => x.style === "lowerthird");
  assert.deepEqual([lower.start, lower.end], [2, 4]);
  assert.deepEqual(
    edited.video.zooms.map((z) => [z.start, z.end]),
    [[3, 4.5]],
  );
  await assert.rejects(
    call("edit_video", { id, operations: [{ op: "delete_everything" }] }),
    /Unknown operation/,
  );
  await assert.rejects(
    call("edit_video", {
      id,
      operations: [{ op: "set_look", wallpaper: "../x" }],
    }),
    /Wallpaper/,
  );

  const render = await call("render_video", { id });
  let status;
  for (let i = 0; i < 600; i++) {
    status = await call("get_render_status", { job_id: render.job_id });
    if (status.status === "complete" || status.status === "failed") break;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.equal(status.status, "complete", status.error);
  const video = await (await fetch(`${base}/api/videos/${id}`)).json();
  assert.equal(video.revision, 2);
  assert.ok(Math.abs(video.duration - 5) < 0.1);

  // The whole batch is one undoable step.
  const undone = await (
    await fetch(`${base}/api/videos/${id}/project/undo`, {
      method: "POST",
      headers: J,
      body: "{}",
    })
  ).json();
  assert.equal(undone.project.overlays.length, 0);
});

test("captions and titles produce a safe subtitle script", () => {
  const words = ["Hello", "there", "{\\an8}friend"].map((text, i) => ({
    text,
    start: i * 0.5,
    end: i * 0.5 + 0.4,
  }));
  const ass = buildASS({
    width: 1920,
    height: 1080,
    words,
    captionStyle: "highlight",
    overlays: [
      {
        type: "title",
        start: 0,
        end: 2,
        text: "Big {\\b1}idea",
        sub: "line\nbreak",
        color: "#d6f475",
      },
      {
        type: "lowerthird",
        start: 2,
        end: 4,
        text: "Name",
        sub: "Role",
        color: "#d6f475",
      },
      {
        type: "chapter",
        start: 4,
        end: 6,
        text: "01 · Intro",
        color: "#ff0000",
      },
      { type: "text", start: 0, end: 1, text: "not a title" },
    ],
  });
  assert.match(ass, /PlayResX: 1920/);
  // User text can't smuggle in formatting codes.
  assert.doesNotMatch(ass, /\{\\an8\}friend|\{\\b1\}idea/);
  assert.match(ass, /line\\Nbreak/);
  assert.match(ass, /Style: Highlight,Manrope/);
  assert.equal(ass.match(/,TitleCard,/g).length, 1);
  assert.match(ass, /&H0000FF&/); // chapter accent: red as BGR
  assert.doesNotMatch(ass, /not a title/);
  assert.equal(
    buildASS({
      width: 1280,
      height: 720,
      words: [],
      captionStyle: null,
      overlays: [],
    }),
    null,
  );
  for (const style of ["clean", "bold", "box"])
    assert.match(
      buildASS({
        width: 1280,
        height: 720,
        words,
        captionStyle: style,
        overlays: [],
      }),
      /Dialogue: 2,/,
    );
});

test("cutting part of a video keeps titles and effects lined up", async () => {
  const { cutRanges } = await import("../server/studio/project.mjs");
  const project = {
    version: 1,
    segments: [{ sourceId: "a", start: 0, end: 16 }],
    overlays: [
      { id: "before", type: "text", start: 1, end: 3 },
      { id: "inside", type: "text", start: 5.1, end: 5.4 },
      { id: "after", type: "zoom", start: 8, end: 10 },
      { id: "to-the-end", type: "zoom", start: 12, end: 16 },
    ],
    scenes: [{ id: "side", start: 9, end: 12, preset: "side" }],
  };
  const cut = cutRanges(project, "a", [{ start: 5, end: 6 }]);
  assert.deepEqual(cut.segments, [
    { sourceId: "a", start: 0, end: 5 },
    { sourceId: "a", start: 6, end: 16 },
  ]);
  const at = Object.fromEntries(cut.overlays.map((o) => [o.id, o]));
  assert.deepEqual([at.before.start, at.before.end], [1, 3]);
  assert.equal(at.inside, undefined, "an effect inside the cut goes with it");
  assert.deepEqual([at.after.start, at.after.end], [7, 9]);
  // An effect that ran to the end of the video still fits afterwards.
  assert.deepEqual([at["to-the-end"].start, at["to-the-end"].end], [11, 15]);
  assert.deepEqual([cut.scenes[0].start, cut.scenes[0].end], [8, 11]);
});

test("an effect left past the end of a trimmed video is fitted, not refused", async () => {
  const { validateProject } = await import("../server/studio/project.mjs");
  const saved = validateProject(
    {
      version: 1,
      segments: [{ sourceId: "a", start: 0, end: 10 }],
      overlays: [
        { id: "fits", type: "text", start: 8, end: 12 },
        { id: "gone", type: "text", start: 11, end: 13 },
      ],
      scenes: [
        { id: "fits", start: 7, end: 14, preset: "side" },
        { id: "gone", start: 9.8, end: 14, preset: "camera" },
      ],
    },
    () => ({ id: "a", duration: 10 }),
  );
  assert.deepEqual(
    saved.overlays.map((o) => [o.id, o.start, o.end]),
    [["fits", 8, 10]],
  );
  assert.deepEqual(
    saved.scenes.map((s) => [s.id, s.start, s.end]),
    [["fits", 7, 10]],
  );
});
