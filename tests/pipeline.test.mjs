// The media pipeline end to end: real recordings are finished, cut and rendered,
// and the result is checked frame by frame and sample by sample.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ffmpeg from "../server/ffmpeg.mjs";
import { createApp } from "../server/app.mjs";
import { validateProject } from "../server/studio/project.mjs";
import { createAssistantEdits } from "../server/studio/assistant-edits.mjs";
import { buildASS } from "../server/studio/titles.mjs";

const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const make = (file, ...args) => {
  execFileSync(ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", ...args]);
  return file;
};
// A picture that is one flat colour at a time, so a frame tells the time.
function colours(file, spans, extra = []) {
  const inputs = spans.flatMap(([colour, seconds]) => [
    "-f",
    "lavfi",
    "-i",
    `color=c=${colour}:s=160x90:r=30:d=${seconds}`,
  ]);
  const joined = `${spans.map((_, i) => `[${i}:v]`).join("")}concat=n=${spans.length}`;
  return make(
    file,
    ...inputs,
    "-filter_complex",
    [joined, ...extra].join(","),
    "-c:v",
    "libvpx",
    "-b:v",
    "200k",
    file,
  );
}
const sound = (file, source) =>
  make(file, "-f", "lavfi", "-i", source, "-c:a", "libopus", file);
// The colour of the top-right of the frame at a moment, clear of titles and captions.
function colourAt(file, time) {
  const [r, g, b] = execFileSync(ffmpeg, [
    "-hide_banner",
    "-loglevel",
    "error",
    "-ss",
    String(time),
    "-i",
    file,
    "-frames:v",
    "1",
    "-vf",
    "crop=iw/4:ih/4:iw*5/8:ih/8,scale=1:1:flags=area",
    "-f",
    "rawvideo",
    "-pix_fmt",
    "rgb24",
    "pipe:1",
  ]);
  const high = (n) => n > 150,
    low = (n) => n < 110;
  if (high(r) && high(g) && high(b)) return "white";
  if (high(r) && low(g) && low(b)) return "red";
  if (low(r) && high(g) && low(b)) return "green";
  if (low(r) && low(g) && high(b)) return "blue";
  if (low(r) && low(g) && low(b)) return "dark";
  return `rgb(${r},${g},${b})`;
}
// Exact counts of what a file holds, from decoding all of it.
function measure(file) {
  const read = (...args) =>
    spawnSync(ffmpeg, ["-hide_banner", "-nostats", "-i", file, ...args], {
      encoding: "buffer",
      maxBuffer: 512 * 1024 * 1024,
    });
  const video = String(
    read("-map", "0:v:0", "-vf", "showinfo", "-f", "null", "-").stderr,
  ).match(/pts_time:/g);
  const audio = read(
    "-map",
    "0:a:0",
    "-f",
    "s16le",
    "-ac",
    "1",
    "-ar",
    "48000",
    "pipe:1",
  ).stdout;
  const samples = new Int16Array(
    audio.buffer.slice(audio.byteOffset, audio.byteOffset + audio.length),
  );
  return {
    frames: video ? video.length : 0,
    seconds: samples.length / 48000,
    peak: samples.reduce((n, s) => Math.max(n, Math.abs(s)), 0),
  };
}

async function harness(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "relay-pipeline-"));
  const { app, db, close, studio } = createApp({ dataDir: dir });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const h = {
    dir,
    db,
    base,
    async api(p, body, method = body === undefined ? "GET" : "POST") {
      const r = await fetch(base + p, {
        method,
        headers: { "Content-Type": "application/json", Connection: "close" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { status: r.status, body: await r.json().catch(() => null) };
    },
    async job(j) {
      for (let i = 0; i < 3000; i++) {
        const { body } = await h.api(`/api/jobs/${j.id}`);
        if (["complete", "failed"].includes(body.status)) return body;
        await delay(20);
      }
      throw new Error("The job did not finish.");
    },
    async upload(id, role, bytes, seq = 0) {
      const r = await fetch(
        `${base}/api/recordings/${id}/parts/${role}/${seq}`,
        {
          method: "PUT",
          headers: {
            "Content-Type": "application/octet-stream",
            "X-Track-Mime": role === "microphone" ? "audio/webm" : "video/webm",
            Connection: "close",
          },
          body: bytes,
        },
      );
      assert.equal(r.status, 200);
    },
    // Records the given tracks and waits for the first render.
    async record(tracks, duration) {
      const { body } = await h.api("/api/recordings", {
        meta: { roles: Object.keys(tracks) },
      });
      for (const [role, file] of Object.entries(tracks))
        await h.upload(body.id, role, readFileSync(file));
      const done = await h.job(
        (await h.api(`/api/recordings/${body.id}/finish`, { duration })).body,
      );
      assert.equal(done.status, "complete", done.error);
      return done.result.videoId;
    },
    // A plain full-frame project to edit: no wallpaper, padding or camera.
    async project(id) {
      const { project } = (await h.api(`/api/videos/${id}/project`)).body;
      Object.assign(project.layout, {
        padding: 0,
        wallpaper: "none",
        radius: 0,
        shadow: 0,
      });
      project.overlays = [];
      project.scenes = [];
      return project;
    },
    async render(id, project) {
      return h.job((await h.api(`/api/videos/${id}/render`, { project })).body);
    },
    file: (id) =>
      path.join(
        dir,
        "media",
        db.prepare("SELECT filename FROM videos WHERE id=?").get(id).filename,
      ),
  };
  t.after(async () => {
    for (let i = 0; i < 1500; i++) {
      if (
        !studio.jobs
          .list()
          .some((j) => ["running", "queued"].includes(j.status))
      )
        break;
      await delay(20);
    }
    await new Promise((r) => server.close(r));
    close();
    rmSync(dir, { recursive: true, force: true });
  });
  return h;
}

test("a very short section over silence renders with loudness correction on", async (t) => {
  const h = await harness(t);
  const id = await h.record(
    {
      screen: colours(path.join(h.dir, "s.webm"), [["red", 2]]),
      microphone: sound(
        path.join(h.dir, "m.webm"),
        "anullsrc=r=48000:cl=mono:d=2",
      ),
    },
    2,
  );
  const project = await h.project(id);
  assert.equal(project.layout.audio.normalize, true);
  project.segments = [{ sourceId: id, start: 0.5, end: 0.75 }];
  const done = await h.render(id, project);
  assert.equal(done.status, "complete", done.error);
  const out = measure(h.file(id));
  assert.equal(out.frames, 8);
  assert.ok(out.peak < 4, "silence stays silent");
});

test("loudness is corrected once for the whole video, not section by section", async (t) => {
  const h = await harness(t);
  const id = await h.record(
    {
      screen: colours(path.join(h.dir, "s.webm"), [["red", 8]]),
      // A steady tone that drops to a tenth of its level between 5 s and 6 s.
      microphone: sound(
        path.join(h.dir, "m.webm"),
        "sine=frequency=440:sample_rate=48000:duration=8,volume='if(between(t,5,6),0.02,0.2)':eval=frame",
      ),
    },
    8,
  );
  const project = await h.project(id);
  project.segments = [
    { sourceId: id, start: 0, end: 4 },
    { sourceId: id, start: 5.2, end: 5.8 },
    { sourceId: id, start: 6, end: 8 },
  ];
  const done = await h.render(id, project);
  assert.equal(done.status, "complete", done.error);
  const level = (from, length) => {
    const { stderr } = spawnSync(
      ffmpeg,
      [
        "-hide_banner",
        "-nostats",
        "-ss",
        String(from),
        "-t",
        String(length),
        "-i",
        h.file(id),
        "-af",
        "volumedetect",
        "-f",
        "null",
        "-",
      ],
      { encoding: "utf8" },
    );
    return Number(stderr.match(/mean_volume: (-?[\d.]+) dB/)[1]);
  };
  const loud = level(1, 2),
    quiet = level(4.2, 0.2),
    after = level(5, 1.5);
  // The video as a whole is brought up to a normal level...
  assert.ok(loud > -26 && loud < -12, `normal level ${loud} dB`);
  assert.ok(Math.abs(loud - after) < 2, `${loud} dB, later ${after} dB`);
  // ...and the short quiet section is still the quiet part of it.
  assert.ok(
    loud - quiet > 12,
    `quiet section ${quiet} dB, the rest ${loud} dB`,
  );
});

test("a section that starts while the screen was still shows what was on screen", async (t) => {
  const h = await harness(t);
  // Red until 4 s, then no frames at all until green appears at 9 s, blue at 10.5 s.
  const screen = colours(
    path.join(h.dir, "s.webm"),
    [
      ["red", 4],
      ["lime", 1.5],
      ["blue", 1.5],
    ],
    ["setpts='if(gte(T,4),PTS+5/TB,PTS)'"],
  );
  const id = await h.record(
    {
      screen,
      microphone: sound(
        path.join(h.dir, "m.webm"),
        "sine=frequency=440:sample_rate=48000:duration=12",
      ),
    },
    12,
  );
  const project = await h.project(id);
  project.segments = [{ sourceId: id, start: 6, end: 12 }];
  const done = await h.render(id, project);
  assert.equal(done.status, "complete", done.error);
  const file = h.file(id);
  // Output time 0 is source time 6: still red, as it was until 9 s.
  assert.deepEqual(
    [0.1, 1.5, 2.8, 3.2, 4.3, 4.7, 5.8].map((time) => colourAt(file, time)),
    ["red", "red", "red", "green", "green", "blue", "blue"],
  );
  const out = measure(file);
  assert.equal(out.frames, 180);
  assert.ok(Math.abs(out.seconds - 6) < 0.03, `${out.seconds} s of sound`);
});

test("a recording whose clock ran past its video can still be edited", async (t) => {
  const h = await harness(t);
  const id = await h.record(
    { screen: colours(path.join(h.dir, "s.webm"), [["red", 3]]) },
    // The browser's stopwatch says 3.6 s; the track holds 3 s.
    3.6,
  );
  const state = (await h.api(`/api/videos/${id}/project`)).body;
  assert.ok(
    state.project.segments[0].end <= state.sourceDuration,
    `section ends at ${state.project.segments[0].end} in a ${state.sourceDuration} s track`,
  );
  const video = (await h.api(`/api/videos/${id}`)).body;
  assert.ok(Math.abs(video.duration - 3) < 0.05, `duration ${video.duration}`);
  const saved = await h.api(`/api/videos/${id}/project`, state.project, "PUT");
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  const cut = await h.api(`/api/videos/${id}/project/cut`, {
    ranges: [{ start: 1, end: 2 }],
  });
  assert.equal(cut.status, 200, JSON.stringify(cut.body));
});

test("FFmpeg is stopped when it stalls, not when the video is long", async () => {
  const { engine } = await import("../server/studio/render.mjs");
  // Paced to real time, sound keeps arriving: slow, but never stalled.
  const steady = [
    "-re",
    "-f",
    "lavfi",
    "-i",
    "anullsrc=r=8000:cl=mono:d=6",
    "-f",
    "null",
    "-",
  ];
  await engine(steady, { stall: 3000 });
  // One frame, then nothing for a minute.
  const stuck = [
    "-re",
    "-f",
    "lavfi",
    "-i",
    "color=s=16x16:r=1/60:d=120",
    "-f",
    "null",
    "-",
  ];
  const started = Date.now();
  await assert.rejects(engine(stuck, { stall: 1500 }), (e) => {
    assert.match(e.message, /took too long/);
    assert.ok(e.expected, "the message is written for the person using Relay");
    return true;
  });
  assert.ok(Date.now() - started < 20000);
  // An ordinary failure still reports what the engine said.
  await assert.rejects(
    engine(["-i", "/nonexistent/input.webm", "-f", "null", "-"]),
    /Command failed/,
  );
});

test("many short sections stay on the timeline, and a late title lands on time", async (t) => {
  const h = await harness(t);
  const id = await h.record(
    {
      screen: colours(path.join(h.dir, "s.webm"), [
        ["red", 3],
        ["lime", 3],
        ["blue", 3],
        ["white", 3],
      ]),
      microphone: sound(
        path.join(h.dir, "m.webm"),
        "sine=frequency=440:sample_rate=48000:duration=12",
      ),
    },
    12,
  );
  const project = await h.project(id);
  project.layout.audio.normalize = false;
  // 24 sections of a quarter second: section n shows the source from 0.48 n.
  project.segments = Array.from({ length: 24 }, (_, n) => ({
    sourceId: id,
    start: +(n * 0.48).toFixed(2),
    end: +(n * 0.48 + 0.25).toFixed(2),
  }));
  project.overlays = [
    {
      id: "late",
      type: "title",
      start: 5,
      end: 5.7,
      x: 0.1,
      y: 0.1,
      w: 0.3,
      h: 0.15,
      scale: 1.8,
      text: "Late",
      sub: "",
      color: "#d6f475",
    },
  ];
  const done = await h.render(id, project);
  assert.equal(done.status, "complete", done.error);
  const file = h.file(id),
    out = measure(file),
    video = (await h.api(`/api/videos/${id}`)).body;
  // Six seconds exactly: 180 frames and, to within one AAC frame, six seconds
  // of sound. Rounding at each of the 23 cuts must not add up.
  assert.equal(out.frames, 180);
  assert.ok(Math.abs(out.seconds - 6) < 0.025, `${out.seconds} s of sound`);
  assert.ok(Math.abs(video.duration - 6) < 1 / 30, `stored ${video.duration}`);
  // Section 18 (blue) plays from 4.5 s and section 19 (white) from 4.75 s; the
  // title card dims the picture from 5 s to 5.7 s.
  assert.deepEqual(
    [1.1, 2.6, 4.6, 4.9, 5.4, 5.9].map((time) => colourAt(file, time)),
    ["red", "green", "blue", "white", "dark", "white"],
  );
});

test("quitting during the first render leaves one video and no leftovers", async (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "relay-pipeline-quit-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const app = fileURLToPath(new URL("../server/app.mjs", import.meta.url));
  let child;
  const start = () =>
    new Promise((resolve, reject) => {
      child = spawn(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `import { createApp } from ${JSON.stringify(app)};
           const server = createApp({ dataDir: ${JSON.stringify(dir)} }).app.listen(0, "127.0.0.1");
           server.once("listening", () => console.log("PORT:" + server.address().port));`,
        ],
        { stdio: ["ignore", "pipe", "inherit"] },
      );
      child.once("error", reject);
      child.stdout.on("data", (data) => {
        const port = String(data).match(/PORT:(\d+)/);
        if (port) resolve(`http://127.0.0.1:${port[1]}`);
      });
    });
  const stop = () => {
    // The media engine goes down with the app, as it does when Relay quits.
    spawnSync("pkill", ["-KILL", "-P", String(child.pid)]);
    child.kill("SIGKILL");
    return new Promise((r) => child.once("exit", r));
  };
  t.after(() => child.exitCode === null && child.signalCode === null && stop());
  const get = async (base, p) =>
    (await fetch(base + p, { headers: { Connection: "close" } })).json();
  const J = { "Content-Type": "application/json", Connection: "close" };

  let base = await start();
  const clip = make(
    path.join(dir, "clip.webm"),
    "-f",
    "lavfi",
    "-i",
    "testsrc2=size=640x360:rate=30:d=20",
    "-c:v",
    "libvpx",
    "-deadline",
    "realtime",
    "-b:v",
    "400k",
    path.join(dir, "clip.webm"),
  );
  const rec = await (
    await fetch(`${base}/api/recordings`, {
      method: "POST",
      headers: J,
      body: JSON.stringify({ meta: { roles: ["screen"] } }),
    })
  ).json();
  await fetch(`${base}/api/recordings/${rec.id}/parts/screen/0`, {
    method: "PUT",
    headers: { "X-Track-Mime": "video/webm", Connection: "close" },
    body: readFileSync(clip),
  });
  rmSync(clip);
  const job = await (
    await fetch(`${base}/api/recordings/${rec.id}/finish`, {
      method: "POST",
      headers: J,
      body: JSON.stringify({ duration: 20 }),
    })
  ).json();
  // Quit as soon as the render has begun.
  let rendering = false;
  for (let i = 0; i < 3000 && !rendering; i++) {
    rendering = readdirSync(path.join(dir, "tmp")).some((f) =>
      f.startsWith("render-"),
    );
    if (!rendering) await delay(5);
  }
  assert.ok(rendering, "the first render started");
  assert.equal((await get(base, `/api/jobs/${job.id}`)).status, "running");
  await stop();

  base = await start();
  let after;
  for (let i = 0; i < 3000; i++) {
    after = await get(base, `/api/jobs/${job.id}`);
    if (["complete", "failed"].includes(after.status)) break;
    await delay(20);
  }
  assert.equal(after.status, "complete", after.error);
  const videos = await get(base, "/api/videos");
  assert.deepEqual(
    videos.map((v) => v.id),
    [after.result.videoId],
  );
  assert.equal(videos[0].revision, 1);
  for (let i = 0; i < 1500; i++) {
    const jobs = await get(base, "/api/jobs");
    if (!jobs.some((j) => ["running", "queued"].includes(j.status))) break;
    await delay(20);
  }
  await stop();
  // Only this video's files remain, and no half-finished working folders.
  assert.deepEqual(
    readdirSync(path.join(dir, "media")).filter(
      (f) => f !== "hls" && !f.startsWith(`${videos[0].id}-`),
    ),
    [],
  );
  assert.equal(
    readdirSync(path.join(dir, "media")).filter((f) => f !== "hls").length,
    2,
    "the screen track and the finished video",
  );
  assert.deepEqual(
    readdirSync(path.join(dir, "tmp")).filter((f) => f.startsWith("render-")),
    [],
  );
});

test("pauses are still found across the whole recording after a trim is published", async (t) => {
  const h = await harness(t);
  const id = await h.record(
    {
      screen: colours(path.join(h.dir, "s.webm"), [["red", 6]]),
      // Two pauses: 1-2 s and 4-5 s.
      microphone: sound(
        path.join(h.dir, "m.webm"),
        "sine=frequency=440:sample_rate=48000:duration=6,volume='if(between(t,1,2)+between(t,4,5),0,1)':eval=frame",
      ),
    },
    6,
  );
  const pauses = async () =>
    (await h.api(`/api/videos/${id}/suggestions`, {})).body
      .filter((s) => s.kind === "silence")
      .map((s) => Math.round(s.start));
  assert.deepEqual(await pauses(), [1, 4]);
  const project = await h.project(id);
  project.segments = [{ sourceId: id, start: 0, end: 3 }];
  assert.equal((await h.render(id, project)).status, "complete");
  assert.deepEqual(await pauses(), [1, 4]);
});

// An assistant's batch of edits, applied to a ten second video held in memory.
function assistant(pauses = []) {
  const video = {
    id: "v",
    title: "Untitled",
    description: "",
    duration: 10,
    revision: 1,
    transcript: "[]",
    outline: "{}",
    project: "",
  };
  const find = () => video;
  video.project = JSON.stringify(
    validateProject(
      { version: 1, segments: [{ sourceId: "v", start: 0, end: 10 }] },
      find,
    ),
  );
  const edits = createAssistantEdits({
    db: {
      prepare: () => ({
        run: (title, description) =>
          Object.assign(video, { title, description }),
      }),
    },
    find,
    sourceFind: find,
    save: (v, project) => (video.project = JSON.stringify(project)),
    validateProject,
    suggestions: async () =>
      pauses.map((p) => ({ ...p, sourceId: "v", kind: "silence" })),
  });
  return {
    video,
    project: () => JSON.parse(video.project),
    apply: (...operations) => edits.apply(video, operations),
  };
}

test("an assistant's times are read on the timeline it was shown, whatever else the batch removes", async () => {
  const title = { op: "add_title", style: "chapter", title: "Six" };
  for (const order of ["pauses first", "title first"]) {
    const a = assistant([{ start: 2, end: 4 }]);
    // Already on the video before this batch: it must move once, with its footage.
    await a.apply({ op: "add_zoom", start: 6, end: 8 });
    const operations = [
      { op: "remove_silences" },
      { ...title, start: 6, end: 8 },
      { op: "cut", start: 0, end: 1 },
      { op: "change_layout", start: 8.5, end: 9.5, layout: "screen" },
    ];
    const { video } = await a.apply(
      ...(order === "title first"
        ? [operations[1], operations[0], ...operations.slice(2)]
        : operations),
    );
    assert.equal(video.duration, 7, order);
    assert.deepEqual(
      video.titles.map((x) => [x.start, x.end]),
      [[3, 5]],
      order,
    );
    assert.deepEqual(
      video.zooms.map((z) => [z.start, z.end]),
      [[3, 5]],
      order,
    );
    assert.deepEqual(
      video.layout_changes.map((s) => [s.start, s.end]),
      [[5.5, 6.5]],
      order,
    );
  }
});

test("a batch that fails changes nothing, and an edit leaves short effects alone", async () => {
  const a = assistant();
  await assert.rejects(
    a.apply(
      { op: "set_details", title: "Renamed", description: "New" },
      { op: "add_title", start: 999, end: 1000, title: "Nowhere" },
    ),
    /between/,
  );
  assert.equal(a.video.title, "Untitled");
  assert.equal(a.video.description, "");
  assert.equal(a.project().overlays.length, 0);

  // A fifth-of-a-second effect is valid, so an unrelated edit must keep it.
  const project = a.project();
  project.overlays.push({
    id: "blink",
    type: "cursor",
    start: 1,
    end: 1.2,
    x: 0.5,
    y: 0.5,
  });
  a.video.project = JSON.stringify(validateProject(project, () => a.video));
  const done = await a.apply(
    { op: "set_captions", enabled: true },
    { op: "set_details", title: "Renamed" },
  );
  assert.deepEqual(
    a.project().overlays.map((o) => o.id),
    ["blink"],
  );
  assert.equal(done.video.title, "Renamed");
  assert.equal(done.video.layout.captions, true);
});

test("retrying an old failed job never reopens a finished recording", async (t) => {
  const h = await harness(t);
  const bytes = readFileSync(colours(path.join(h.dir, "s.webm"), [["red", 2]])),
    half = Math.floor(bytes.length / 2);
  const rec = (await h.api("/api/recordings", { meta: { roles: ["screen"] } }))
    .body;
  const finish = async () =>
    h.job(
      (await h.api(`/api/recordings/${rec.id}/finish`, { duration: 2 })).body,
    );
  await h.upload(rec.id, "screen", bytes.subarray(half), 1);
  const first = await finish();
  assert.equal(first.status, "failed");
  assert.match(first.error, /missing chunk/);
  await h.upload(rec.id, "screen", bytes.subarray(0, half), 0);
  const second = await finish();
  assert.equal(second.status, "complete", second.error);

  const retried = await h.job(
    (await h.api(`/api/jobs/${first.id}/retry`, {})).body,
  );
  assert.equal(retried.status, "complete", retried.error);
  assert.equal(retried.result.videoId, second.result.videoId);
  assert.equal(
    (await h.api(`/api/recordings/${rec.id}`)).body.status,
    "complete",
  );
  assert.deepEqual((await h.api("/api/recordings")).body, []);
  assert.equal((await h.api("/api/videos")).body.length, 1);
  assert.equal(
    (await h.api(`/api/recordings/${rec.id}`, undefined, "DELETE")).status,
    200,
  );
});

test("an AI reply with nothing in it fails the job and keeps the notes already there", async (t) => {
  let reply = "{}",
    redirected = 0;
  const provider = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      if (req.url.startsWith("/elsewhere")) redirected++;
      if (req.url.startsWith("/moved/"))
        return res.writeHead(307, { Location: "/elsewhere/models" }).end();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify(
          req.url.endsWith("/models")
            ? { data: [{ id: "m" }] }
            : { choices: [{ message: { content: reply } }] },
        ),
      );
    });
  });
  await new Promise((r) => provider.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((r) => provider.close(r)));
  const url = `http://127.0.0.1:${provider.address().port}`;

  const h = await harness(t);
  const id = await h.record(
    { screen: colours(path.join(h.dir, "s.webm"), [["red", 6]]) },
    6,
  );
  await h.api(
    `/api/videos/${id}/transcript`,
    { words: [{ text: "Hello", start: 1, end: 2 }] },
    "PUT",
  );
  await h.api(
    `/api/videos/${id}/outline`,
    { summary: "Written by hand.", actionItems: ["Ship it"] },
    "PUT",
  );
  const settings = { provider: "ollama", baseURL: `${url}/v1`, model: "m" };
  assert.equal((await h.api("/api/ai/settings", settings, "PUT")).status, 200);
  const assist = async () =>
    h.job((await h.api(`/api/videos/${id}/assist`, {})).body);
  const notes = async () => (await h.api(`/api/videos/${id}`)).body.outline;

  for (reply of ["{}", '{"error":"model overloaded"}']) {
    const failed = await assist();
    assert.equal(failed.status, "failed", reply);
    assert.match(failed.error, /Ollama/);
    assert.equal((await notes()).summary, "Written by hand.");
  }
  // A reply with a title but no summary or action items leaves those as they were.
  reply = JSON.stringify({ title: "Hello there" });
  const partial = await assist();
  assert.equal(partial.status, "complete", partial.error);
  assert.equal(partial.result.title, "Hello there");
  assert.equal((await notes()).summary, "Written by hand.");
  assert.deepEqual((await notes()).actionItems, ["Ship it"]);

  // A local server that answers with a redirect is not followed anywhere.
  const moved = await h.api("/api/ai/test", {
    ...settings,
    baseURL: `${url}/moved/v1`,
  });
  assert.ok(moved.status >= 400, JSON.stringify(moved.body));
  assert.match(moved.body.error, /redirect/i);
  assert.equal(redirected, 0);
});

test("the bar behind a lower third is wide enough for wide characters", () => {
  const bar = (text) => {
    const ass = buildASS({
      width: 1280,
      height: 720,
      overlays: [{ type: "lowerthird", start: 0, end: 2, text, sub: "" }],
    });
    // The right-hand edge of the first shape drawn.
    const first = ass.split("\n").find((l) => l.includes("\\p1}m "));
    return Number(first.match(/\\p1\}m \d+ \d+ l (\d+) /)[1]);
  };
  const latin = bar("Product manager"),
    wide = bar("プロダクトマネージャー設計");
  assert.ok(wide > latin * 1.3, `${wide} against ${latin}`);
});
