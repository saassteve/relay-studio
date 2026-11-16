import path from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import packaged from "ffmpeg-static";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bundled = path.join(
  root,
  "vendor",
  "ffmpeg",
  `${process.platform}-${process.arch}`,
  process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg",
);
export default process.env.FFMPEG_BIN ||
  (existsSync(bundled) ? bundled : packaged);
