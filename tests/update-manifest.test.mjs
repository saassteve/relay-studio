import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import {
  appendFileSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import {
  chosenFile,
  describe,
  parse,
  serialize,
  verify,
  write,
} from "../scripts/update-manifest.mjs";

const require = createRequire(import.meta.url);
const script = path.resolve("scripts/update-manifest.mjs");

function release() {
  const folder = mkdtempSync(path.join(os.tmpdir(), "relay-manifest-"));
  const zips = {
    "Relay-mac-arm64.zip": randomBytes(70_001),
    "Relay-mac-x64.zip": randomBytes(90_003),
  };
  for (const [name, data] of Object.entries(zips))
    writeFileSync(path.join(folder, name), data);
  return {
    folder,
    zips,
    paths: Object.keys(zips).map((name) => path.join(folder, name)),
    remove: () => rmSync(folder, { recursive: true, force: true }),
  };
}

test("the manifest lists both ZIPs with their size and base64 sha512", async () => {
  const r = release();
  try {
    const text = await write("1.2.3", r.folder, r.paths);
    assert.equal(
      readFileSync(path.join(r.folder, "latest-mac.yml"), "utf8"),
      text,
    );
    const manifest = parse(text);
    assert.equal(manifest.version, "1.2.3");
    // Intel first, as electron-builder writes it for separate builds.
    assert.deepEqual(
      manifest.files.map((f) => f.url),
      ["Relay-mac-x64.zip", "Relay-mac-arm64.zip"],
    );
    for (const f of manifest.files) {
      assert.equal(f.size, r.zips[f.url].length);
      assert.equal(
        f.sha512,
        createHash("sha512").update(r.zips[f.url]).digest("base64"),
      );
    }
    assert.match(text, /^path: Relay-mac-x64\.zip$/m);
    assert.match(text, /^releaseDate: '\d{4}-\d\d-\d\dT[\d:.]+Z'$/m);
    assert.deepEqual(await verify("1.2.3", r.folder), {
      ...manifest,
      arm64: "Relay-mac-arm64.zip",
      x64: "Relay-mac-x64.zip",
    });
  } finally {
    r.remove();
  }
});

test("electron-updater reads the manifest and picks the right ZIP for each Mac", async () => {
  const r = release();
  try {
    const text = await write("1.2.3", r.folder, r.paths);
    // The updater's own code, not a copy of it.
    const {
      parseUpdateInfo,
      resolveFiles,
      findFile,
    } = require("electron-updater/out/providers/Provider");
    const { MacUpdater } = require("electron-updater/out/MacUpdater");
    const info = parseUpdateInfo(text, "latest-mac.yml", "test");
    assert.equal(info.version, "1.2.3");
    assert.equal(typeof info.releaseDate, "string");
    const files = resolveFiles(
      info,
      new URL("https://example.com/releases/download/v1.2.3/"),
    );
    for (const [arm64Mac, expected] of [
      [true, "Relay-mac-arm64.zip"],
      [false, "Relay-mac-x64.zip"],
    ]) {
      const picked = findFile(
        MacUpdater.filterFilesForArch(files, arm64Mac),
        "zip",
        ["pkg", "dmg"],
      );
      assert.equal(picked.info.url, expected);
      assert.equal(
        picked.url.href,
        `https://example.com/releases/download/v1.2.3/${expected}`,
      );
      assert.equal(picked.info.size, r.zips[expected].length);
      assert.equal(
        picked.info.sha512,
        createHash("sha512").update(r.zips[expected]).digest("base64"),
      );
      // The script's own check agrees with the updater.
      assert.equal(chosenFile(info.files, arm64Mac).url, expected);
    }
  } finally {
    r.remove();
  }
});

test("preview versions round-trip through the manifest and electron-updater", async () => {
  const r = release();
  try {
    const {
      parseUpdateInfo,
    } = require("electron-updater/out/providers/Provider");
    for (const version of ["0.7.1-local.2", "1.2.3-beta.1+build.42"]) {
      const text = await write(version, r.folder, r.paths);
      assert.equal((await verify(version, r.folder)).version, version);
      assert.equal(
        parseUpdateInfo(text, "latest-mac.yml", "test").version,
        version,
      );
    }
    for (const version of [
      "1.2.3-",
      "1.2.3-beta..1",
      "1.2.3-01",
      "01.2.3",
      "1.2.3+",
    ]) {
      await assert.rejects(describe(version, r.paths), /not a version/);
      const text = serialize({
        version,
        files: (await describe("1.2.3", r.paths)).files,
      });
      assert.throws(() => parse(text), /no version/);
    }
  } finally {
    r.remove();
  }
});

test("a manifest that no longer matches its files is refused", async () => {
  const r = release();
  try {
    await write("1.2.3", r.folder, r.paths);
    await assert.rejects(verify("1.2.4", r.folder), /is for 1\.2\.3/);
    // Same size, different bytes.
    const arm = path.join(r.folder, "Relay-mac-arm64.zip");
    writeFileSync(arm, randomBytes(70_001));
    await assert.rejects(
      verify("1.2.3", r.folder),
      /does not match its sha512/,
    );
    appendFileSync(arm, "x");
    await assert.rejects(verify("1.2.3", r.folder), /70002 bytes/);
    rmSync(arm);
    await assert.rejects(verify("1.2.3", r.folder), /which is not in/);
  } finally {
    r.remove();
  }
});

test("a release needs one ZIP for each kind of Mac", async () => {
  const r = release();
  try {
    await assert.rejects(describe("1.2.3", [r.paths[0]]), /exactly two ZIPs/);
    await assert.rejects(
      describe("1.2.3", [r.paths[0], r.paths[0]]),
      /listed twice/,
    );
    const dmg = path.join(r.folder, "Relay-mac-x64.dmg");
    writeFileSync(dmg, "disk image");
    await assert.rejects(describe("1.2.3", [r.paths[0], dmg]), /not a ZIP/);
    await assert.rejects(describe("v1.2.3", r.paths), /not a version/);
    await assert.rejects(describe("1.2", r.paths), /not a version/);
  } finally {
    r.remove();
  }
});

test("only the exact format is read back", async () => {
  const r = release();
  try {
    const text = serialize(await describe("1.2.3", r.paths));
    assert.throws(() => parse(text + "extra: 1\n"), /unexpected content/);
    assert.throws(
      () => parse(text.replace(/^path: .*$/m, "path: Other.zip")),
      /repeat the first file/,
    );
    assert.throws(
      () => parse(text.replace(/sha512: \S{10}/, "sha512: !!!!!!!!!!")),
      /not valid/,
    );
    assert.throws(() => parse("version: 1.2.3\n"), /a list of files/);
  } finally {
    r.remove();
  }
});

test("the command line writes, verifies and fails with a message", async () => {
  const r = release();
  try {
    const out = execFileSync(
      process.execPath,
      [script, "write", "1.2.3", r.folder, ...r.paths],
      { encoding: "utf8" },
    );
    assert.match(out, /Relay 1\.2\.3, Relay-mac-arm64\.zip \(Apple Silicon\)/);
    assert.match(
      execFileSync(process.execPath, [script, "verify", "1.2.3", r.folder], {
        encoding: "utf8",
      }),
      /matches Relay-mac-arm64\.zip and Relay-mac-x64\.zip/,
    );
    writeFileSync(
      path.join(r.folder, "Relay-mac-x64.zip"),
      randomBytes(90_003),
    );
    const bad = spawnSync(
      process.execPath,
      [script, "verify", "1.2.3", r.folder],
      { encoding: "utf8" },
    );
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /Relay-mac-x64\.zip does not match its sha512/);
    assert.equal(spawnSync(process.execPath, [script, "write"]).status, 2);
  } finally {
    r.remove();
  }
});
