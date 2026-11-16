import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  chmodSync,
  rmSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import path from "node:path";
import pins from "./ffmpeg-pins.cjs";
if (process.platform !== "darwin" || process.arch !== "arm64")
  throw new Error(
    "Provision a redistributable FFmpeg binary for this platform. See vendor/ffmpeg/NOTICE.md.",
  );
// The same pinned build the Mac app downloads.
const spec = pins["darwin-arm64"];
const sha256 = (data) => createHash("sha256").update(data).digest("hex");
const root = path.resolve("vendor/ffmpeg"),
  folder = path.join(root, "darwin-arm64"),
  binary = path.join(folder, "ffmpeg");
if (existsSync(binary)) {
  const text = execFileSync(binary, ["-L"], { encoding: "utf8" });
  if (/nonfree|not legally redistributable/i.test(text))
    throw new Error("Existing binary is nonfree.");
  console.log("FFmpeg is already provisioned.");
  process.exit(0);
}
const response = await fetch(spec.url);
if (!response.ok) throw new Error("FFmpeg download failed.");
const buffer = Buffer.from(await response.arrayBuffer());
if (sha256(buffer) !== spec.sha256)
  throw new Error("FFmpeg checksum mismatch.");
mkdirSync(folder, { recursive: true });
const archive = path.join(root, "download.zip");
writeFileSync(archive, buffer);
try {
  execFileSync("/usr/bin/unzip", ["-o", archive, "-d", folder]);
  if (sha256(readFileSync(binary)) !== spec.binarySha256) {
    rmSync(binary, { force: true });
    throw new Error("FFmpeg binary checksum mismatch.");
  }
  chmodSync(binary, 0o755);
} finally {
  rmSync(archive, { force: true });
}
console.log(`Verified GPL FFmpeg ${spec.version} provisioned.`);
