// Strokes fade a few seconds after they are drawn, like a presenter's marker.
const canvas = document.getElementById("c"),
  ctx = canvas.getContext("2d");
const HOLD = 3000,
  FADE = 900;
let strokes = [],
  live = null,
  frame = 0;
function resize() {
  canvas.width = innerWidth * devicePixelRatio;
  canvas.height = innerHeight * devicePixelRatio;
  canvas.style.width = innerWidth + "px";
  canvas.style.height = innerHeight + "px";
  ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
}
resize();
addEventListener("resize", resize);
function render() {
  const now = performance.now();
  strokes = strokes.filter((s) => s === live || now - s.done < HOLD + FADE);
  ctx.clearRect(0, 0, innerWidth, innerHeight);
  for (const s of strokes) {
    const age = s === live ? 0 : now - s.done;
    ctx.globalAlpha = age < HOLD ? 1 : Math.max(0, 1 - (age - HOLD) / FADE);
    ctx.strokeStyle = "#ff5a36";
    ctx.lineWidth = 5;
    ctx.lineCap = ctx.lineJoin = "round";
    ctx.beginPath();
    s.points.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    ctx.stroke();
  }
  frame = strokes.length ? requestAnimationFrame(render) : 0;
}
const wake = () => {
  if (!frame) frame = requestAnimationFrame(render);
};
addEventListener("pointerdown", (e) => {
  if (!document.body.classList.contains("drawing")) return;
  live = { points: [[e.clientX, e.clientY]], done: 0 };
  strokes.push(live);
  wake();
});
addEventListener("pointermove", (e) => {
  if (live) live.points.push([e.clientX, e.clientY]);
});
addEventListener("pointerup", () => {
  if (live) live.done = performance.now();
  live = null;
  wake();
});
addEventListener("keydown", (e) => {
  if (e.key === "Escape") window.relayOverlay.exitDraw();
});
window.relayOverlay.onDrawMode((on) => {
  document.body.classList.toggle("drawing", on);
});
