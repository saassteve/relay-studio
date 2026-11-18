import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import ffmpeg from "ffmpeg-static";
import http from "node:http";
import { createApp } from "../server/app.mjs";

const start = async (t, options = {}) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "relay-cloud-"));
  const instance = createApp({ dataDir: dir, ...options });
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

const uploadFixture = async (instance) => {
  const form = new FormData();
  form.append(
    "video",
    new Blob([readFileSync("scripts/assets/presenter.mp4")], {
      type: "video/mp4",
    }),
    "privacy.mp4",
  );
  form.append("title", "Private walkthrough");
  form.append("duration", "7");
  const response = await instance.request("/api/videos", {
    method: "POST",
    body: form,
  });
  assert.equal(response.status, 201);
  return response.json();
};
const connect = (client, server, key) =>
  client.request("/api/cloud", JSONBody("PUT", { url: server.base, key }));
const publish = (client, id, server, sharing) =>
  client.request(
    "/api/videos/" + id + "/cloud",
    JSONBody("POST", { workspaceUrl: server.base, sharing }),
  );

test("a sharing-only key publishes protected videos without library, editing or key access", async (t) => {
  const server = await start(t, { password: "owner-password-123" });
  const client = await start(t);
  const login = await server.request(
    "/api/session",
    JSONBody("POST", { password: "owner-password-123" }),
  );
  assert.equal(login.status, 200);
  const ownerCookie = login.headers.get("set-cookie").split(";")[0];
  const keyRequest = () =>
    server.request("/api/cloud/key", { headers: { Cookie: ownerCookie } });
  const { key } = await (await keyRequest()).json();
  const auth = { Authorization: "Bearer " + key };
  assert.equal(
    (await server.request("/api/cloud/key", { headers: auth })).status,
    401,
  );
  assert.equal(
    (await server.request("/api/videos", { headers: auth })).status,
    401,
  );
  assert.equal(
    (await server.request("/api/integration/videos", { headers: auth })).status,
    401,
  );
  assert.equal(
    (
      await server.request("/mcp", {
        ...JSONBody("POST", { jsonrpc: "2.0", id: 1, method: "tools/list" }),
        headers: { ...auth, "Content-Type": "application/json" },
      })
    ).status,
    401,
  );

  const state = await (await connect(client, server, key)).json();
  assert.equal(state.keyScope, "sharing");
  assert.equal(state.privacySupported, true);
  assert.ok(!JSON.stringify(state).includes(key));
  const video = await uploadFixture(client);
  const expiresAt = new Date(Date.now() + 7 * 86400000).toISOString();
  const first = await publish(client, video.id, server, {
    access: "workspace",
    download: false,
    expiresAt,
  });
  assert.equal(first.status, 200);
  const result = await first.json();
  assert.deepEqual(result.cloud.share, {
    access: "workspace",
    download: false,
    expiresAt,
    hasPassword: false,
  });
  const token = result.cloud.url.split("/s/")[1];
  for (const suffix of ["", "/media", "/captions.vtt"]) {
    assert.equal(
      (await server.request("/api/share/" + token + suffix)).status,
      401,
    );
  }
  assert.equal(
    (
      await server.request("/api/share/" + token, {
        headers: { Cookie: ownerCookie },
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await server.request("/api/share/" + token + "/media?download=1", {
        headers: { Cookie: ownerCookie },
      })
    ).status,
    403,
  );
  const status = await (
    await client.request("/api/videos/" + video.id + "/cloud")
  ).json();
  assert.equal(status.share.access, "workspace");
  assert.equal(status.manageUrl.startsWith(server.base + "/video/"), true);
  assert.ok(!JSON.stringify(status).includes("passwordHash"));

  // A video update preserves privacy changes made in the online workspace.
  const remote = server.db
    .prepare("SELECT id FROM videos WHERE source_ref=?")
    .get(video.id);
  await server.request("/api/videos/" + remote.id + "/share-settings", {
    ...JSONBody("PUT", {
      access: "invited",
      invitedEmails: ["viewer@example.com"],
    }),
    headers: { "Content-Type": "application/json", Cookie: ownerCookie },
  });
  const updated = await publish(client, video.id, server);
  assert.equal(updated.status, 200);
  assert.equal((await updated.json()).cloud.share.access, "invited");
  assert.equal((await server.request("/api/share/" + token)).status, 401);

  // Resetting the device key revokes old device access while viewer rules persist.
  const reset = await server.request("/api/cloud/key/reset", {
    method: "POST",
    headers: { Cookie: ownerCookie },
  });
  assert.equal(reset.status, 200);
  assert.equal(
    (await server.request("/api/integration/workspace", { headers: auth }))
      .status,
    401,
  );
  const stale = await (await client.request("/api/cloud")).json();
  assert.equal(stale.connected, true);
  assert.equal(stale.reachable, false);
  const { key: replacement } = await (await keyRequest()).json();
  assert.notEqual(replacement, key);
  assert.equal((await connect(client, server, replacement)).status, 200);
  assert.equal(
    (
      await client.request("/api/videos/" + video.id + "/cloud", {
        method: "DELETE",
      })
    ).status,
    200,
  );
  assert.equal((await server.request("/api/share/" + token)).status, 404);
});

test("password, expiry and workspace public-link policy are enforced on uploaded copies", async (t) => {
  const server = await start(t),
    client = await start(t);
  const { key } = await (await server.request("/api/cloud/key")).json();
  await connect(client, server, key);
  const video = await uploadFixture(client);
  const result = await (
    await publish(client, video.id, server, {
      access: "link",
      password: "separate-password",
      download: false,
      expiresAt: new Date(Date.now() + 86400000).toISOString(),
    })
  ).json();
  const token = result.cloud.url.split("/s/")[1];
  const blocked = await server.request("/api/share/" + token);
  assert.equal(blocked.status, 401);
  assert.equal((await blocked.json()).requiresPassword, true);
  assert.equal(
    (await server.request("/api/share/" + token + "/media")).status,
    401,
  );
  const unlock = await server.request(
    "/api/share/" + token + "/unlock",
    JSONBody("POST", { password: "separate-password" }),
  );
  assert.equal(unlock.status, 200);
  const grant = unlock.headers.get("set-cookie").split(";")[0];
  assert.equal(
    (
      await server.request("/api/share/" + token, {
        headers: { Cookie: grant },
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await server.request("/api/share/" + token + "/media?download=1", {
        headers: { Cookie: grant },
      })
    ).status,
    403,
  );
  assert.equal((await publish(client, video.id, server)).status, 200);
  assert.equal((await server.request("/api/share/" + token)).status, 401);

  const expired = await (
    await publish(client, video.id, server, {
      access: "link",
      expiresAt: new Date(Date.now() - 86400000).toISOString(),
    })
  ).json();
  assert.equal(
    (await server.request("/api/share/" + expired.cloud.url.split("/s/")[1]))
      .status,
    410,
  );

  server.db
    .prepare(
      "INSERT INTO settings VALUES('sharing',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
    )
    .run(JSON.stringify({ publicLinks: false }));
  const forbidden = await publish(client, video.id, server, { access: "link" });
  assert.equal(forbidden.status, 403);
  assert.equal(
    (await publish(client, video.id, server, { access: "workspace" })).status,
    200,
  );
});

test("changing workspaces cannot forget or remove an earlier published copy", async (t) => {
  const server = await start(t),
    other = await start(t),
    client = await start(t);
  const { key } = await (await server.request("/api/cloud/key")).json();
  const { key: otherKey } = await (
    await other.request("/api/cloud/key")
  ).json();
  await connect(client, server, key);
  const video = await uploadFixture(client);
  const first = await (
    await publish(client, video.id, server, { access: "link" })
  ).json();
  await connect(client, other, otherKey);
  assert.equal((await publish(client, video.id, other)).status, 409);
  assert.equal(
    (
      await client.request("/api/videos/" + video.id + "/cloud", {
        method: "DELETE",
      })
    ).status,
    409,
  );
  const local = await (await client.request("/api/videos/" + video.id)).json();
  assert.equal(local.cloud.url, first.cloud.url);
  assert.equal(
    (await server.request("/api/share/" + first.cloud.url.split("/s/")[1]))
      .status,
    200,
  );
  assert.equal(other.db.prepare("SELECT count(*) AS n FROM videos").get().n, 0);
  await connect(client, server, key);
  assert.equal(
    (
      await client.request("/api/videos/" + video.id + "/cloud", {
        method: "DELETE",
      })
    ).status,
    200,
  );
});

test("a stale destination cannot receive a privacy-controlled upload", async (t) => {
  const server = await start(t),
    client = await start(t);
  const { key } = await (await server.request("/api/cloud/key")).json();
  await connect(client, server, key);
  const video = await uploadFixture(client);
  const refused = await publish(
    client,
    video.id,
    { base: "https://changed.example" },
    { access: "workspace" },
  );
  assert.equal(refused.status, 409);
  assert.equal(
    server.db.prepare("SELECT count(*) AS n FROM videos").get().n,
    0,
  );
  assert.equal(
    (await (await client.request("/api/videos/" + video.id)).json()).cloud,
    undefined,
  );
});

async function protocolWorkspace(t) {
  const state = {
    privacySupported: true,
    wrongReceipt: false,
    confirmRemoval: true,
    uploads: 0,
    live: false,
    publicUrl: undefined,
    uploadGate: null,
    onUpload: null,
    releaseUpload: null,
    removalGate: null,
    onRemoval: null,
    releaseRemoval: null,
  };
  let base;
  const response = () => ({
    url:
      (state.wrongReceipt ? "https://unexpected.example" : base) +
      "/s/fixture_token",
    manageUrl: base + "/video/fixture-video",
    share: {
      access: "workspace",
      download: false,
      expiresAt: null,
      hasPassword: false,
    },
  });
  const listener = http.createServer(async (req, res) => {
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/api/integration/workspace") {
      req.resume();
      return res.end(
        JSON.stringify({
          relay: true,
          privacySupported: state.privacySupported,
          publicUrl: state.publicUrl || base,
          keyScope: "sharing",
        }),
      );
    }
    if (req.method === "POST" && req.url === "/api/integration/publish") {
      for await (const chunk of req) {
        void chunk;
      }
      state.uploads += 1;
      state.onUpload?.();
      if (state.uploadGate) await state.uploadGate;
      state.live = true;
      return res.end(JSON.stringify(response()));
    }
    req.resume();
    if (req.url.startsWith("/api/integration/publish/")) {
      if (req.method === "DELETE") {
        state.onRemoval?.();
        if (state.removalGate) await state.removalGate;
        if (state.confirmRemoval) state.live = false;
        return res.end(JSON.stringify({ ok: state.confirmRemoval }));
      }
      if (state.live) return res.end(JSON.stringify(response()));
    }
    res.writeHead(404).end(JSON.stringify({ error: "Unavailable" }));
  });
  await new Promise((resolve) => listener.listen(0, "127.0.0.1", resolve));
  base = "http://127.0.0.1:" + listener.address().port;
  t.after(async () => {
    state.releaseUpload?.();
    state.releaseRemoval?.();
    await new Promise((resolve) => listener.close(resolve));
  });
  return { base, state, key: "f".repeat(64) };
}

test("unsupported privacy and mismatched public addresses are rejected before uploading", async (t) => {
  const server = await protocolWorkspace(t),
    client = await start(t);
  server.state.privacySupported = false;
  await connect(client, server, server.key);
  const video = await uploadFixture(client);
  const refused = await publish(client, video.id, server, {
    access: "workspace",
  });
  assert.equal(refused.status, 409);
  assert.equal(server.state.uploads, 0);
  assert.equal(
    (await (await client.request("/api/videos/" + video.id)).json()).cloud,
    undefined,
  );

  server.state.publicUrl = "https://different.example";
  assert.equal((await connect(client, server, server.key)).status, 400);
  assert.equal(
    (await publish(client, video.id, server, { access: "workspace" })).status,
    400,
  );
  assert.equal(server.state.uploads, 0);
});

test("stopping sharing prevents a simultaneous upload from restoring the removed copy", async (t) => {
  const server = await protocolWorkspace(t),
    client = await start(t);
  await connect(client, server, server.key);
  const video = await uploadFixture(client);
  assert.equal(
    (await publish(client, video.id, server, { access: "workspace" })).status,
    200,
  );
  server.state.removalGate = new Promise((resolve) => {
    server.state.releaseRemoval = resolve;
  });
  const started = new Promise((resolve) => {
    server.state.onRemoval = resolve;
  });
  const removal = client.request("/api/videos/" + video.id + "/cloud", {
    method: "DELETE",
  });
  await started;
  assert.equal((await publish(client, video.id, server)).status, 409);
  assert.equal(
    (
      await client.request("/api/videos/" + video.id + "/cloud", {
        method: "DELETE",
      })
    ).status,
    409,
  );
  assert.equal(
    (await client.request("/api/cloud", { method: "DELETE" })).status,
    409,
  );
  assert.equal((await connect(client, server, server.key)).status, 409);
  server.state.releaseRemoval();
  assert.equal((await removal).status, 200);
  assert.equal(server.state.live, false);
  assert.equal(server.state.uploads, 1);
  assert.equal(
    (await (await client.request("/api/videos/" + video.id)).json()).cloud,
    undefined,
  );
});

test("uncertain uploads stay manageable and removal needs an explicit server acknowledgement", async (t) => {
  const server = await protocolWorkspace(t),
    client = await start(t);
  await connect(client, server, server.key);
  const video = await uploadFixture(client);
  server.state.wrongReceipt = true;
  server.state.uploadGate = new Promise((resolve) => {
    server.state.releaseUpload = resolve;
  });
  const started = new Promise((resolve) => {
    server.state.onUpload = resolve;
  });
  const upload = publish(client, video.id, server, { access: "workspace" });
  await started;
  assert.equal(
    (await client.request("/api/cloud", { method: "DELETE" })).status,
    409,
  );
  assert.equal(
    (await connect(client, { base: "http://127.0.0.1:9" }, server.key)).status,
    409,
  );
  server.state.releaseUpload();
  assert.equal((await upload).status, 502);
  assert.equal(server.state.live, true);
  const uncertain = await (
    await client.request("/api/videos/" + video.id)
  ).json();
  assert.equal(uncertain.cloud.unverified, true);
  assert.equal(uncertain.cloud.url, server.base);
  assert.ok(!JSON.stringify(uncertain.cloud).includes("unexpected.example"));

  // A fresh status request can reconcile a lost or invalid upload receipt.
  server.state.wrongReceipt = false;
  assert.equal(
    (await client.request("/api/videos/" + video.id + "/cloud")).status,
    200,
  );
  const recovered = await (
    await client.request("/api/videos/" + video.id)
  ).json();
  assert.equal(recovered.cloud.unverified, false);
  assert.equal(recovered.cloud.url, server.base + "/s/fixture_token");

  server.state.confirmRemoval = false;
  assert.equal(
    (
      await client.request("/api/videos/" + video.id + "/cloud", {
        method: "DELETE",
      })
    ).status,
    502,
  );
  assert.equal(
    (await (await client.request("/api/videos/" + video.id)).json()).cloud.url,
    recovered.cloud.url,
  );
  server.state.confirmRemoval = true;
  assert.equal(
    (
      await client.request("/api/videos/" + video.id + "/cloud", {
        method: "DELETE",
      })
    ).status,
    200,
  );
  assert.equal(
    (await (await client.request("/api/videos/" + video.id)).json()).cloud,
    undefined,
  );
  assert.equal(server.state.live, false);
});

test("resetting a sharing key rejects an upload authenticated before the reset", async (t) => {
  const server = await start(t, { password: "owner-password-123" });
  const login = await server.request(
    "/api/session",
    JSONBody("POST", { password: "owner-password-123" }),
  );
  const ownerCookie = login.headers.get("set-cookie").split(";")[0];
  const { key } = await (
    await server.request("/api/cloud/key", { headers: { Cookie: ownerCookie } })
  ).json();
  const boundary = "relay-inflight-reset";
  const payload = Buffer.concat([
    Buffer.from(
      "--" +
        boundary +
        '\r\nContent-Disposition: form-data; name="source"\r\n\r\ninflight-source-0001\r\n--' +
        boundary +
        '\r\nContent-Disposition: form-data; name="duration"\r\n\r\n7\r\n--' +
        boundary +
        '\r\nContent-Disposition: form-data; name="video"; filename="privacy.mp4"\r\nContent-Type: video/mp4\r\n\r\n',
    ),
    readFileSync("scripts/assets/presenter.mp4"),
    Buffer.from("\r\n--" + boundary + "--\r\n"),
  ]);
  let continued;
  const ready = new Promise((resolve) => {
    continued = resolve;
  });
  const request = http.request(server.base + "/api/integration/publish", {
    method: "POST",
    headers: {
      Authorization: "Bearer " + key,
      Expect: "100-continue",
      "Content-Type": "multipart/form-data; boundary=" + boundary,
      "Content-Length": payload.length,
    },
  });
  request.once("continue", continued);
  const response = new Promise((resolve, reject) => {
    request.once("error", reject);
    request.once("response", (res) => {
      res.resume();
      res.once("end", () => resolve(res.statusCode));
    });
  });
  try {
    request.flushHeaders();
    await ready;
    const reset = await server.request("/api/cloud/key/reset", {
      method: "POST",
      headers: { Cookie: ownerCookie },
    });
    assert.equal(reset.status, 200);
    request.end(payload);
    assert.equal(await response, 401);
    assert.equal(
      server.db.prepare("SELECT count(*) AS n FROM videos").get().n,
      0,
    );
    assert.equal(
      readdirSync(path.join(server.dir, "media")).filter((name) =>
        name.endsWith(".mp4"),
      ).length,
      0,
    );
  } finally {
    request.destroy();
  }
});
