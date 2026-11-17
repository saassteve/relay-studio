import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import http from "node:http";
import path from "node:path";
import { createApp } from "../server/app.mjs";
import { passwordHash } from "../server/studio/auth.mjs";
import { withTags } from "../server/studio/preview.mjs";
import { publishedProject } from "../server/studio/project.mjs";

// The page the app is built from, so the tags are tested against the real one.
const SHELL = readFileSync(new URL("../index.html", import.meta.url), "utf8");
// The smallest thing that passes for a stored thumbnail.
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 0xff, 0xd9]),
  THUMBNAIL = `data:image/jpeg;base64,${JPEG.toString("base64")}`;

async function workspace(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "relay-preview-"));
  const { app, db, close } = createApp({
    dataDir: dir,
    password: "owner-password-123",
    shell: async () => SHELL,
  });
  db.prepare("INSERT INTO members VALUES(?,?,?,?,?,?)").run(
    "e1",
    "editor@example.com",
    "Editor",
    "editor",
    passwordHash("editor-password-1"),
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
  let n = 0;
  // A shared library row without a file behind it, which is all a preview needs.
  const video = (token, { share = {}, ...fields } = {}) => {
    const row = {
      title: "Quarterly roadmap",
      description: "",
      thumbnail: THUMBNAIL,
      outline: "{}",
      ...fields,
    };
    db.prepare(
      "INSERT INTO videos(id,title,description,duration,size,mime,filename,thumbnail,created,token,share_config,outline) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
    ).run(
      `00000000-0000-0000-0000-${String(++n).padStart(12, "0")}`,
      row.title,
      row.description,
      10,
      1,
      "video/mp4",
      `${n}.mp4`,
      row.thumbnail,
      new Date().toISOString(),
      token,
      JSON.stringify(share),
      row.outline,
    );
  };
  const page = async (p, headers = {}) => {
    const r = await fetch(base + p, { headers });
    return { status: r.status, headers: r.headers, html: await r.text() };
  };
  // The same page, asked for under another host name (fetch won't send one).
  const pageAs = (p, host) =>
    new Promise((resolve, reject) =>
      http
        .get(base + p, { headers: { Host: host } }, (res) => {
          let html = "";
          res.setEncoding("utf8");
          res.on("data", (chunk) => (html += chunk));
          res.on("end", () => resolve({ status: res.statusCode, html }));
        })
        .on("error", reject),
    );
  const login = async (body) =>
    (
      await fetch(`${base}/api/session`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })
    ).headers
      .get("set-cookie")
      .split(";")[0];
  return { base, db, video, page, pageAs, login };
}
// The content of one tag, exactly as written in the page.
const content = (html, name) =>
  html.match(
    new RegExp(`<meta (?:property|name)="${name}" content="([^"]*)" />`),
  )?.[1];
const GENERIC = (html) => {
  assert.match(html, /<title>Relay<\/title>/);
  assert.equal(html.match(/<title>/g).length, 1);
  assert.equal(content(html, "og:title"), "Relay");
  assert.equal(content(html, "robots"), "noindex");
  for (const name of ["og:description", "description", "og:image", "og:url"])
    assert.equal(content(html, name), undefined, name);
  assert.doesNotMatch(html, /roadmap|thumbnail\.jpg|secret/i);
  // Still the app's page, so the watch screen loads and explains itself.
  assert.match(html, /<div id="root"><\/div>/);
};

