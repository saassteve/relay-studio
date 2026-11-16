const { BrowserWindow, ipcMain, app } = require("electron");
const { execFileSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { secure, lock } = require("./windows.cjs");

// Relay's download ships only MIT-licensed code. On first launch it fetches a pinned,
// checksum-verified GPL FFmpeg build directly from its publisher into the user's
// Application Support folder. See vendor/ffmpeg/NOTICE.md.
const ENGINES = require("./ffmpeg-pins.cjs");

function bundledForDevelopment() {
  const file = path.join(
    __dirname,
    "..",
    "vendor",
    "ffmpeg",
    `${process.platform}-${process.arch}`,
    process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg",
  );
  return fs.existsSync(file) ? file : null;
}

function engineTarget() {
  const spec = ENGINES[`${process.platform}-${process.arch}`];
  if (!spec) return null;
  const dir = path.join(
    app.getPath("userData"),
    "engine",
    `ffmpeg-${spec.version}`,
  );
  return { spec, dir, binary: path.join(dir, "ffmpeg") };
}

function usable(binary) {
  try {
    const licence = execFileSync(binary, ["-L"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 15000,
    });
    return !/nonfree|not legally redistributable/i.test(licence);
  } catch {
    return false;
  }
}

function sha256(file) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    fs.createReadStream(file, { highWaterMark: 1 << 20 })
      .on("data", (chunk) => hash.update(chunk))
      .on("error", reject)
      .on("end", () => resolve(hash.digest("hex")));
  });
}

// Whether the installed engine is, byte for byte, the pinned binary.
async function intact(target) {
  try {
    return (await sha256(target.binary)) === target.spec.binarySha256;
  } catch {
    return false;
  }
}

async function download(target, onProgress) {
  // A slow connection may take as long as it needs; only a stalled one gives up.
  const stalled = new AbortController();
  let timer;
  const alive = () => {
    clearTimeout(timer);
    timer = setTimeout(
      () =>
        stalled.abort(
          new Error("The download stalled. Check your connection."),
        ),
      30000,
    );
  };
  const hash = createHash("sha256");
  const chunks = [];
  try {
    alive();
    const response = await fetch(target.spec.url, { signal: stalled.signal });
    if (!response.ok || !response.body)
      throw new Error(`The download server answered ${response.status}.`);
    const total = Number(response.headers.get("content-length")) || 0;
    let received = 0;
    for await (const chunk of response.body) {
      alive();
      const buffer = Buffer.from(chunk);
      hash.update(buffer);
      chunks.push(buffer);
      received += buffer.length;
      onProgress(total ? received / total : 0, received, total);
    }
  } finally {
    clearTimeout(timer);
  }
  if (hash.digest("hex") !== target.spec.sha256)
    throw new Error("The video engine failed its integrity check.");
  const staging = `${target.dir}.partial`;
  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(staging, { recursive: true });
  const archive = path.join(staging, "engine.zip");
  fs.writeFileSync(archive, Buffer.concat(chunks));
  execFileSync("/usr/bin/ditto", ["-x", "-k", archive, staging]);
  fs.rmSync(archive);
  const binary = path.join(staging, "ffmpeg");
  fs.chmodSync(binary, 0o755);
  // Checked against its own pin before it is run for the first time.
  if ((await sha256(binary)) !== target.spec.binarySha256)
    throw new Error("The video engine failed its integrity check.");
  if (!usable(binary))
    throw new Error("The downloaded video engine could not run on this Mac.");
  fs.rmSync(target.dir, { recursive: true, force: true });
  fs.renameSync(staging, target.dir);
}

// Resolves to an FFmpeg path, showing a small setup window the first time.
module.exports = async function ensureEngine() {
  // FFMPEG_BIN is honoured in development only. The packaged app runs the engine it
  // downloaded. The archive's checksum is verified at download time. The engine then
  // sits in a folder any of the user's programs can write to, so every launch hashes
  // the binary against its own pin before running it, then checks that it runs and
  // reports no nonfree parts. Anything else found in its place is deleted, never
  // run, and the engine is downloaded again.
  if (process.env.FFMPEG_BIN && !app.isPackaged) return process.env.FFMPEG_BIN;
  const dev = !app.isPackaged && bundledForDevelopment();
  if (dev) return dev;
  const target = engineTarget();
  if (!target) return bundledForDevelopment() || "";
  if ((await intact(target)) && usable(target.binary)) return target.binary;
  fs.rmSync(target.dir, { recursive: true, force: true });

  const win = new BrowserWindow({
    width: 440,
    height: 300,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    titleBarStyle: "hiddenInset",
    backgroundColor: "#173e32",
    title: "Setting up Relay",
    show: false,
    webPreferences: secure("overlay-preload.cjs"),
  });
  lock(win);
  let finished = false;
  // Closing the setup window before it finishes quits Relay.
  win.on("closed", () => {
    if (!finished) app.exit(0);
  });
  await win.loadFile(path.join(__dirname, "engine.html"));
  win.show();
  const send = (state) => {
    if (!win.isDestroyed()) win.webContents.send("relay:engine", state);
  };
  try {
    for (;;) {
      try {
        send({ status: "downloading", progress: 0 });
        let last = 0;
        await download(target, (progress, received, total) => {
          const now = Date.now();
          if (now - last < 80 && progress < 1) return;
          last = now;
          send({ status: "downloading", progress, received, total });
        });
        send({ status: "ready", progress: 1 });
        await new Promise((r) => setTimeout(r, 600));
        finished = true;
        return target.binary;
      } catch (error) {
        send({ status: "failed", message: error.message });
        const choice = await new Promise((resolve) => {
          const listener = (event, value) => {
            if (event.sender !== win.webContents) return;
            ipcMain.removeListener("relay:engine-choice", listener);
            resolve(value);
          };
          ipcMain.on("relay:engine-choice", listener);
        });
        if (choice !== "retry") {
          finished = true;
          app.exit(0);
          return "";
        }
      }
    }
  } finally {
    if (!win.isDestroyed()) win.destroy();
  }
};
