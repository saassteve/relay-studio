// Copies the MediaPipe vision runtime into public/ so camera backgrounds work
// offline, served from Relay itself rather than a CDN.
import { mkdirSync, copyFileSync, existsSync, statSync } from "node:fs";
import path from "node:path";
const from = path.resolve("node_modules/@mediapipe/tasks-vision/wasm"),
  to = path.resolve("public/vendor/mediapipe");
mkdirSync(to, { recursive: true });
for (const file of ["vision_wasm_internal.js", "vision_wasm_internal.wasm"]) {
  const source = path.join(from, file),
    target = path.join(to, file);
  if (!existsSync(target) || statSync(target).size !== statSync(source).size)
    copyFileSync(source, target);
}