test("a public link's page carries its title, description and picture", async (t) => {
  const { base, video, page } = await workspace(t);
  video("public-link", {
    description: "  What we plan to ship,\n and when.  ",
  });
  const r = await page("/s/public-link");
  assert.equal(r.status, 200);
  assert.match(r.headers.get("content-type"), /^text\/html/);
  assert.equal(r.headers.get("cache-control"), "no-cache");
  assert.match(r.html, /<title>Quarterly roadmap · Relay<\/title>/);
  assert.equal(r.html.match(/<title>/g).length, 1);
  assert.equal(content(r.html, "og:title"), "Quarterly roadmap");
  assert.equal(
    content(r.html, "og:description"),
    "What we plan to ship, and when.",
  );
  assert.equal(
    content(r.html, "description"),
    "What we plan to ship, and when.",
  );
  assert.equal(r.html.match(/name="description"/g).length, 1);
  assert.equal(content(r.html, "og:type"), "video.other");
  assert.equal(content(r.html, "og:site_name"), "Relay");
  // Shared with the people it was sent to, not with search engines.
  assert.equal(content(r.html, "robots"), "noindex");
  assert.equal(content(r.html, "og:url"), `${base}/s/public-link`);
  assert.equal(content(r.html, "twitter:card"), "summary_large_image");
  const image = content(r.html, "og:image");
  assert.equal(image, `${base}/api/share/public-link/thumbnail.jpg?r=0`);
  // The tags sit inside the head, and the app still loads.
  assert.ok(r.html.indexOf("og:title") < r.html.indexOf("</head>"));
  assert.match(r.html, /<script type="module" src="\/src\/main\.tsx">/);

  const picture = await fetch(image);
  assert.equal(picture.status, 200);
  assert.equal(picture.headers.get("content-type"), "image/jpeg");
  assert.equal(picture.headers.get("cache-control"), "public, max-age=300");
  assert.equal(picture.headers.get("x-content-type-options"), "nosniff");
  assert.deepEqual(Buffer.from(await picture.arrayBuffer()), JPEG);

  // The embed address describes the same video and points at its watch page.
  const embed = await page("/embed/public-link");
  assert.equal(content(embed.html, "og:title"), "Quarterly roadmap");
  assert.equal(content(embed.html, "og:url"), `${base}/s/public-link`);
});

