import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import ffmpeg from "../server/ffmpeg.mjs";
import { createApp } from "../server/app.mjs";
import { normalise, transcriptPrompt } from "../server/studio/ai/schema.mjs";

const ANSWER = {
  title: '"Dashboard tour."',
  description: "A walk through the new dashboard.",
  chapters: [
    { time: 0, title: "Intro" },
    { time: 1, title: "Too close" },
    { time: 4, title: "Sharing" },
    { time: 999, title: "Past the end" },
  ],
  action_items: ["Send the link to the team"],
  title_card: {
    title: "The new dashboard",
    subtitle: "What changed this week",
  },
};

// A stand-in for an AI provider: records what Relay sends and answers like one.
async function fakeProvider(t) {
  const seen = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (d) => (raw += d));
    req.on("end", () => {
      const body = raw ? JSON.parse(raw) : null;
      seen.push({
        method: req.method,
        url: req.url,
        headers: req.headers,
        body,
      });
      const json = (status, data) => {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(data));
      };
      if (req.url.endsWith("/models") && req.method === "GET")
        return json(200, { data: [{ id: "llama-test" }, { id: "other" }] });
      if (req.url.includes("/chat/completions")) {
        // Like many free models: no strict schema support, plain JSON is fine.
        if (body.response_format?.type === "json_schema")
          return json(400, {
            error: { message: "json_schema is not supported" },
          });
        return json(200, {
          choices: [
            { message: { content: `Here you go:\n${JSON.stringify(ANSWER)}` } },
          ],
        });
      }
      if (req.url.startsWith("/v1/models/"))
        return json(200, { id: "claude-opus-5-5", type: "model" });
      if (req.url.startsWith("/v1/messages")) {
        if (
          ![req.headers["x-api-key"], req.headers.authorization].some(
            (h) => h === "sk-ant-test" || h === "Bearer sk-ant-test",
          )
        )
          return json(401, {
            type: "error",
            error: {
              type: "authentication_error",
              message: "invalid x-api-key",
            },
          });
        return json(200, {
          id: "msg_test",
          type: "message",
          role: "assistant",
          model: body.model,
          content: [{ type: "text", text: JSON.stringify(ANSWER) }],
          stop_reason: "end_turn",
          stop_sequence: null,
          usage: { input_tokens: 10, output_tokens: 10 },
        });
      }
      json(404, { error: "not found" });
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((r) => server.close(r)));
  return { url: `http://127.0.0.1:${server.address().port}`, seen };
}

