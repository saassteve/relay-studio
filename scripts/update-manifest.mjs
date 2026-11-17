// Writes and checks latest-mac.yml, the file a released copy of Relay reads to find
// its update (desktop/updates.cjs, through electron-updater).
//
//   node scripts/update-manifest.mjs write <version> <folder> <zip>...
//   node scripts/update-manifest.mjs verify <version> <folder>
//
// electron-builder would normally write this file, but Relay is signed and
// notarized after electron-builder has packed it (scripts/release-mac.sh), so the
// hashes have to be taken from the finished ZIPs.
//
// The updater installs from a ZIP, never the disk image. It reads `version`, and
// for each entry of `files` its `url`, `sha512` (base64) and `size`. An Apple
// Silicon Mac takes the entry whose name contains "arm64"; an Intel Mac takes the
// one whose name does not. `path` and the top-level `sha512` are what updaters
// older than electron-updater 2.16 read; electron-builder still writes them.
import { createHash } from "node:crypto";
import {
  createReadStream,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const MANIFEST = "latest-mac.yml";
const NUMBER = "(?:0|[1-9]\\d*)";
const PRERELEASE = "(?:0|[1-9]\\d*|\\d*[A-Za-z-][\\dA-Za-z-]*)";
const VERSION = new RegExp(
  `^${NUMBER}\\.${NUMBER}\\.${NUMBER}` +
    `(?:-${PRERELEASE}(?:\\.${PRERELEASE})*)?` +
    "(?:\\+[\\dA-Za-z-]+(?:\\.[\\dA-Za-z-]+)*)?$",
);
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*\.zip$/;
const SHA512 = /^[A-Za-z0-9+/]{86}==$/;

const isArm64 = (name) => name.includes("arm64");

export function sha512(file) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha512");
    createReadStream(file, { highWaterMark: 1 << 20 })
      .on("data", (chunk) => hash.update(chunk))
      .on("error", reject)
      .on("end", () => resolve(hash.digest("base64")));
  });
}

// The file a Mac of each kind downloads, chosen the way electron-updater's
// MacUpdater chooses it.
export function chosenFile(files, arm64Mac) {
  const arm = files.filter((f) => isArm64(f.url));
  const pool =
    arm64Mac && arm.length ? arm : files.filter((f) => !isArm64(f.url));
  return pool.find((f) => f.url.toLowerCase().endsWith(".zip"));
}

export async function describe(version, zips) {
  if (!VERSION.test(version))
    throw new Error(
      `"${version}" is not a version like 1.2.3 or 1.2.3-beta.1.`,
    );
  const files = [];
  for (const zip of zips) {
    const url = path.basename(zip);
    if (!NAME.test(url))
      throw new Error(`"${url}" is not a ZIP with a plain file name.`);
    if (files.some((f) => f.url === url))
      throw new Error(`${url} is listed twice.`);
    files.push({ url, sha512: await sha512(zip), size: statSync(zip).size });
  }
  // Intel first, as electron-builder orders them.
  files.sort((a, b) => Number(isArm64(a.url)) - Number(isArm64(b.url)));
  const arm = chosenFile(files, true),
    intel = chosenFile(files, false);
  if (
    files.length !== 2 ||
    !arm ||
    !intel ||
    !isArm64(arm.url) ||
    arm === intel
  )
    throw new Error(
      "An update needs exactly two ZIPs: one with arm64 in its name and one without.",
    );
  return { version, files };
}

export function serialize({ version, files }, releaseDate = new Date()) {
  return [
    `version: ${version}`,
    "files:",
    ...files.flatMap((f) => [
      `  - url: ${f.url}`,
      `    sha512: ${f.sha512}`,
      `    size: ${f.size}`,
    ]),
    `path: ${files[0].url}`,
    `sha512: ${files[0].sha512}`,
    `releaseDate: '${releaseDate.toISOString()}'`,
    "",
  ].join("\n");
}

