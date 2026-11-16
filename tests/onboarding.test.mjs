import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createApp } from "../server/app.mjs";

async function start(t, options = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "relay-onboarding-"));
  let instance = createApp({ dataDir: dir, ...options });
  let server = instance.app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const base = () => `http://127.0.0.1:${server.address().port}`;
  const json = (p, method = "GET", body, headers = {}) =>
    fetch(base() + p, {
      method,
      headers: { "Content-Type": "application/json", ...headers },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  const restart = async () => {
    await new Promise((r) => server.close(r));
    instance.close();
    instance = createApp({ dataDir: dir, ...options });
    server = instance.app.listen(0, "127.0.0.1");
    await new Promise((r) => server.once("listening", r));
  };
  t.after(async () => {
    await new Promise((r) => server.close(r));
    instance.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { json, restart };
}

test("onboarding state, profile name and local AI readiness persist with the library", async (t) => {
  const { json, restart } = await start(t);
  assert.deepEqual(await (await json("/api/preferences")).json(), {});

  const saved = await json("/api/preferences", "PUT", {
    onboardingStep: "permissions",
    countdown: 5,
    afterRecording: "copy-link",
    bubble: true,
    bubbleSize: "l",
    quality: 3840,
    ignored: "not a preference",
  });
  assert.equal(saved.status, 200);
  assert.deepEqual(await saved.json(), {
    onboardingStep: "permissions",
    countdown: 5,
    afterRecording: "copy-link",
    bubble: true,
    bubbleSize: "l",
    quality: 3840,
  });
  for (const bad of [{ countdown: 7 }, { quality: 4000 }, { bubbleSize: "xl" }])
    assert.equal((await json("/api/preferences", "PUT", bad)).status, 400);

  const profile = await json("/api/profile", "PUT", {
    name: "  Avery   Quinn ",
  });
  assert.equal((await profile.json()).member.name, "Avery Quinn");
  assert.equal(
    (await json("/api/profile", "PUT", { name: "   " })).status,
    400,
  );

  // Clearing a key with null, then a restart: setup resumes where it left off.
  await json("/api/preferences", "PUT", {
    onboardingStep: null,
    onboarded: true,
  });
  await restart();
  const after = await (await json("/api/preferences")).json();
  assert.equal(after.onboarded, true);
  assert.equal(after.onboardingStep, undefined);
  assert.equal(after.bubbleSize, "l");
  assert.equal(
    (await (await json("/api/session")).json()).member.name,
    "Avery Quinn",
  );

  const ai = await (await json("/api/ai/status")).json();
  assert.ok(ai.models.some((m) => m.model === "Xenova/whisper-tiny.en"));
  assert.ok(ai.models.every((m) => typeof m.ready === "boolean"));
  assert.equal(
    (await json("/api/ai/prepare", "POST", { model: "not-a-model" })).status,
    400,
  );
});

test("preferences require an unlocked workspace session", async (t) => {
  const password = "correct horse battery staple";
  const { json } = await start(t, { password });
  assert.equal((await json("/api/preferences")).status, 401);
  assert.equal(
    (await json("/api/preferences", "PUT", { countdown: 0 })).status,
    401,
  );
  const login = await json("/api/session", "POST", { password });
  const cookie = login.headers.get("set-cookie").split(";")[0];
  const auth = { Cookie: cookie };
  const own = await json("/api/preferences", "PUT", { countdown: 0 }, auth);
  assert.equal(own.status, 200);
  assert.equal((await own.json()).countdown, 0);
});
