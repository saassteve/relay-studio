// Stamps the service worker with this build's id so each release refreshes the
// offline shell and clears the previous release's cached files.
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
const html = readFileSync("dist/index.html");
const id = createHash("sha256").update(html).digest("hex").slice(0, 12);
writeFileSync(
  "dist/sw.js",
  readFileSync("dist/sw.js", "utf8").replaceAll("__BUILD__", id),
);
