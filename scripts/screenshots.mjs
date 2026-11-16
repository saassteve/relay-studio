// Regenerates README screenshots, the banner and the DMG background.
// Usage: npm run build && node scripts/screenshots.mjs
import { chromium } from "@playwright/test";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync, readFileSync } from "node:fs";
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

const browser = await chromium.launch({
  channel: process.env.RELAY_BROWSER_CHANNEL || "chrome",
});
try {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
  });
  const page = await context.newPage();
  await page.request.put(`${base}/api/profile`, {
    data: { name: "Alex Rivera" },
  });
  await page.request.put(`${base}/api/preferences`, {
    data: { onboarded: true },
  });
  await page.goto(base);

  // Demo recordings drawn on a canvas, recorded with MediaRecorder and uploaded via the API.
  const demos = [
    ["Q4 roadmap walkthrough", "board", "Planning", true, 128],
    ["Bug: checkout total doesn’t update", "bug", "Engineering", false, 43],
    ["Onboarding flow · design review", "phones", "Design", true, 76],
    ["Weekly update · week 46", "chart", "", false, 214],
    ["How we deploy to staging", "terminal", "Engineering", false, 31],
    ["Pricing page feedback", "web", "Design", false, 18],
  ];
  for (const [title, kind, folder, starred, views] of demos) {
    await page.evaluate(
      async ({ title, kind }) => {
        const W = 1280,
          H = 720;
        const c = document.createElement("canvas");
        c.width = W;
        c.height = H;
        const g = c.getContext("2d");
        const font = (w, s) => `${w} ${s}px "DM Sans", system-ui, sans-serif`;
        const rr = (x, y, w, h, r, fill) => {
          g.beginPath();
          g.roundRect(x, y, w, h, r);
          g.fillStyle = fill;
          g.fill();
        };
        const chrome = (bg) => {
          g.fillStyle = bg;
          g.fillRect(0, 0, W, H);
          rr(0, 0, W, 44, 0, "#e9ece4");
          ["#ee6a5f", "#f5be4f", "#62c554"].forEach((c, i) => {
            g.beginPath();
            g.arc(24 + i * 20, 22, 6, 0, 7);
            g.fillStyle = c;
            g.fill();
          });
          rr(380, 11, 520, 22, 11, "#fff");
        };
        const draw = (t) => {
          if (kind === "board") {
            chrome("#f6f7f2");
            g.fillStyle = "#173e32";
            g.font = font(700, 34);
            g.fillText("Q4 Roadmap", 60, 110);
            ["Now", "Next", "Later"].forEach((col, i) => {
              const x = 60 + i * 390;
              g.font = font(600, 18);
              g.fillStyle = "#5d6b61";
              g.fillText(col.toUpperCase(), x, 165);
              for (let k = 0; k < 4 - i; k++) {
                rr(x, 185 + k * 110, 360, 92, 12, "#fff");
                rr(
                  x + 18,
                  205 + k * 110,
                  60,
                  10,
                  5,
                  ["#d6f475", "#bfe3f5", "#f6d9a8"][(i + k) % 3],
                );
                rr(x + 18, 230 + k * 110, 260 - k * 30, 12, 6, "#dfe4d8");
                rr(x + 18, 252 + k * 110, 180, 12, 6, "#ecefe7");
              }
            });
          } else if (kind === "bug") {
            chrome("#ffffff");
            g.fillStyle = "#1d2a24";
            g.font = font(700, 30);
            g.fillText("Checkout", 80, 120);
            for (let k = 0; k < 3; k++) {
              rr(80, 160 + k * 96, 640, 80, 12, "#f4f6f1");
              rr(
                100,
                178 + k * 96,
                44,
                44,
                8,
                ["#f6d9a8", "#bfe3f5", "#d6f475"][k],
              );
              rr(164, 186 + k * 96, 220, 12, 6, "#cfd6c7");
              g.font = font(600, 20);
              g.fillStyle = "#1d2a24";
              g.fillText(`$${[24, 18, 42][k]}.00`, 620, 210 + k * 96);
            }
            rr(780, 160, 420, 260, 14, "#173e32");
            g.fillStyle = "#c3d1c6";
            g.font = font(500, 18);
            g.fillText("Order total", 812, 210);
            g.fillStyle = "#fff";
            g.font = font(700, 48);
            g.fillText("$66.00", 812, 270);
            g.strokeStyle = "#ff5a36";
            g.lineWidth = 6;
            g.beginPath();
            g.ellipse(905, 254, 120 + Math.sin(t * 4) * 4, 48, 0, 0, 7);
            g.stroke();
          } else if (kind === "phones") {
            g.fillStyle = "#eef2e6";
            g.fillRect(0, 0, W, H);
            [0, 1, 2].forEach((i) => {
              const x = 150 + i * 360;
              rr(x, 80 + (i === 1 ? -20 : 20), 270, 560, 36, "#173e32");
              rr(
                x + 14,
                96 + (i === 1 ? -20 : 20),
                242,
                528,
                26,
                i === 1 ? "#d6f475" : "#fbfcf8",
              );
              g.fillStyle = "#173e32";
              g.font = font(700, 26);
              g.fillText(
                ["Welcome", "Allow access", "You’re set"][i],
                x + 36,
                200 + (i === 1 ? -20 : 20),
              );
              rr(x + 36, 520 + (i === 1 ? -20 : 20), 198, 46, 23, "#173e32");
            });
          } else if (kind === "chart") {
            chrome("#fbfcf8");
            g.fillStyle = "#173e32";
            g.font = font(700, 34);
            g.fillText("Weekly active teams", 60, 110);
            g.font = font(500, 18);
            g.fillStyle = "#5f8a3d";
            g.fillText("▲ 18% week over week", 60, 145);
            const vals = [38, 44, 41, 52, 58, 61, 67, 72, 70, 81, 88, 96];
            vals.forEach((v, i) => {
              const h = v * 4.4 * Math.min(1, t / 1.5 + 0.4);
              rr(
                80 + i * 95,
                640 - h,
                62,
                h,
                8,
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
            lines.slice(0, 2 + Math.floor(t * 2)).forEach(([l, c], i) => {
              g.fillStyle = c;
              g.fillText(l, 70, 120 + i * 62);
            });
          } else {
            chrome("#ffffff");
            g.fillStyle = "#1d2a24";
            g.font = font(700, 40);
            g.fillText("Simple pricing", 470, 140);
            ["Starter", "Team", "Business"].forEach((p, i) => {
              rr(
                160 + i * 330,
                200,
                300,
                400,
                18,
                i === 1 ? "#173e32" : "#f4f6f1",
              );
              g.fillStyle = i === 1 ? "#d6f475" : "#1d2a24";
              g.font = font(700, 26);
              g.fillText(p, 190 + i * 330, 260);
              g.font = font(700, 44);
              g.fillText(["$0", "$12", "$29"][i], 190 + i * 330, 330);
            });
            rr(820, 120, 300, 86, 14, "#fff7d6");
            g.fillStyle = "#6d5520";
            g.font = font(600, 18);
            g.fillText("💬 Make Team the default?", 840, 172);
          }
          // Camera bubble, as it appears in a Relay recording.
          const r = 78,
            cx = 100,
            cy = H - 100;
          g.beginPath();
          g.arc(cx, cy, r + 5, 0, 7);
          g.fillStyle = "#d6f475";
          g.fill();
          const grad = g.createLinearGradient(cx - r, cy - r, cx + r, cy + r);
          grad.addColorStop(0, "#3f7a61");
          grad.addColorStop(1, "#173e32");
          g.beginPath();
          g.arc(cx, cy, r, 0, 7);
          g.fillStyle = grad;
          g.fill();
          g.fillStyle = "#f3e1cf";
          g.beginPath();
          g.arc(cx, cy - 12, 28, 0, 7);
          g.fill();
          g.beginPath();
          g.ellipse(cx, cy + 58, 50, 40, 0, Math.PI, 0);
          g.fill();
        };
        await document.fonts.ready;
        const stream = c.captureStream(24);
        const rec = new MediaRecorder(stream, {
          mimeType: "video/webm;codecs=vp8",
        });
        const chunks = [];
        rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
        const start = performance.now();
        let frame;
        const loop = () => {
          draw((performance.now() - start) / 1000);
          frame = requestAnimationFrame(loop);
        };
        loop();
        rec.start();
        await new Promise((r) => setTimeout(r, 3000));
        await new Promise((r) => {
          rec.onstop = r;
          rec.stop();
        });
        cancelAnimationFrame(frame);
        draw(3);
        const thumb = document.createElement("canvas");
        thumb.width = 640;
        thumb.height = 360;
        thumb.getContext("2d").drawImage(c, 0, 0, 640, 360);
        const form = new FormData();
        form.append(
          "video",
          new Blob(chunks, { type: "video/webm" }),
          "demo.webm",
        );
        form.append("title", title);
        form.append("duration", String(60 + Math.floor(Math.random() * 400)));
        form.append("thumbnail", thumb.toDataURL("image/jpeg", 0.85));
        const res = await fetch("/api/videos", { method: "POST", body: form });
        if (!res.ok) throw new Error(await res.text());
        window.__last = (await res.json()).id;
      },
      { title, kind },
    );
    const id = await page.evaluate(() => window.__last);
    await page.request.patch(`${base}/api/videos/${id}`, {
      data: { folder, starred },
    });
    if (views) await page.request.post(`${base}/api/videos/${id}/share`);
  }

  // Library
  await page.goto(base);
  await page.waitForSelector(".video-card img");
  await page.waitForTimeout(800);
  await page.screenshot({ path: path.join(out, "library.png") });
  await page.evaluate(() =>
    document.querySelector(".library-section")?.scrollIntoView(),
  );
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(out, "library-grid.png") });

  // Studio editor
  await page.goto(base);
  await page.locator(".video-card .thumbnail").nth(1).click();
  await page.waitForSelector(".studio-workbench");
  await page.waitForFunction(() => {
    const v = document.querySelector(".video-player video");
    return v && v.readyState >= 2;
  });
  await page.waitForTimeout(1500);
  await page.screenshot({ path: path.join(out, "studio.png") });

  // Recorder
  await page.setViewportSize({ width: 1440, height: 1180 });
  await page.goto(base);
  await page
    .getByRole("button", { name: /New recording/ })
    .first()
    .click();
  await page.waitForSelector(".recorder-dialog");
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(out, "recorder.png") });

  // Camera looks, using an illustrated presenter in place of a real camera.
  const lookPage = await context.newPage();
  await lookPage.setViewportSize({ width: 1440, height: 1180 });
  await lookPage.addInitScript(() => {
    const presenter = () => {
      const c = document.createElement("canvas");
      c.width = 960;
      c.height = 720;
      const g = c.getContext("2d");
      let t = 0;
      setInterval(() => {
        t += 0.04;
        // A plain room behind the presenter.
        const wall = g.createLinearGradient(0, 0, 0, 720);
        wall.addColorStop(0, "#d9d4cb");
        wall.addColorStop(1, "#b9b2a6");
        g.fillStyle = wall;
        g.fillRect(0, 0, 960, 720);
        g.fillStyle = "#a08f78";
        g.fillRect(90, 120, 160, 260);
        g.fillStyle = "#7c8a6a";
        g.beginPath();
        g.ellipse(760, 300, 70, 120, 0, 0, 7);
        g.fill();
        const sway = Math.sin(t) * 6;
        // Shoulders and shirt
        g.fillStyle = "#2f5d8a";
        g.beginPath();
        g.ellipse(480 + sway, 720, 300, 210, 0, Math.PI, 0);
        g.fill();
        // Neck
        g.fillStyle = "#d9a07f";
        g.fillRect(445 + sway, 430, 70, 90);
        // Head
        g.beginPath();
        g.ellipse(480 + sway, 350, 118, 142, 0, 0, 7);
        g.fill();
        // Hair
        g.fillStyle = "#3b2a20";
        g.beginPath();
        g.ellipse(480 + sway, 268, 128, 78, 0, Math.PI, 0);
        g.fill();
        g.fillRect(352 + sway, 262, 24, 80);
        g.fillRect(584 + sway, 262, 24, 80);
        // Face
        g.fillStyle = "#2a1f19";
        g.beginPath();
        g.arc(438 + sway, 350, 9, 0, 7);
        g.arc(522 + sway, 350, 9, 0, 7);
        g.fill();
        g.strokeStyle = "#8a4b3a";
        g.lineWidth = 6;
        g.beginPath();
        g.arc(480 + sway, 400, 34, 0.2, Math.PI - 0.2);
        g.stroke();
      }, 33);
      return c.captureStream(30);
    };
    const original = navigator.mediaDevices.getUserMedia.bind(
      navigator.mediaDevices,
    );
    navigator.mediaDevices.getUserMedia = async (c) =>
      c && c.video ? presenter() : original(c);
  });
  await lookPage.request.put(`${base}/api/preferences`, {
    data: { cameraFilter: "vivid", cameraBackground: "none" },
  });
  await lookPage.goto(base);
  await lookPage
    .getByRole("button", { name: /New recording/ })
    .first()
    .click();
  await lookPage
    .getByRole("button", { name: "Screen + camera", exact: true })
    .click();
  await lookPage.locator(".look-preview video").waitFor();
  await lookPage.waitForFunction(
    () => !document.querySelector(".look-busy"),
    null,
    {
      timeout: 60000,
    },
  );
  await lookPage.waitForTimeout(1500);
  await lookPage.evaluate(() =>
    document.querySelector(".camera-look")?.scrollIntoView({ block: "center" }),
  );
  const box = await lookPage.locator(".camera-look").boundingBox();
  await lookPage.screenshot({
    path: path.join(out, "camera-looks.png"),
    clip: {
      x: box.x - 24,
      y: box.y - 20,
      width: box.width + 48,
      height: box.height + 40,
    },
  });
  await lookPage.close();
  await page.request.put(`${base}/api/preferences`, {
    data: { cameraFilter: "none", cameraBackground: "none" },
  });

  await page.setViewportSize({ width: 1440, height: 900 });
  // Onboarding
  await page.request.put(`${base}/api/preferences`, {
    data: { onboarded: false, onboardingStep: null },
  });
  await page.goto(base);
  await page.getByRole("dialog", { name: "Set up Relay" }).waitFor();
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(out, "onboarding.png") });
  await page.getByRole("button", { name: /Let’s get set up/ }).click();
  await page.getByRole("button", { name: "Continue" }).click();
  await page
    .getByRole("button", { name: "Continue" })
    .click()
    .catch(() => {});
  await page.getByRole("heading", { name: "Make it yours." }).waitFor();
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(out, "onboarding-preferences.png") });

  // Banner and DMG background, composed from HTML.
  // Same-origin pages so the app's fonts load; images are inlined.
  const inline = (file) =>
    `data:image/png;base64,${readFileSync(file).toString("base64")}`;
  const art = await browser.newPage({ deviceScaleFactor: 2 });
  await art.goto(`${base}/api/session`);
  const fontCSS = `@import url("${base}/fonts/fonts.css");`;
  await art.setViewportSize({ width: 1280, height: 640 });
  await art.setContent(`<!doctype html><html><head><style>${fontCSS}
    *{box-sizing:border-box;margin:0}
    body{width:1280px;height:640px;overflow:hidden;background:#173e32;font-family:"DM Sans",sans-serif;color:#e9f0de;position:relative}
    .glow{position:absolute;width:900px;height:900px;border-radius:50%;background:radial-gradient(circle,#2f6a5299,transparent 65%);right:-260px;top:-240px}
    .copy{position:absolute;left:72px;top:92px;width:520px}
    .mark{display:flex;align-items:center;gap:12px;font:700 30px Manrope,sans-serif;color:#d6f475;letter-spacing:-1px}
    .mark svg{width:34px;height:36px}
    h1{font:700 58px/1.04 Manrope,sans-serif;letter-spacing:-2.6px;color:#fbfdf2;margin-top:46px}
    h1 em{font-style:normal;color:#d6f475}
    p{font-size:20px;line-height:1.5;color:#b5c8bb;margin-top:22px}
    .pills{display:flex;gap:10px;margin-top:30px;flex-wrap:wrap}
    .pills span{border:1px solid #3f6a58;border-radius:99px;padding:8px 14px;font-size:15px;color:#d8e5cf}
    .shot{position:absolute;left:640px;top:84px;width:820px;border-radius:14px;box-shadow:0 30px 80px #0008;border:1px solid #ffffff22}
    </style></head><body><div class="glow"></div>
    <div class="copy"><div class="mark"><svg viewBox="0 0 34 36"><path d="M3 3h13a15 15 0 0 1 0 30H3V3Z" fill="currentColor"/><path d="m12 11 12 7-12 7Z" fill="#173e32"/></svg>relay</div>
    <h1>Record it once.<br><em>Own it forever.</em></h1>
    <p>The open-source screen recorder for Mac. Screen, camera and voice, edited by deleting words, shared with one link.</p>
    <div class="pills"><span>No time limits</span><span>4K included</span><span>On-device AI</span><span>MIT licensed</span></div></div>
    <img class="shot" src="${inline(path.join(out, "library-grid.png"))}">
    </body></html>`);
  await art.waitForLoadState("networkidle");
  await art.evaluate(() => document.fonts.ready);
  await art.screenshot({ path: path.join(out, "banner.png") });

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
