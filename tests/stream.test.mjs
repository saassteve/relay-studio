import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import os from "node:os";
import path from "node:path";
import ffmpeg from "../server/ffmpeg.mjs";
import { createApp } from "../server/app.mjs";
import { streamLadder } from "../server/studio/index.mjs";
import { probe } from "../server/studio/render.mjs";

test("the streaming ladder follows the size of the video", () => {
  const heights = (h) => streamLadder(h).map((r) => r.height);
  assert.deepEqual(heights(1080), [360, 720, 1080]);
  assert.deepEqual(heights(720), [360, 720]);
  assert.deepEqual(heights(480), [360]);
  // Between rungs, the video keeps the ones below it: nothing is stretched.
  assert.deepEqual(heights(1117), [360, 720, 1080]);
  assert.deepEqual(heights(1439), [360, 720, 1080]);
  // From 1440p the top rung is the video's own size, up to 4K.
  assert.deepEqual(heights(1440), [360, 720, 1080, 1440]);
  assert.deepEqual(heights(1800), [360, 720, 1080, 1800]);
  assert.deepEqual(heights(2160), [360, 720, 1080, 2160]);
  assert.deepEqual(heights(2880), [360, 720, 1080, 2160]);
  assert.deepEqual(heights(1801), [360, 720, 1080, 1800], "an even height");
  // A video smaller than the smallest rung is streamed as it is.
  assert.deepEqual(heights(240), [240]);
  assert.deepEqual(heights(181), [180]);
  assert.deepEqual(heights(0), [360], "an unreadable size gets the default");

  // A video that uses little data is not streamed with more than it uses, and
  // smaller rungs that would cost the same as a larger one are dropped.
  assert.deepEqual(
    streamLadder(1080, 500).map((r) => [r.height, r.rate]),
    [[1080, 550]],
  );
  assert.deepEqual(
    streamLadder(1080, 1500).map((r) => [r.height, r.rate]),
    [
      [360, 650],
      [1080, 1650],
    ],
  );
  assert.deepEqual(
    streamLadder(1080, 9000).map((r) => r.rate),
    [650, 1800, 4500],
  );
  assert.ok(streamLadder(1080, 500)[0].bandwidth > (550 + 96) * 1000);

  const rate = (h) => streamLadder(h).at(-1).rate;
  assert.equal(rate(1080), 4500);
  assert.equal(rate(1440), 8000);
  assert.equal(rate(1800), 11000);
  assert.equal(rate(2160), 14000);
  assert.equal(rate(4320), 14000);
  for (const h of [240, 480, 1080, 1440, 1800, 2160]) {
    const rungs = streamLadder(h);
    for (let i = 0; i < rungs.length; i++) {
      // What a player is told a rung needs covers its picture and sound.
      assert.ok(rungs[i].bandwidth > (rungs[i].rate + 96) * 1000, `${h}p`);
      if (i) assert.ok(rungs[i].bandwidth > rungs[i - 1].bandwidth);
      if (i) assert.ok(rungs[i].height > rungs[i - 1].height);
    }
  }
});

test("a 1080p video streams at 1080p, and a small one is not stretched", async (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "relay-stream-"));
  const { app, close } = createApp({ dataDir: dir, password: "" });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    await new Promise((r) => server.close(r));
    close();
    rmSync(dir, { recursive: true, force: true });
  });
  // Uploads a one-second clip of the given size and builds its stream.
  const stream = async (size) => {
    const file = path.join(dir, `${size}.mp4`);
    execFileSync(ffmpeg, [
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      `testsrc2=size=${size}:rate=10`,
      "-t",
      "1",
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      "-threads",
      "2",
      "-pix_fmt",
      "yuv420p",
      file,
    ]);
    const form = new FormData();
    form.append(
      "video",
      new Blob([readFileSync(file)], { type: "video/mp4" }),
      "clip.mp4",
    );
    form.append("duration", "1");
    const uploaded = await fetch(`${base}/api/videos`, {
      method: "POST",
      body: form,
    });
    assert.equal(uploaded.status, 201);
    const video = await uploaded.json();
    assert.equal(video.streamReady, false);
    let job = await (
      await fetch(`${base}/api/videos/${video.id}/stream`, { method: "POST" })
    ).json();
    for (
      let i = 0;
      i < 3000 && !["complete", "failed"].includes(job.status);
      i++
    ) {
      await delay(20);
      job = await (await fetch(`${base}/api/jobs/${job.id}`)).json();
    }
    assert.equal(job.status, "complete", job.error);
    const root = path.join(dir, "media", "hls", video.id, "0");
    const master = await fetch(
      `${base}/api/videos/${video.id}/stream/master.m3u8`,
    );
    assert.equal(master.status, 200);
    const lines = (await master.text()).trim().split("\n");
    return {
      root,
      video,
      // Each rung as the player reads it: [attributes, playlist].
      rungs: lines
        .map((l, i) => [l, lines[i + 1]])
        .filter(([l]) => l.startsWith("#EXT-X-STREAM-INF:")),
      files: readdirSync(root),
    };
  };

  const full = await stream("1920x1080");
  assert.deepEqual(
    full.rungs.map(([, playlist]) => playlist),
    ["360p.m3u8", "720p.m3u8", "1080p.m3u8"],
  );
  assert.deepEqual(
    full.rungs.map(([inf]) => inf),
    [
      "#EXT-X-STREAM-INF:BANDWIDTH=850000,RESOLUTION=640x360",
      "#EXT-X-STREAM-INF:BANDWIDTH=2100000,RESOLUTION=1280x720",
      "#EXT-X-STREAM-INF:BANDWIDTH=5100000,RESOLUTION=1920x1080",
    ],
  );
  // What is on disk is what the playlist promises, at the size it promises.
  for (const [inf, playlist] of full.rungs) {
    const name = playlist.replace(".m3u8", "");
    assert.ok(full.files.includes(playlist), playlist);
    const info = await probe(path.join(full.root, `${name}_00000.ts`));
    assert.equal(`RESOLUTION=${info.width}x${info.height}`, inf.split(",")[1]);
    // The watch page can fetch every piece of it.
    for (const piece of [playlist, `${name}_00000.ts`])
      assert.equal(
        (await fetch(`${base}/api/videos/${full.video.id}/stream/${piece}`))
          .status,
        200,
        piece,
      );
  }
  assert.equal(
    (await (await fetch(`${base}/api/videos/${full.video.id}`)).json())
      .streamReady,
    true,
  );

  const small = await stream("854x480");
  assert.deepEqual(
    small.rungs.map(([, playlist]) => playlist),
    ["360p.m3u8"],
  );
  assert.deepEqual(small.files.filter((f) => f.endsWith(".m3u8")).sort(), [
    "360p.m3u8",
    "master.m3u8",
  ]);
  const info = await probe(path.join(small.root, "360p_00000.ts"));
  assert.equal(
    `RESOLUTION=${info.width}x${info.height}`,
    small.rungs[0][0].split(",")[1],
  );
  assert.equal(info.height, 360);
});
