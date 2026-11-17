// Regenerates the README screenshots, the demo animation, the banner and the DMG background.
// Usage: npm run build && node scripts/screenshots.mjs
// Everything shown is made by Relay itself: the script draws demo screens, records them
// with a stand-in presenter, and lets the server render them like any other recording.
import { chromium } from "@playwright/test";
import { spawn, execFileSync } from "node:child_process";
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

const root = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
);
const out = path.join(root, "docs", "images");
const dmgOut = path.join(root, "desktop", "dmg");
mkdirSync(out, { recursive: true });
mkdirSync(dmgOut, { recursive: true });
const port = 5199,
  base = `http://127.0.0.1:${port}`,
  data = mkdtempSync(path.join(os.tmpdir(), "relay-shots-"));
const { default: ffmpeg } = await import("../server/ffmpeg.mjs");
const server = spawn(process.execPath, ["server/index.mjs"], {
  cwd: root,
  env: {
    ...process.env,
    PORT: String(port),
    NODE_ENV: "production",
    DATA_DIR: data,
  },
  stdio: "inherit",
});
for (let i = 0; ; i++) {
  try {
    if ((await fetch(`${base}/api/session`)).ok) break;
  } catch {}
  if (i > 100) throw new Error("Server did not start");
  await new Promise((r) => setTimeout(r, 200));
}
const J = { "Content-Type": "application/json" };
const send = async (p, body, method = "POST") => {
  const res = await fetch(base + p, {
    method,
    headers: J,
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${method} ${p}: ${await res.text()}`);
  return res.json();
};
const job = async (j) => {
  for (;;) {
    if (j.status === "complete") return j;
    if (j.status === "failed") throw new Error(j.error || "A job failed");
    await new Promise((r) => setTimeout(r, 400));
    // A busy machine can drop a poll; the job itself carries on.
    try {
      j = await (await fetch(`${base}/api/jobs/${j.id}`)).json();
    } catch {}
  }
};

// Where the pointer is during the main demo, as fractions of the screen. It travels,
// rests on the "Share links" card, then moves on: the rest is what auto-zoom picks up.
const REST = { x: 0.5, y: 0.47 };
const pointerAt = (t) => {
  const mix = (a, b, k) => a + (b - a) * Math.min(1, Math.max(0, k));
  if (t < 4.4)
    return {
      x: mix(0.9, REST.x, (t - 3) / 1.4),
      y: mix(0.9, REST.y, (t - 3) / 1.4),
    };
  if (t < 6.8) return REST;
  return {
    x: mix(REST.x, 0.82, (t - 6.8) / 1.4),
    y: mix(REST.y, 0.3, (t - 6.8) / 1.4),
  };
};
const LENGTH = 16;
const demos = [
  {
    title: "Q4 roadmap walkthrough",
    kind: "board",
    seconds: LENGTH,
    wallpaper: "aurora",
    folder: "Planning",
    starred: true,
    pointer: true,
  },
  {
    title: "Bug: checkout total doesn’t update",
    kind: "bug",
    seconds: 9,
    wallpaper: "ember",
    folder: "Engineering",
  },
  {
    title: "Onboarding flow · design review",
    kind: "phones",
    seconds: 13,
    wallpaper: "candy",
    folder: "Design",
    starred: true,
    preset: "side",
  },
  {
    title: "Weekly update · week 46",
    kind: "chart",
    seconds: 11,
    wallpaper: "ocean",
  },
  {
    title: "How we deploy to staging",
    kind: "terminal",
    seconds: 7,
    wallpaper: "dusk",
    folder: "Engineering",
    preset: "screen",
  },
  {
    title: "Pricing page feedback",
    kind: "web",
    seconds: 14,
    wallpaper: "mint",
    folder: "Design",
  },
];

// The presenter is a short AI-generated clip (not a real person) that stands in for a
// camera, both in the demo recordings and in the recorder screenshot.
const presenterClip = path.join(root, "scripts", "assets", "presenter.mp4");
const presenterScript = () => {
  const original = navigator.mediaDevices?.getUserMedia?.bind(
    navigator.mediaDevices,
  );
  if (!original) return;
  navigator.mediaDevices.getUserMedia = async (constraints) => {
    if (!constraints?.video) return original(constraints);
    const video = document.createElement("video");
    video.src = "/__presenter.mp4";
    video.muted = true;
    video.loop = true;
    video.playsInline = true;
    await video.play();
    window.__presenterVideo = video;
    return video.captureStream();
  };
};

const browser = await chromium.launch({
  channel: process.env.RELAY_BROWSER_CHANNEL || "chrome",
});
try {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
  });
  await context.addInitScript(presenterScript);
  // The recorder preview holds one good frame of the clip, so the shot is repeatable.
  const presenterStill = path.join(data, "presenter-still.mp4");
  execFileSync(ffmpeg, [
    "-y",
    "-loglevel",
    "error",
    "-ss",
    "1",
    "-i",
    presenterClip,
    "-frames:v",
    "1",
    path.join(data, "presenter-still.png"),
  ]);
  execFileSync(ffmpeg, [
    "-y",
    "-loglevel",
    "error",
    "-loop",
    "1",
    "-framerate",
    "30",
    "-t",
    "4",
    "-i",
    path.join(data, "presenter-still.png"),
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    presenterStill,
  ]);
  await context.route("**/__presenter.mp4", (route) =>
    route.fulfill({ path: presenterStill, contentType: "video/mp4" }),
  );
  const page = await context.newPage();
  page.on("pageerror", (e) => console.error("Page error:", e.message));
  await send("/api/profile", { name: "Alex Rivera" }, "PUT");
  await send("/api/preferences", { onboarded: true }, "PUT");
  await page.goto(base);
  await page.waitForSelector(".hero, .video-card");

  // 1. Draw the demos frame by frame, encode them, and hand them to the server as
  // recordings. Nothing here runs in real time, so a slow machine gives the same result.
  console.log("Drawing demo videos…");
  await page.evaluate(
    async ({ REST, pointerSource }) => {
      const pointerAt = new Function("REST", `return (${pointerSource})`)(REST);
      await document.fonts.ready;
      const font = (w, s) => `${w} ${s}px "DM Sans", system-ui, sans-serif`,
        head = (w, s) => `${w} ${s}px Manrope, "DM Sans", sans-serif`;
      const W = 1280,
        H = 720;
      const painter = (g, kind) => {
        const rr = (x, y, w, h, r, fill, stroke) => {
          g.beginPath();
          g.roundRect(x, y, w, h, r);
          if (fill) {
            g.fillStyle = fill;
            g.fill();
          }
          if (stroke) {
            g.strokeStyle = stroke;
            g.lineWidth = 1;
            g.stroke();
          }
        };
        const text = (s, x, y, f, fill) => {
          g.font = f;
          g.fillStyle = fill;
          g.fillText(s, x, y);
        };
        const chrome = (bg, url) => {
          g.fillStyle = bg;
          g.fillRect(0, 0, W, H);
          rr(0, 0, W, 46, 0, "#eceee8");
          ["#ee6a5f", "#f5be4f", "#62c554"].forEach((c, i) => {
            g.beginPath();
            g.arc(24 + i * 20, 23, 6, 0, 7);
            g.fillStyle = c;
            g.fill();
          });
          rr(360, 11, 560, 24, 12, "#fff");
          text(url, 380, 28, font(500, 12), "#7b857d");
        };
        const cursor = (x, y) => {
          g.save();
          g.translate(x, y);
          g.beginPath();
          g.moveTo(0, 0);
          g.lineTo(0, 22);
          g.lineTo(6, 17);
          g.lineTo(10, 26);
          g.lineTo(14, 24);
          g.lineTo(10, 15);
          g.lineTo(17, 15);
          g.closePath();
          g.fillStyle = "#101613";
          g.strokeStyle = "#fff";
          g.lineWidth = 1.6;
          g.fill();
          g.stroke();
          g.restore();
        };
        return (t) => {
          if (kind === "board") {
            chrome("#f6f7f2", "plan.example.com/roadmap/q4");
            // Sidebar
            rr(0, 46, 208, H - 46, 0, "#eef1e8");
            text("Northwind", 28, 92, head(700, 19), "#173e32");
            ["Roadmap", "Releases", "Feedback", "Insights", "Team"].forEach(
              (s, i) => {
                if (!i) rr(16, 118, 176, 36, 9, "#dfe6d3");
                text(
                  s,
                  34,
                  142 + i * 44,
                  font(i ? 500 : 600, 15),
                  i ? "#5d6b61" : "#173e32",
                );
              },
            );
            text("Q4 roadmap", 244, 108, head(700, 34), "#173e32");
            text(
              "October to December · 11 projects",
              244,
              136,
              font(500, 15),
              "#6c786f",
            );
            rr(1088, 82, 150, 38, 19, "#173e32");
            text("Share plan", 1124, 106, font(600, 14), "#d6f475");
            const cols = [
              [
                "Now",
                "#d6f475",
                ["Share links", "Faster search", "Team spaces", "Billing v2"],
              ],
              [
                "Next",
                "#bfe3f5",
                ["Mobile capture", "Comments API", "Audit log"],
              ],
              ["Later", "#f6d9a8", ["Integrations", "Templates"]],
            ];
            cols.forEach(([col, tint, cards], i) => {
              const x = 244 + i * 338;
              rr(x, 166, 318, 520, 16, "#eef1e8");
              rr(x + 18, 186, 10, 10, 5, tint);
              text(col.toUpperCase(), x + 38, 196, font(700, 12), "#5d6b61");
              text(
                String(cards.length),
                x + 282,
                196,
                font(600, 12),
                "#8a958c",
              );
              cards.forEach((name, k) => {
                const y = 214 + k * 112,
                  hot = i === 0 && k === 1;
                rr(x + 14, y, 290, 98, 12, "#fff", hot ? "#173e32" : "#e2e6dc");
                rr(x + 30, y + 18, 54, 8, 4, tint);
                text(name, x + 30, y + 50, font(600, 17), "#1d2a24");
                const done = [0.9, 0.62, 0.35, 0.2][k] - i * 0.12;
                rr(x + 30, y + 68, 180, 8, 4, "#e6eadf");
                rr(
                  x + 30,
                  y + 68,
                  180 * Math.max(0.08, done) * Math.min(1, t / 2 + 0.5),
                  8,
                  4,
                  "#2f6a52",
                );
                g.beginPath();
                g.arc(x + 276, y + 70, 11, 0, 7);
                g.fillStyle = ["#f3c9a8", "#b9d7c5", "#c9c2ee", "#f1d58a"][
                  (i + k) % 4
                ];
                g.fill();
              });
            });
            const p = pointerAt(t);
            cursor(p.x * W, p.y * H);
          } else if (kind === "bug") {
            chrome("#ffffff", "shop.example.com/checkout");
            text("Checkout", 80, 122, head(700, 32), "#1d2a24");
            for (let k = 0; k < 3; k++) {
              rr(80, 160 + k * 100, 640, 84, 14, "#f4f6f1");
              rr(
                100,
                180 + k * 100,
                44,
                44,
                10,
                ["#f6d9a8", "#bfe3f5", "#d6f475"][k],
              );
              text(
                ["Canvas tote", "Enamel mug", "Field notebook"][k],
                164,
                200 + k * 100,
                font(600, 17),
                "#1d2a24",
              );
              text("Qty 1", 164, 222 + k * 100, font(500, 13), "#7b857d");
              text(
                `$${[24, 18, 42][k]}.00`,
                632,
                210 + k * 100,
                font(600, 19),
                "#1d2a24",
              );
            }
            rr(780, 160, 420, 284, 16, "#173e32");
            text("Order total", 812, 212, font(500, 17), "#c3d1c6");
            text("$66.00", 812, 272, head(700, 48), "#fff");
            rr(812, 356, 356, 54, 27, "#d6f475");
            text("Pay now", 956, 389, font(700, 17), "#173e32");
            g.strokeStyle = "#ff5a36";
            g.lineWidth = 6;
            g.beginPath();
            g.ellipse(905, 256, 122 + Math.sin(t * 4) * 4, 50, 0, 0, 7);
            g.stroke();
          } else if (kind === "phones") {
            g.fillStyle = "#f3f1ea";
            g.fillRect(0, 0, W, H);
            [0, 1, 2].forEach((i) => {
              const x = 150 + i * 360,
                dy = i === 1 ? -20 : 20;
              rr(x, 80 + dy, 270, 560, 40, "#173e32");
              rr(
                x + 12,
                92 + dy,
                246,
                536,
                30,
                i === 1 ? "#d6f475" : "#fbfcf8",
              );
              text(
                ["Welcome", "Allow access", "You’re set"][i],
                x + 36,
                210 + dy,
                head(700, 27),
                "#173e32",
              );
              rr(x + 36, 236 + dy, 170, 10, 5, i === 1 ? "#b7d85a" : "#dfe4d8");
              rr(x + 36, 256 + dy, 120, 10, 5, i === 1 ? "#b7d85a" : "#ecefe7");
              rr(x + 36, 524 + dy, 198, 48, 24, "#173e32");
              text("Continue", x + 100, 554 + dy, font(600, 15), "#d6f475");
            });
          } else if (kind === "chart") {
            chrome("#fbfcf8", "metrics.example.com/weekly");
            text("Weekly active teams", 60, 112, head(700, 34), "#173e32");
            text("▲ 18% week over week", 60, 146, font(600, 17), "#4f7a2e");
            const vals = [38, 44, 41, 52, 58, 61, 67, 72, 70, 81, 88, 96];
            vals.forEach((v, i) => {
              const h = v * 4.4 * Math.min(1, t / 1.5 + 0.55);
              rr(
                80 + i * 95,
                650 - h,
                62,
                h,
                10,
                i === vals.length - 1 ? "#d6f475" : "#2f6a52",
              );
            });
          } else if (kind === "terminal") {
            g.fillStyle = "#10241c";
            g.fillRect(0, 0, W, H);
            const lines = [
              ["$ git push origin main", "#e9f0de"],
              ["✓ 214 tests passed", "#9fd36b"],
              ["$ npm run deploy -- --env staging", "#e9f0de"],
              ["  building image relay:9f2c1a…", "#a9bdb0"],
              ["  uploading 48.2 MB", "#a9bdb0"],
              ["  running migrations (3)", "#a9bdb0"],
              ["✓ staging is live → https://staging.example.com", "#d6f475"],
            ];
            g.font = `500 26px ui-monospace, Menlo, monospace`;
            lines.forEach(([l, c], i) => {
              g.fillStyle = c;
              g.fillText(l, 70, 124 + i * 64);
            });
          } else {
            chrome("#ffffff", "example.com/pricing");
            text("Simple pricing", 484, 140, head(700, 40), "#1d2a24");
            ["Starter", "Team", "Business"].forEach((p, i) => {
              rr(
                160 + i * 330,
                200,
                300,
                410,
                20,
                i === 1 ? "#173e32" : "#f4f6f1",
              );
              text(
                p,
                190 + i * 330,
                262,
                head(700, 26),
                i === 1 ? "#d6f475" : "#1d2a24",
              );
              text(
                ["$0", "$12", "$29"][i],
                190 + i * 330,
                332,
                head(700, 46),
                i === 1 ? "#fff" : "#1d2a24",
              );
              for (let k = 0; k < 4; k++)
                rr(
                  190 + i * 330,
                  372 + k * 34,
                  200 - k * 22,
                  10,
                  5,
                  i === 1 ? "#3f6a58" : "#dfe4d8",
                );
            });
            rr(830, 108, 300, 70, 14, "#fff7d6");
            text("Make Team the default?", 852, 150, font(600, 17), "#6d5520");
          }
        };
      };
      const canvases = {};
      window.__demoFrame = (kind, t, big) => {
        let made = canvases[kind];
        if (!made) {
          const c = document.createElement("canvas");
          c.width = W * big;
          c.height = H * big;
          const g = c.getContext("2d");
          g.scale(big, big);
          made = canvases[kind] = { c, paint: painter(g, kind) };
        }
        made.paint(t);
        return made.c.toDataURL("image/jpeg", 0.93);
      };
    },
    { REST, pointerSource: pointerAt.toString() },
  );
  const FPS = 15;
  const jpeg = (url) => Buffer.from(url.split(",")[1], "base64");
  // Pipes JPEG frames into FFmpeg and returns the finished WebM.
  const encode = async (file, frameAt, seconds) => {
    const child = spawn(
      ffmpeg,
      [
        "-y",
        "-loglevel",
        "error",
        "-f",
        "image2pipe",
        "-framerate",
        String(FPS),
        "-c:v",
        "mjpeg",
        "-i",
        "-",
        "-r",
        "30",
        "-c:v",
        "libvpx",
        "-b:v",
        "5M",
        "-pix_fmt",
        "yuv420p",
        file,
      ],
      { stdio: ["pipe", "inherit", "inherit"] },
    );
    const closed = new Promise((done, fail) =>
      child.on("close", (code) =>
        code ? fail(new Error(`FFmpeg exited with ${code}`)) : done(),
      ),
    );
    for (let n = 0; n < seconds * FPS; n++) {
      const frame = jpeg(await frameAt(n / FPS));
      if (!child.stdin.write(frame))
        await new Promise((r) => child.stdin.once("drain", r));
    }
    child.stdin.end();
    await closed;
    return readFileSync(file);
  };
  // The camera track is the clip played backwards then forwards, so it runs for the
  // whole demo without a jump.
  execFileSync(ffmpeg, [
    "-y",
    "-loglevel",
    "error",
    "-i",
    presenterClip,
    "-filter_complex",
    "[0:v]split[a][b];[a]reverse[r];[r][b]concat=n=2:v=1,scale=960:720,fps=30[v]",
    "-map",
    "[v]",
    "-t",
    String(LENGTH),
    "-c:v",
    "libvpx",
    "-b:v",
    "4M",
    "-pix_fmt",
    "yuv420p",
    "-an",
    path.join(data, "camera.webm"),
  ]);
  const camera = readFileSync(path.join(data, "camera.webm"));
  execFileSync(ffmpeg, [
    "-y",
    "-loglevel",
    "error",
    "-f",
    "lavfi",
    "-i",
    `sine=frequency=180:sample_rate=48000:duration=${LENGTH}`,
    "-af",
    "volume=0.01",
    "-c:a",
    "libopus",
    path.join(data, "voice.webm"),
  ]);
  const microphone = readFileSync(path.join(data, "voice.webm"));
  const jobs = [];
  for (const d of demos) {
    // Only the main demo moves; the rest are a held frame.
    const screen = await encode(
      path.join(data, `${d.kind}.webm`),
      (t) =>
        page.evaluate(
          ([kind, t, big]) => window.__demoFrame(kind, t, big),
          [d.kind, d.pointer ? t : 3, d.pointer ? 1.5 : 1],
        ),
      d.seconds,
    );
    const rec = await send("/api/recordings", {
      meta: { roles: ["screen", "camera", "microphone"] },
    });
    for (const [role, body, mime] of [
      ["screen", screen, "video/webm"],
      ["camera", camera, "video/webm"],
      ["microphone", microphone, "audio/webm"],
    ]) {
      const res = await fetch(
        `${base}/api/recordings/${rec.id}/parts/${role}/0`,
        {
          method: "PUT",
          headers: { "x-track-mime": mime, "x-part-end": String(d.seconds) },
          body,
        },
      );
      if (!res.ok) throw new Error(await res.text());
    }
    const pointers = d.pointer
      ? // Only while it is on the move or resting: an idle pointer is not a moment.
        Array.from({ length: 52 }, (_, k) => ({
          time: 3 + k / 10,
          ...pointerAt(3 + k / 10),
        }))
      : undefined;
    jobs.push(
      await send(`/api/recordings/${rec.id}/finish`, {
        duration: d.seconds,
        title: d.title,
        meta: {
          autoZoom: Boolean(pointers),
          pointers,
          layout: {
            wallpaper: d.wallpaper,
            preset: d.preset || "pip",
            // Bottom right, clear of the name title.
            ...(d.pointer ? { camera: { x: 0.8, y: 0.66 } } : {}),
          },
        },
      }),
    );
  }
  console.log("Rendering…");
  const ids = [];
  // Finish the oldest-looking first so the main demo ends up newest in the library.
  for (const [i, j] of jobs.entries()) {
    const done = await job(j);
    ids.push(done.result.videoId);
    const d = demos[i];
    await send(
      `/api/videos/${ids[i]}`,
      { folder: d.folder || "", starred: Boolean(d.starred) },
      "PATCH",
    );
  }
  const id = ids[0];

  // 2. Give the main demo a transcript, captions, titles and a layout change.
  const script =
    "Here’s the plan for the quarter. Three projects ship now and the rest move to next. Um let me zoom in on share links because that’s the one everybody asked for. So here’s how it looks side by side. Thanks for watching".split(
      " ",
    );
  // Recordings come out a touch shorter than asked for, so work from the real length.
  const length = (await (await fetch(`${base}/api/videos/${id}`)).json())
    .duration;
  console.log(`Main demo is ${length.toFixed(2)}s`);
  const step = (length - 1.2) / script.length;
  const words = script.map((text, i) => ({
    text,
    start: 0.4 + i * step,
    end: 0.4 + i * step + step * 0.85,
  }));
  await send(`/api/videos/${id}/transcript`, { words }, "PUT");
  let { project } = await (
    await fetch(`${base}/api/videos/${id}/project`)
  ).json();
  project.layout.captions = true;
  project.layout.captionStyle = "highlight";
  project.overlays = [
    ...project.overlays,
    {
      id: "name",
      type: "lowerthird",
      start: 0.5,
      end: 4,
      text: "Alex Rivera",
      sub: "Product lead",
      color: "#d6f475",
    },
    {
      id: "chapter",
      type: "chapter",
      start: 8.6,
      end: 11,
      text: "02 · Share links",
      color: "#d6f475",
    },
    {
      id: "box",
      type: "box",
      start: Math.min(12.4, length - 3.4),
      end: Math.min(14.6, length - 1.2),
      x: 0.185,
      y: 0.25,
      w: 0.27,
      h: 0.64,
      color: "#ff5a36",
    },
  ];
  project.scenes = [{ id: "side", start: 8.6, end: 11.8, preset: "side" }];
  await send(`/api/videos/${id}/project`, project, "PUT");
  // Cut the "Um", the way you would in the Transcript tab.
  const um = words.find((w) => w.text === "Um");
  await send(`/api/videos/${id}/project/cut`, {
    sourceId: project.segments[0].sourceId,
    ranges: [{ start: um.start, end: um.end + step * 0.15 }],
  });
  await job(await send(`/api/videos/${id}/render`, {}));
  for (const [author, body, time] of [
    [
      "Sam Okafor",
      "Love this. Can share links be the headline for the launch?",
      6,
    ],
    ["Priya Nair", "Side by side really helps here. Shipping it.", 10],
  ]) {
    await send("/api/profile", { name: author }, "PUT");
    await send(`/api/videos/${id}/comments`, { author, body, time });
  }
  await send("/api/profile", { name: "Alex Rivera" }, "PUT");

  const shot = async (name, opts = {}) => {
    await page.waitForTimeout(600);
    await page.screenshot({ path: path.join(out, name), ...opts });
    console.log("  " + name);
  };
  console.log("Capturing…");

  // A dialog on its own, with a little of the page behind it.
  const dialogShot = async (selector, name) => {
    await page.waitForTimeout(700);
    const box = await page.locator(selector).boundingBox();
    const view = page.viewportSize();
    const pad = 56,
      x = Math.max(0, box.x - pad),
      y = Math.max(0, box.y - pad);
    await page.screenshot({
      path: path.join(out, name),
      clip: {
        x,
        y,
        width: Math.min(view.width - x, box.width + pad * 2),
        height: Math.min(view.height - y, box.height + pad * 2),
      },
    });
    console.log("  " + name);
  };

  // 3. Editor: preview, timeline and each tool tab
  await page.goto(`${base}/video/${id}`);
  await page.waitForSelector(".studio-workbench");
  await page.waitForSelector(".tl-clips > button");
  await page.waitForTimeout(1500);
  const seek = async (time) => {
    const ruler = await page.locator(".tl-clips").boundingBox();
    const total = await page.evaluate(
      () => document.querySelector(".draft-player video")?.duration || 0,
    );
    await page.mouse.click(
      ruler.x + (ruler.width * time) / (total || LENGTH),
      ruler.y + ruler.height / 2,
    );
    await page.waitForTimeout(900);
  };
  await seek(1);
  await page.mouse.move(700, 880);
  await shot("editor.png");
  const tabs = page.locator(".studio-tabs");
  // Each tab, scrolled so the pinned preview sits above its tools.
  const tabShot = async (tab, name) => {
    await page.evaluate(() => scrollTo(0, 0));
    await tabs.getByRole("tab", { name: tab }).click();
    await page.waitForTimeout(500);
    await page.locator(".stage").evaluate((el) => el.scrollIntoView());
    await page.evaluate(() => scrollBy(0, 330));
    await shot(name);
  };
  await tabShot(/Transcript/, "transcript.png");
  await tabShot(/Look/, "look.png");
  await page.evaluate(() => scrollTo(0, 0));
  await page.getByRole("button", { name: /^(Share|Send)$/ }).click();
  await dialogShot(".share-dialog", "send.png");
  await page.keyboard.press("Escape");

  // 4. What a viewer sees
  const shared = await send(`/api/videos/${id}/share`, {});
  for (const other of ids.slice(2, 4))
    await send(`/api/videos/${other}/share`, {});
  for (const emoji of ["👏", "👏", "👏", "🎉", "💡", "💡"])
    await send(`/api/share/${shared.token}/reactions`, { emoji });
  const viewer = await context.newPage();
  await viewer.setViewportSize({ width: 1440, height: 960 });
  await viewer.goto(`${base}/s/${shared.token}`);
  await viewer.waitForSelector(".video-player video");
  // Show a real frame rather than the small poster.
  await viewer.locator(".video-player video").evaluate(
    (v) =>
      new Promise((done) => {
        v.addEventListener("seeked", done, { once: true });
        v.currentTime = 1;
      }),
  );
  await viewer.waitForTimeout(1500);
  await viewer.screenshot({ path: path.join(out, "watch.png") });
  console.log("  watch.png");
  await viewer.close();

  // 5. Library
  await page.goto(base);
  await page.waitForSelector(".video-card img");
  await shot("library.png");

  // Choosing an AI provider, in Settings
  await page.getByRole("button", { name: /Settings$/ }).click();
  // Bring the AI section to the top of the dialog, just under its title.
  await page.waitForSelector(".ai-settings");
  await page.locator(".ai-settings").evaluate((el) => {
    el.scrollIntoView({ block: "start" });
    let scroller = el.parentElement;
    while (scroller && scroller.scrollHeight <= scroller.clientHeight + 1)
      scroller = scroller.parentElement;
    if (scroller) scroller.scrollTop -= 20;
  });
  await dialogShot('[role="dialog"]', "ai.png");
  await page.keyboard.press("Escape");

  // 6. Recorder, with the camera looks open
  await send(
    "/api/preferences",
    { cameraFilter: "vivid", cameraBackground: "none" },
    "PUT",
  );
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(base);
  await page
    .getByRole("button", { name: /New recording/ })
    .first()
    .click();
  await page.waitForSelector(".recorder-dialog");
  await page.locator(".look-preview video").waitFor({ timeout: 60000 });
  await page
    .waitForFunction(() => !document.querySelector(".look-busy"), null, {
      timeout: 60000,
    })
    .catch(() => {});
  await page.waitForTimeout(1500);
  await dialogShot(".recorder-dialog", "recorder.png");
  await page.keyboard.press("Escape");
  await send(
    "/api/preferences",
    { cameraFilter: "none", cameraBackground: "none" },
    "PUT",
  );
  await page.setViewportSize({ width: 1440, height: 900 });

  // 7. First-run setup
  await send(
    "/api/preferences",
    { onboarded: false, onboardingStep: null },
    "PUT",
  );
  await page.goto(base);
  await page.getByRole("dialog", { name: "Set up Relay" }).waitFor();
  await shot("onboarding.png");
  await send("/api/preferences", { onboarded: true }, "PUT");

  // 8. Frames and a short animation straight from the rendered file.
  const media = path.join(data, "demo.mp4");
  writeFileSync(
    media,
    Buffer.from(await (await fetch(`${base}/api/media/${id}`)).arrayBuffer()),
  );
  const frame = (time, name) =>
    execFileSync(ffmpeg, [
      "-y",
      "-loglevel",
      "error",
      "-ss",
      String(time),
      "-i",
      media,
      "-frames:v",
      "1",
      path.join(data, name),
    ]);
  frame(1, "f1.png");
  frame(9, "f2.png");
  frame(4.65, "f3.png");
  execFileSync(ffmpeg, [
    "-y",
    "-loglevel",
    "error",
    "-i",
    media,
    "-filter_complex",
    "fps=12,scale=800:-2:flags=lanczos,split[a][b];[a]palettegen=max_colors=160:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle",
    path.join(out, "demo.gif"),
  ]);
  console.log("  demo.gif");

  // 9. Composed art. Same-origin pages so the app's fonts load; images are inlined.
  const inline = (file) =>
    `data:image/png;base64,${readFileSync(file).toString("base64")}`;
  const art = await browser.newPage({ deviceScaleFactor: 2 });
  await art.goto(`${base}/api/session`);
  const fontCSS = `@import url("${base}/fonts/fonts.css");`;
  const compose = async (width, height, html, file) => {
    await art.setViewportSize({ width, height });
    await art.setContent(html);
    await art.waitForLoadState("networkidle");
    await art.evaluate(() => document.fonts.ready);
    await art.screenshot({ path: file });
    console.log("  " + path.basename(file));
  };
  await compose(
    1440,
    330,
    `<!doctype html><html><head><style>${fontCSS}
    *{box-sizing:border-box;margin:0}
    body{width:1440px;height:330px;background:#fbfcf8;display:grid;grid-template-columns:repeat(3,1fr);gap:20px;padding:0;font-family:"DM Sans",sans-serif}
    figure{position:relative}
    img{width:100%;display:block;border-radius:14px}
    figcaption{margin-top:12px;font-size:17px;font-weight:600;color:#173e32;text-align:center}
    </style></head><body>
    <figure><img src="${inline(path.join(data, "f1.png"))}"><figcaption>Framed, with titles and captions</figcaption></figure>
    <figure><img src="${inline(path.join(data, "f2.png"))}"><figcaption>Side by side</figcaption></figure>
    <figure><img src="${inline(path.join(data, "f3.png"))}"><figcaption>Auto-zoom</figcaption></figure>
    </body></html>`,
    path.join(out, "looks.png"),
  );
  await compose(
    1280,
    640,
    `<!doctype html><html><head><style>${fontCSS}
    *{box-sizing:border-box;margin:0}
    body{width:1280px;height:640px;overflow:hidden;background:#12261f;font-family:"DM Sans",sans-serif;color:#e9f0de;position:relative}
    .glow{position:absolute;width:1000px;height:1000px;border-radius:50%;background:radial-gradient(circle,#2f6a52aa,transparent 62%);right:-260px;top:-300px}
    .glow.b{background:radial-gradient(circle,#d6f47522,transparent 60%);left:-420px;top:200px}
    .copy{position:absolute;left:72px;top:84px;width:548px}
    .mark{display:flex;align-items:center;gap:12px;font:700 30px Manrope,sans-serif;color:#d6f475;letter-spacing:-1px}
    .mark svg{width:34px;height:36px}
    h1{font:700 60px/1.03 Manrope,sans-serif;letter-spacing:-2.6px;color:#fbfdf2;margin-top:44px}
    h1 em{font-style:normal;color:#d6f475}
    p{font-size:20px;line-height:1.5;color:#b5c8bb;margin-top:22px}
    .pills{display:flex;gap:10px;margin-top:30px;flex-wrap:wrap}
    .pills span{border:1px solid #3f6a58;border-radius:99px;padding:8px 13px;font-size:14.5px;color:#d8e5cf;white-space:nowrap}
    .shot{position:absolute;left:660px;top:76px;width:900px;border-radius:14px;box-shadow:0 30px 80px #000a;border:1px solid #ffffff22}
    </style></head><body><div class="glow"></div><div class="glow b"></div>
    <div class="copy"><div class="mark"><svg viewBox="0 0 34 36"><path d="M3 3h13a15 15 0 0 1 0 30H3V3Z" fill="currentColor"/><path d="m12 11 12 7-12 7Z" fill="#12261f"/></svg>relay</div>
    <h1>Record it once.<br><em>Own it forever.</em></h1>
    <p>The open-source screen recorder and editor for Mac. Videos that look finished, edited like a doc, and yours to keep.</p>
    <div class="pills"><span>No time limits</span><span>4K included</span><span>Bring your own AI</span><span>MIT licensed</span></div></div>
    <img class="shot" src="${inline(path.join(out, "editor.png"))}">
    </body></html>`,
    path.join(out, "banner.png"),
  );
  await art.close();

  const dmgHTML = `<!doctype html><html><head><style>${fontCSS}
    *{margin:0;box-sizing:border-box}
    body{width:600px;height:400px;background:linear-gradient(180deg,#fbfcf8,#eef2e6);font-family:"DM Sans",sans-serif;position:relative;overflow:hidden}
    h1{position:absolute;top:44px;width:100%;text-align:center;font:700 22px Manrope,sans-serif;letter-spacing:-0.6px;color:#173e32}
    p{position:absolute;bottom:40px;width:100%;text-align:center;font-size:13px;color:#6c786f}
    svg.arrow{position:absolute;left:236px;top:168px;width:128px;height:64px}
    </style></head><body>
    <h1>Drag Relay into Applications</h1>
    <svg class="arrow" viewBox="0 0 128 64"><path d="M8 32h100" stroke="#8fb35a" stroke-width="6" stroke-linecap="round" stroke-dasharray="2 14"/><path d="M96 14l22 18-22 18" fill="none" stroke="#5f8a3d" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/></svg>
    <p>Then open Relay from your Applications folder.</p>
    </body></html>`;
  for (const [scale, name] of [
    [1, "background.png"],
    [2, "background@2x.png"],
  ]) {
    const dmg = await browser.newPage({ deviceScaleFactor: scale });
    await dmg.setViewportSize({ width: 600, height: 400 });
    await dmg.goto(`${base}/api/session`);
    await dmg.setContent(dmgHTML);
    await dmg.waitForLoadState("networkidle");
    await dmg.evaluate(() => document.fonts.ready);
    await dmg.screenshot({ path: path.join(dmgOut, name) });
    await dmg.close();
  }
  console.log("Screenshots written to docs/images and desktop/dmg.");
} finally {
  await browser.close();
  server.kill("SIGTERM");
  rmSync(data, { recursive: true, force: true });
}