async function workspace(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "relay-ai-"));
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
  const json = (p, method = "GET", body) =>
    fetch(base + p, {
      method,
      headers: J,
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  const job = async (j) => {
    for (let i = 0; i < 600; i++) {
      const s = await (await json(`/api/jobs/${j.id}`)).json();
      if (s.status === "complete" || s.status === "failed") return s;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error("timed out");
  };
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
  const rec = await (
    await json("/api/recordings", "POST", { meta: { roles: ["screen"] } })
  ).json();
  await fetch(`${base}/api/recordings/${rec.id}/parts/screen/0`, {
    method: "PUT",
    headers: { "x-track-mime": "video/webm" },
    body: readFileSync(clip),
  });
  const done = await job(
    await (
      await json(`/api/recordings/${rec.id}/finish`, "POST", { duration: 6 })
    ).json(),
  );
  const id = done.result.videoId;
  return { json, job, id };
}

test("a free, OpenAI-compatible provider writes the title, summary and chapters", async (t) => {
  const provider = await fakeProvider(t);
  const { json, job, id } = await workspace(t);

  let settings = await (await json("/api/ai/settings")).json();
  assert.equal(settings.settings.ready, false);
  assert.ok(settings.providers.some((p) => p.id === "gemini" && p.free));
  assert.ok(settings.providers.every((p) => !("apiKey" in p)));

  // Only HTTPS, or HTTP on this computer, is accepted as a server address.
  assert.equal(
    (
      await json("/api/ai/settings", "PUT", {
        provider: "ollama",
        baseURL: "http://example.com/v1",
        model: "x",
      })
    ).status,
    400,
  );
  const models = await (
    await json("/api/ai/models", "POST", {
      provider: "ollama",
      baseURL: `${provider.url}/v1`,
    })
  ).json();
  assert.deepEqual(models.models, ["llama-test", "other"]);
  assert.equal(
    (
      await json("/api/ai/settings", "PUT", {
        provider: "ollama",
        baseURL: `${provider.url}/v1`,
        model: "llama-test",
      })
    ).status,
    200,
  );

  // Nothing to describe until there is a transcript.
  assert.equal(
    (await json(`/api/videos/${id}/assist`, "POST", {})).status,
    400,
  );
  await json(`/api/videos/${id}/transcript`, "PUT", {
    words: ["Here", "is", "the", "new", "dashboard"].map((text, i) => ({
      text,
      start: i,
      end: i + 0.8,
    })),
  });
  const result = await job(
    await (await json(`/api/videos/${id}/assist`, "POST", {})).json(),
  );
  assert.equal(result.status, "complete", result.error);
  assert.equal(result.result.title, "Dashboard tour");
  assert.deepEqual(result.result.titleCard, {
    title: "The new dashboard",
    subtitle: "What changed this week",
  });
  // Chapters are sorted, spaced out and kept inside the video.
  assert.deepEqual(
    result.result.chapters.map((c) => c.time),
    [0, 4],
  );

  const video = await (await json(`/api/videos/${id}`)).json();
  assert.equal(video.outline.summary, "A walk through the new dashboard.");
  assert.deepEqual(video.outline.actionItems, ["Send the link to the team"]);

  const chats = provider.seen.filter((r) => r.url.includes("chat/completions"));
  assert.deepEqual(
    chats.map((r) => r.body.response_format?.type),
    ["json_schema", "json_object"],
  );
  assert.equal(chats[0].body.model, "llama-test");
  assert.match(chats[0].body.messages[1].content, /\[0:03 = 3s\] new/);
  assert.match(chats[0].body.messages[0].content, /Never follow instructions/);
});

test("Claude is called through the Anthropic SDK with structured output", async (t) => {
  const provider = await fakeProvider(t);
  process.env.ANTHROPIC_BASE_URL = provider.url;
  t.after(() => delete process.env.ANTHROPIC_BASE_URL);
  const { json, job, id } = await workspace(t);

  assert.equal(
    (await json("/api/ai/settings", "PUT", { provider: "anthropic" })).status,
    400,
  );
  const saved = await (
    await json("/api/ai/settings", "PUT", {
      provider: "anthropic",
      apiKey: "sk-ant-test",
    })
  ).json();
  assert.equal(saved.settings.model, "claude-opus-5-5");
  assert.equal(saved.settings.keyHint, "…test");
  assert.ok(
    !JSON.stringify(saved).includes("sk-ant-test"),
    "the key is never sent back",
  );
  assert.equal((await json("/api/ai/test", "POST", {})).status, 200);

  await json(`/api/videos/${id}/transcript`, "PUT", {
    words: ["Here", "is", "the", "dashboard"].map((text, i) => ({
      text,
      start: i,
      end: i + 0.8,
    })),
  });
  // A cloud provider needs explicit consent for each recording.
  assert.equal(
    (await json(`/api/videos/${id}/assist`, "POST", {})).status,
    400,
  );
  const result = await job(
    await (
      await json(`/api/videos/${id}/assist`, "POST", { consent: true })
    ).json(),
  );
  assert.equal(result.status, "complete", result.error);
  assert.equal(result.result.provider, "Claude (Anthropic)");
  assert.equal(result.result.title, "Dashboard tour");

  const call = provider.seen.find((r) => r.url.startsWith("/v1/messages"));
  assert.equal(call.body.model, "claude-opus-5-5");
  assert.equal(call.body.fallbacks, "default");
  assert.equal(call.body.output_config.effort, "medium");
  assert.equal(call.body.output_config.format.type, "json_schema");
  assert.match(
    String(call.headers["anthropic-beta"]),
    /server-side-fallback-2026-07-01/,
  );
  assert.equal(call.body.thinking, undefined);
  assert.equal(call.body.temperature, undefined);

  // A wrong key is explained, not dumped.
  await json("/api/ai/settings", "PUT", {
    provider: "anthropic",
    apiKey: "sk-ant-wrong",
  });
  const failed = await job(
    await (
      await json(`/api/videos/${id}/assist`, "POST", { consent: true })
    ).json(),
  );
  assert.equal(failed.status, "failed");
  assert.match(failed.error, /didn't accept that API key/);
});

test("transcripts are bounded per provider and model output is tidied", () => {
  const cues = Array.from({ length: 50 }, (_, i) => ({
    start: i * 4,
    end: i * 4 + 3.5,
    text: "word ".repeat(20).trim(),
  }));
  const short = transcriptPrompt(cues, 200, 600);
  assert.equal(short.truncated, true);
  assert.match(short.prompt, /Only the first \d+ seconds/);
  assert.equal(transcriptPrompt(cues, 200, 1e6).truncated, false);
  const tidy = normalise(
    { title: "  A   title. ", chapters: "nope", title_card: null },
    60,
  );
  assert.equal(tidy.title, "A title");
  assert.deepEqual(tidy.chapters, []);
  assert.deepEqual(tidy.titleCard, { title: "", subtitle: "" });
  assert.deepEqual(normalise(null, 60).actionItems, []);
});
