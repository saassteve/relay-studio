// Renders Relay's built-in wallpapers to public/wallpapers.
// Usage: node scripts/wallpapers.mjs
import { chromium } from "@playwright/test";
import { mkdirSync } from "node:fs";
import path from "node:path";

// Each wallpaper is a base colour with soft blobs of colour laid over it.
export const WALLPAPERS = {
  aurora: [
    "#0f2a3f",
    ["#2ee6a6", 18, 22, 46],
    ["#3b82f6", 78, 18, 50],
    ["#a855f7", 62, 82, 52],
    ["#0ea5e9", 12, 88, 40],
  ],
  dusk: [
    "#1b1740",
    ["#f472b6", 80, 78, 50],
    ["#fb923c", 96, 96, 36],
    ["#6366f1", 20, 20, 52],
    ["#a78bfa", 58, 30, 36],
  ],
  ocean: [
    "#06283d",
    ["#22d3ee", 22, 76, 48],
    ["#2563eb", 80, 24, 54],
    ["#5eead4", 70, 88, 36],
    ["#1e3a8a", 12, 12, 40],
  ],
  ember: [
    "#2a0f1a",
    ["#f97316", 18, 82, 48],
    ["#ef4444", 76, 70, 46],
    ["#fbbf24", 4, 100, 30],
    ["#be185d", 84, 14, 46],
  ],
  mint: [
    "#d9f5e5",
    ["#86efac", 16, 22, 48],
    ["#a7f3d0", 82, 78, 52],
    ["#fef08a", 86, 14, 38],
    ["#bae6fd", 14, 86, 44],
  ],
  candy: [
    "#fde7f3",
    ["#f9a8d4", 18, 24, 48],
    ["#c4b5fd", 82, 26, 48],
    ["#fdba74", 78, 86, 42],
    ["#a5f3fc", 16, 84, 44],
  ],
  graphite: [
    "#111418",
    ["#334155", 20, 20, 52],
    ["#1f2937", 82, 78, 56],
    ["#475569", 86, 12, 34],
    ["#0f172a", 10, 90, 44],
  ],
  paper: [
    "#f4f1ea",
    ["#e7e0d1", 20, 24, 50],
    ["#fbfaf6", 80, 20, 46],
    ["#ddd5c3", 84, 86, 46],
    ["#f0e9da", 12, 88, 40],
  ],
  pine: [
    "#12352b",
    ["#2f7a5e", 74, 24, 52],
    ["#d6f475", 96, 4, 26],
    ["#1d5a47", 18, 82, 50],
    ["#0b241d", 6, 8, 40],
  ],
};

if (import.meta.url === `file://${process.argv[1]}`) {
  const out = path.resolve("public/wallpapers");
  mkdirSync(out, { recursive: true });
  const browser = await chromium.launch({
    channel: process.env.RELAY_BROWSER_CHANNEL || "chrome",
  });
  const page = await browser.newPage({
    viewport: { width: 1920, height: 1080 },
    deviceScaleFactor: 1,
  });
  for (const [name, [base, ...blobs]] of Object.entries(WALLPAPERS)) {
    const layers = blobs
      .map(
        ([c, x, y, r]) =>
          `radial-gradient(circle at ${x}% ${y}%, ${c} 0%, ${c}00 ${r}%)`,
      )
      .join(",");
    // A touch of film grain stops gradients banding once encoded.
    await page.setContent(`<body style="margin:0;width:1920px;height:1080px;background:${layers},${base}">
      <svg width="1920" height="1080" style="position:absolute;inset:0;opacity:.07;mix-blend-mode:overlay">
        <filter id="n"><feTurbulence type="fractalNoise" baseFrequency=".9" numOctaves="2"/></filter>
        <rect width="100%" height="100%" filter="url(#n)"/></svg></body>`);
    await page.screenshot({
      path: path.join(out, `${name}.jpg`),
      type: "jpeg",
      quality: 88,
    });
  }
  await browser.close();
  console.log(
    `Wrote ${Object.keys(WALLPAPERS).length} wallpapers to public/wallpapers.`,
  );
}
