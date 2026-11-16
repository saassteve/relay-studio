let start;
const box = document.getElementById("region");
const clamp = (n, max) => Math.max(0, Math.min(max, n));
onpointerdown = (e) => {
  start = { x: clamp(e.clientX, innerWidth), y: clamp(e.clientY, innerHeight) };
};
onpointermove = (e) => {
  if (!start) return;
  const x = clamp(e.clientX, innerWidth),
    y = clamp(e.clientY, innerHeight);
  Object.assign(box.style, {
    display: "block",
    left: Math.min(start.x, x) + "px",
    top: Math.min(start.y, y) + "px",
    width: Math.abs(x - start.x) + "px",
    height: Math.abs(y - start.y) + "px",
  });
};
onpointerup = (e) => {
  if (!start) return;
  const x = clamp(e.clientX, innerWidth),
    y = clamp(e.clientY, innerHeight);
  if (Math.abs(x - start.x) < 20 || Math.abs(y - start.y) < 20) {
    start = undefined;
    return;
  }
  window.relayControls.chooseRegion({
    x: Math.min(start.x, x) / innerWidth,
    y: Math.min(start.y, y) / innerHeight,
    w: Math.abs(x - start.x) / innerWidth,
    h: Math.abs(y - start.y) / innerHeight,
  });
};
onkeydown = (e) => {
  if (e.key === "Escape") window.relayControls.chooseRegion(null);
};
