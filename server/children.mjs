import { execFileSync } from "node:child_process";
// Stop any media engine or AI worker this server started.
export function stopChildren() {
  try {
    execFileSync("pkill", ["-TERM", "-P", String(process.pid)], {
      stdio: "ignore",
    });
  } catch {
    /* No children were running. */
  }
}
