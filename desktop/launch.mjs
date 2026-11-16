import { spawn } from "node:child_process";
import electron from "electron";
const env = { ...process.env };
// T3 and other Electron-based terminals may propagate this into npm scripts.
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(electron, ["."], { stdio: "inherit", env });
child.on("exit", (code) => process.exit(code ?? 0));
child.on("error", (error) => {
  console.error(error.message);
  process.exit(1);
});
