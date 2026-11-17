import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createApp } from "../server/app.mjs";
import { passwordHash } from "../server/studio/auth.mjs";

// A password-protected workspace with an owner, an editor and a viewer.
async function workspace(t, password = "owner-password-123") {
  const dir = mkdtempSync(path.join(os.tmpdir(), "relay-password-"));
  const { app, db, close } = createApp({ dataDir: dir, password });
  for (const [id, role] of [
    ["v1", "viewer"],
    ["e1", "editor"],
  ])
    db.prepare("INSERT INTO members VALUES(?,?,?,?,?,?)").run(
      id,
      `${role}@example.com`,
      role,
      role,
      passwordHash(`${role}-password-1`),
      new Date().toISOString(),
    );
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    await new Promise((r) => server.close(r));
    close();
    rmSync(dir, { recursive: true, force: true });
  });
  const send = async (p, method = "GET", body, cookie = "") => {
    const r = await fetch(base + p, {
      method,
      headers: { "Content-Type": "application/json", cookie },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return {
      status: r.status,
      body: await r.json().catch(() => null),
      cookie: r.headers.get("set-cookie")?.split(";")[0] || "",
    };
  };
  // Signs in and returns the session cookie, or "" when the password is refused.
  const login = async (email, password) =>
    (await send("/api/session", "POST", { email, password })).cookie;
  const signedIn = async (cookie) =>
    (await send("/api/team", "GET", undefined, cookie)).status === 200;
  return { base, db, send, login, signedIn };
}
const OWNER = ["owner@relay.local", "owner-password-123"],
  EDITOR = ["editor@example.com", "editor-password-1"],
  VIEWER = ["viewer@example.com", "viewer-password-1"];

test("a member changes their own password, which signs out their other sessions", async (t) => {
  const { send, login, signedIn } = await workspace(t);
  const here = await login(...EDITOR),
    elsewhere = await login(...EDITOR),
    viewer = await login(...VIEWER);
  assert.ok(here && elsewhere && here !== elsewhere);

  const wrong = await send(
    "/api/password",
    "PUT",
    { current: "not-my-password", password: "a-brand-new-password" },
    here,
  );
  assert.equal(wrong.status, 403);
  assert.ok(await login(...EDITOR), "the password is unchanged");
  const short = await send(
    "/api/password",
    "PUT",
    { current: EDITOR[1], password: "too-short" },
    here,
  );
  assert.equal(short.status, 400);
  assert.equal(
    (
      await send("/api/password", "PUT", {
        current: EDITOR[1],
        password: "a-brand-new-password",
      })
    ).status,
    401,
    "nobody changes a password without being signed in",
  );
  assert.ok(await signedIn(elsewhere), "refused attempts sign nobody out");

  const changed = await send(
    "/api/password",
    "PUT",
    { current: EDITOR[1], password: "a-brand-new-password" },
    here,
  );
  assert.equal(changed.status, 200, changed.body?.error);
  assert.equal(await login(...EDITOR), "", "the old password stops working");
  assert.ok(await login(EDITOR[0], "a-brand-new-password"));
  assert.ok(await signedIn(here), "the session that made the change stays");
  assert.equal(await signedIn(elsewhere), false, "other sessions are ended");
  assert.ok(await signedIn(viewer), "other members are left alone");
});

test("a view-only member can change their password too", async (t) => {
  const { send, login } = await workspace(t);
  const cookie = await login(...VIEWER);
  const changed = await send(
    "/api/password",
    "PUT",
    { current: VIEWER[1], password: "viewer-new-password" },
    cookie,
  );
  assert.equal(changed.status, 200, changed.body?.error);
  assert.ok(await login(VIEWER[0], "viewer-new-password"));
});

test("the owner changes their own password, and a new ADMIN_PASSWORD on the server replaces it", async (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "relay-password-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  // Starts Relay on the same library with the given ADMIN_PASSWORD.
  const start = async (password) => {
    const { app, db, close } = createApp({ dataDir: dir, password });
    const server = app.listen(0, "127.0.0.1");
    await new Promise((r) => server.once("listening", r));
    const base = `http://127.0.0.1:${server.address().port}`;
    const send = async (p, method = "GET", body, cookie = "") => {
      const r = await fetch(base + p, {
        method,
        headers: { "Content-Type": "application/json", cookie },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return {
        status: r.status,
        body: await r.json().catch(() => null),
        cookie: r.headers.get("set-cookie")?.split(";")[0] || "",
      };
    };
    return {
      db,
      send,
      login: async (password) =>
        (await send("/api/session", "POST", { email: OWNER[0], password }))
          .cookie,
      stop: async () => {
        await new Promise((r) => server.close(r));
        close();
      },
    };
  };
  const chosen = "a-password-the-owner-chose";
  let relay = await start(OWNER[1]);
  const owner = await relay.login(OWNER[1]);
  assert.equal(
    (await relay.send("/api/team", "GET", undefined, owner)).body.password,
    "server",
  );
  const wrong = await relay.send(
    "/api/password",
    "PUT",
    { current: "not-my-password", password: chosen },
    owner,
  );
  assert.equal(wrong.status, 403);
  const change = await relay.send(
    "/api/password",
    "PUT",
    { current: OWNER[1], password: chosen },
    owner,
  );
  assert.equal(change.status, 200, change.body?.error);
  assert.equal(await relay.login(OWNER[1]), "");
  assert.ok(await relay.login(chosen));
  // The owner has no use for a reset link: they are told where to go instead.
  const link = await relay.send(
    "/api/team/owner/password-reset",
    "POST",
    {},
    owner,
  );
  assert.equal(link.status, 400);
  assert.match(link.body.error, /ADMIN_PASSWORD/);
  await relay.stop();

  // Restarting with the same ADMIN_PASSWORD keeps the password they chose.
  relay = await start(OWNER[1]);
  assert.ok(await relay.login(chosen));
  assert.equal(await relay.login(OWNER[1]), "");
  await relay.stop();

  // A new ADMIN_PASSWORD is how a forgotten one is replaced.
  relay = await start("a-new-server-password");
  assert.ok(await relay.login("a-new-server-password"));
  assert.equal(await relay.login(chosen), "");
  await relay.stop();
  relay = await start("a-new-server-password");
  assert.ok(await relay.login("a-new-server-password"));
  // A library from before Relay kept track is treated as it always was: the
  // owner's password is whatever ADMIN_PASSWORD says.
  const cookie = await relay.login("a-new-server-password");
  await relay.send(
    "/api/password",
    "PUT",
    { current: "a-new-server-password", password: chosen },
    cookie,
  );
  relay.db
    .prepare("DELETE FROM settings WHERE key='owner_password_from'")
    .run();
  await relay.stop();
  relay = await start("a-new-server-password");
  assert.ok(await relay.login("a-new-server-password"));
  assert.equal(await relay.login(chosen), "");
  await relay.stop();
});

test("a workspace without a password has none to change or reset", async (t) => {
  const { send } = await workspace(t, "");
  assert.equal((await send("/api/team")).body.password, "none");
  assert.equal(
    (
      await send("/api/password", "PUT", {
        current: "",
        password: "a-brand-new-password",
      })
    ).status,
    400,
  );
  assert.equal(
    (await send("/api/team/e1/password-reset", "POST", {})).status,
    400,
  );
});

test("only the owner can create a reset link", async (t) => {
  const { send, login, db } = await workspace(t);
  for (const who of [EDITOR, VIEWER]) {
    const r = await send(
      "/api/team/v1/password-reset",
      "POST",
      {},
      await login(...who),
    );
    assert.equal(r.status, 403, who[0]);
    assert.equal(r.body.token, undefined);
  }
  assert.equal(
    (await send("/api/team/v1/password-reset", "POST", {})).status,
    401,
  );
  assert.equal(db.prepare("SELECT * FROM password_resets").all().length, 0);
  assert.equal(
    (
      await send(
        "/api/team/nobody/password-reset",
        "POST",
        {},
        await login(...OWNER),
      )
    ).status,
    404,
  );
});

test("a reset link sets a new password once and signs the member out", async (t) => {
  const { send, login, signedIn, db } = await workspace(t);
  const owner = await login(...OWNER),
    editor = await login(...EDITOR);
  const made = await send("/api/team/e1/password-reset", "POST", {}, owner);
  assert.equal(made.status, 201);
  const { token, expires } = made.body;
  assert.match(token, /^[A-Za-z0-9_-]{43}$/);
  assert.ok(Math.abs(expires - (Date.now() + 86400000)) < 60000);
  // The link itself is not kept, only a hash of it.
  const stored = db.prepare("SELECT * FROM password_resets").all();
  assert.equal(stored.length, 1);
  assert.ok(!JSON.stringify(stored).includes(token));

  const shown = await send(`/api/password-resets/${token}`);
  assert.equal(shown.status, 200);
  assert.deepEqual(shown.body, { name: "editor", email: "editor@example.com" });
  const short = await send(`/api/password-resets/${token}`, "POST", {
    password: "short",
  });
  assert.equal(short.status, 400);
  assert.ok(await signedIn(editor), "nothing changes until a password is set");

  const used = await send(`/api/password-resets/${token}`, "POST", {
    password: "a-reset-password-1",
  });
  assert.equal(used.status, 200, used.body?.error);
  assert.equal(used.cookie, "", "the link signs nobody in");
  assert.equal(await signedIn(editor), false, "every session is ended");
  assert.equal(await login(...EDITOR), "", "the old password stops working");
  assert.ok(await login(EDITOR[0], "a-reset-password-1"));
  assert.ok(await signedIn(owner), "other members are left alone");

  const again = await send(`/api/password-resets/${token}`, "POST", {
    password: "a-second-password-1",
  });
  assert.equal(again.status, 404);
  assert.equal((await send(`/api/password-resets/${token}`)).status, 404);
  assert.equal(await login(EDITOR[0], "a-second-password-1"), "");
  assert.ok(await login(EDITOR[0], "a-reset-password-1"));
});

test("an expired, replaced or made-up reset link is refused the same way", async (t) => {
  const { send, login, db } = await workspace(t);
  const owner = await login(...OWNER);
  const link = async () =>
    (await send("/api/team/e1/password-reset", "POST", {}, owner)).body.token;

  const replaced = await link(),
    current = await link();
  db.prepare("UPDATE password_resets SET expires=?").run(Date.now() - 1000);
  const answers = [];
  for (const token of [replaced, current, "made-up-link", ""]) {
    for (const method of ["GET", "POST"]) {
      const r = await send(
        `/api/password-resets/${token || "%20"}`,
        method,
        method === "POST" ? { password: "a-reset-password-1" } : undefined,
      );
      answers.push(`${r.status} ${r.body.error}`);
    }
  }
  assert.equal(new Set(answers).size, 1, answers.join("\n"));
  assert.match(answers[0], /^404 This reset link has expired/);
  assert.ok(await login(...EDITOR), "the password is unchanged");

  // Changing the password yourself cancels a link that was waiting.
  const waiting = await link();
  const editor = await login(...EDITOR);
  await send(
    "/api/password",
    "PUT",
    { current: EDITOR[1], password: "a-brand-new-password" },
    editor,
  );
  assert.equal((await send(`/api/password-resets/${waiting}`)).status, 404);

  // So does removing the member.
  const last = await send("/api/team/v1/password-reset", "POST", {}, owner);
  await send("/api/team/v1", "DELETE", undefined, owner);
  assert.equal(
    (await send(`/api/password-resets/${last.body.token}`)).status,
    404,
  );
  assert.equal(db.prepare("SELECT * FROM password_resets").all().length, 0);
});

test("reset link guesses are slowed down across links, not per link", async (t) => {
  const { send, login } = await workspace(t);
  const owner = await login(...OWNER);
  const { token } = (
    await send("/api/team/e1/password-reset", "POST", {}, owner)
  ).body;
  const statuses = [];
  for (let i = 0; i < 12; i++)
    statuses.push(
      (
        await send(`/api/password-resets/guess-number-${i}`, "POST", {
          password: "a-guessed-password",
        })
      ).status,
    );
  assert.deepEqual(statuses.slice(0, 10), Array(10).fill(404));
  assert.deepEqual(statuses.slice(10), [429, 429]);
  // Even the real link has to wait once an address has guessed too often.
  assert.equal(
    (
      await send(`/api/password-resets/${token}`, "POST", {
        password: "a-reset-password-1",
      })
    ).status,
    429,
  );
});