// Reads back exactly what serialize() writes, and nothing looser.
export function parse(text) {
  const lines = text.split("\n");
  const take = (pattern, what) => {
    const match = lines.shift()?.match(pattern);
    if (!match) throw new Error(`${MANIFEST}: expected ${what}.`);
    return match[1];
  };
  const version = take(/^version: (\S+)$/, "a version");
  take(/^(files):$/, "a list of files");
  const files = [];
  while (lines[0]?.startsWith("  - ")) {
    files.push({
      url: take(/^ {2}- url: (\S+)$/, "a file name"),
      sha512: take(/^ {4}sha512: (\S+)$/, "a sha512"),
      size: Number(take(/^ {4}size: (\d+)$/, "a size")),
    });
  }
  const first = take(/^path: (\S+)$/, "a path");
  const firstHash = take(/^sha512: (\S+)$/, "a sha512");
  take(/^releaseDate: '(\d{4}-\d\d-\d\dT[\d:.]+Z)'$/, "a release date");
  if (lines.join("") !== "")
    throw new Error(`${MANIFEST}: unexpected content at the end.`);
  if (!VERSION.test(version) || !files.length)
    throw new Error(`${MANIFEST}: no version or no files.`);
  for (const f of files)
    if (!NAME.test(f.url) || !SHA512.test(f.sha512) || !(f.size > 0))
      throw new Error(`${MANIFEST}: the entry for ${f.url} is not valid.`);
  if (first !== files[0].url || firstHash !== files[0].sha512)
    throw new Error(`${MANIFEST}: path and sha512 must repeat the first file.`);
  return { version, files };
}

export async function write(version, folder, zips) {
  const text = serialize(await describe(version, zips));
  writeFileSync(path.join(folder, MANIFEST), text);
  return text;
}

// Checks the manifest in `folder` against the files beside it: the ones that will
// be uploaded with it.
export async function verify(version, folder) {
  const manifest = parse(readFileSync(path.join(folder, MANIFEST), "utf8"));
  if (manifest.version !== version)
    throw new Error(
      `${MANIFEST} is for ${manifest.version}, but this release is ${version}.`,
    );
  for (const f of manifest.files) {
    const file = path.join(folder, f.url);
    let size;
    try {
      size = statSync(file).size;
    } catch {
      throw new Error(`${MANIFEST} lists ${f.url}, which is not in ${folder}.`);
    }
    if (size !== f.size)
      throw new Error(`${f.url} is ${size} bytes; ${MANIFEST} says ${f.size}.`);
    if ((await sha512(file)) !== f.sha512)
      throw new Error(`${f.url} does not match its sha512 in ${MANIFEST}.`);
  }
  const arm = chosenFile(manifest.files, true),
    intel = chosenFile(manifest.files, false);
  if (
    manifest.files.length !== 2 ||
    !arm ||
    !intel ||
    !isArm64(arm.url) ||
    arm === intel
  )
    throw new Error(
      `${MANIFEST} must list one ZIP for Apple Silicon and one for Intel.`,
    );
  return { ...manifest, arm64: arm.url, x64: intel.url };
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const [command, version, folder, ...zips] = process.argv.slice(2);
  try {
    if (command === "write" && version && folder && zips.length) {
      await write(version, folder, zips);
      const checked = await verify(version, folder);
      console.log(
        `${MANIFEST}: Relay ${checked.version}, ${checked.arm64} (Apple Silicon) and ${checked.x64} (Intel).`,
      );
    } else if (command === "verify" && version && folder && !zips.length) {
      const checked = await verify(version, folder);
      console.log(
        `${MANIFEST} matches ${checked.arm64} and ${checked.x64} (Relay ${checked.version}).`,
      );
    } else {
      console.error(
        "Usage: update-manifest.mjs write <version> <folder> <zip>... | verify <version> <folder>",
      );
      process.exit(2);
    }
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