test("a title can't break out of its tag", async (t) => {
  const { video, page, pageAs } = await workspace(t);
  const title = `"><script>alert(1)</script><meta content='x' & $& $' </title></head>`;
  video("hostile", { title, description: `"><img src=x onerror=alert(2)>` });
  const { html } = await page("/s/hostile");
  assert.doesNotMatch(html, /<script>alert|<img|onerror=alert\(2\)>/);
  assert.equal(html.match(/<\/head>/g).length, 1);
  assert.equal(html.match(/<\/title>/g).length, 1);
  // The page has the scripts every page of the app has, and no more.
  const plain = (await page("/s/no-such-link")).html;
  assert.equal(
    html.match(/<script/g).length,
    plain.match(/<script/g).length,
    "only the app's own scripts",
  );
  const unescape = (s) =>
    s.replace(/&#(\d+);/g, (_, code) => String.fromCharCode(code));
  assert.equal(unescape(content(html, "og:title")), title);
  assert.equal(
    unescape(html.match(/<title>([^<]*)<\/title>/)[1]),
    `${title} · Relay`,
  );
  assert.equal(
    unescape(content(html, "og:description")),
    `"><img src=x onerror=alert(2)>`,
  );
  // The same holds for the address the request claims to be for.
  const spoofed = await pageAs("/s/hostile", `x"><script>y`);
  assert.equal(spoofed.status, 200);
  assert.equal(
    spoofed.html.match(/<script/g).length,
    plain.match(/<script/g).length,
  );
  assert.equal(
    unescape(content(spoofed.html, "og:url")),
    `http://x"><script>y/s/hostile`,
  );
});

test("a long description is cut to a line, and a summary stands in for a missing one", async (t) => {
  const { base, db, video, page } = await workspace(t);
  video("long", { description: "word ".repeat(200) });
  const long = content((await page("/s/long")).html, "og:description");
  assert.ok(long.length <= 200, String(long.length));
  assert.match(long, /word…$/);

  // A summary written for an earlier cut of the video is not shown on the watch
  // page, so it is not shown in the preview either.
  video("stale", {
    outline: JSON.stringify({
      summary: "A walk through the old plan.",
      projectSegments: "something else",
    }),
  });
  assert.equal(
    content((await page("/s/stale")).html, "og:description"),
    undefined,
  );
  video("current");
  const row = db.prepare("SELECT * FROM videos WHERE token='current'").get();
  db.prepare("UPDATE videos SET outline=? WHERE id=?").run(
    JSON.stringify({
      summary: "A walk through the plan.",
      projectSegments: JSON.stringify(publishedProject(row).segments),
    }),
    row.id,
  );
  const watch = await (await fetch(`${base}/api/share/current`)).json();
  assert.equal(watch.outline.summary, "A walk through the plan.");
  assert.equal(
    content((await page("/s/current")).html, "og:description"),
    "A walk through the plan.",
  );
});

test("a video without a picture gets a plain card", async (t) => {
  const { video, page, base } = await workspace(t);
  video("no-picture", { thumbnail: null });
  video("odd-picture", { thumbnail: "data:image/svg+xml;base64,PHN2Zz4=" });
  for (const token of ["no-picture", "odd-picture"]) {
    const { html } = await page(`/s/${token}`);
    assert.equal(content(html, "og:title"), "Quarterly roadmap");
    assert.equal(content(html, "og:image"), undefined);
    assert.equal(content(html, "twitter:card"), "summary");
    const picture = await fetch(`${base}/api/share/${token}/thumbnail.jpg`);
    assert.equal(picture.status, 404);
    assert.match(picture.headers.get("content-type"), /^application\/json/);
  }
});

test("links that aren't open to everyone give nothing away", async (t) => {
  const { base, db, video, page, login } = await workspace(t);
  const secret = { title: "Secret roadmap", description: "Secret plans." };
  video("locked", {
    ...secret,
    share: { passwordHash: passwordHash("video-password"), version: 1 },
  });
  video("members", { ...secret, share: { access: "workspace" } });
  video("invited", {
    ...secret,
    share: { access: "invited", invitedEmails: ["editor@example.com"] },
  });
  video("expired", {
    ...secret,
    share: { expiresAt: new Date(Date.now() - 60000).toISOString() },
  });
  video(null, secret);
  video("was-on", secret);
  db.prepare("UPDATE videos SET token=NULL WHERE token='was-on'").run();

  const owner = await login({ password: "owner-password-123" }),
    editor = await login({
      email: "editor@example.com",
      password: "editor-password-1",
    });
  // Someone who has entered the video's password holds a cookie for it.
  const unlock = await fetch(`${base}/api/share/locked/unlock`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password: "video-password" }),
  });
  assert.equal(unlock.status, 200);
  const grant = unlock.headers.get("set-cookie").split(";")[0];

  for (const token of [
    "locked",
    "members",
    "invited",
    "expired",
    "was-on",
    "null",
    "never-existed",
  ]) {
    // A preview is shown to everyone in a chat, so it is the same whoever asks.
    for (const cookie of ["", owner, editor, grant]) {
      for (const route of ["s", "embed"]) {
        const r = await page(`/${route}/${token}`, { cookie });
        assert.equal(r.status, 200, token);
        GENERIC(r.html);
      }
      const picture = await fetch(`${base}/api/share/${token}/thumbnail.jpg`, {
        headers: { cookie },
      });
      const anonymous = await fetch(`${base}/api/share/${token}`);
      assert.ok([401, 404, 410].includes(picture.status), token);
      assert.equal(picture.status, anonymous.status, token);
      assert.match(picture.headers.get("content-type"), /^application\/json/);
      assert.equal(picture.headers.get("cache-control"), "no-store");
      assert.doesNotMatch(await picture.text(), /roadmap|plans/i);
    }
  }
  // The checks above are not passing by accident: these people can watch.
  assert.equal(
    (await fetch(`${base}/api/share/locked`, { headers: { cookie: grant } }))
      .status,
    200,
  );
  assert.equal(
    (await fetch(`${base}/api/share/invited`, { headers: { cookie: editor } }))
      .status,
    200,
  );
});

test("PUBLIC_URL is the address a preview points at", async (t) => {
  const before = process.env.PUBLIC_URL;
  process.env.PUBLIC_URL = "https://relay.example.com/";
  t.after(() =>
    before === undefined
      ? delete process.env.PUBLIC_URL
      : (process.env.PUBLIC_URL = before),
  );
  const { video, pageAs } = await workspace(t);
  video("public-link");
  const { html } = await pageAs("/s/public-link", "evil.example.net");
  assert.equal(
    content(html, "og:url"),
    "https://relay.example.com/s/public-link",
  );
  assert.equal(
    content(html, "og:image"),
    "https://relay.example.com/api/share/public-link/thumbnail.jpg?r=0",
  );
  assert.doesNotMatch(html, /evil\.example\.net/);
});

test("a page without a head is left alone", () => {
  assert.equal(withTags("<p>Hello</p>", ["<title>x</title>"]), "<p>Hello</p>");
});
