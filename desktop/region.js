// Choosing the part of the screen to record: drag a rectangle, or make one with
// the keyboard. Arrow keys move it, Shift and arrows change its size, Option
// makes the steps small, Return records it and Escape cancels.
let start,
  // The rectangle as it stands, in pixels of this window. None until one is made.
  rect;
const box = document.getElementById("region"),
  said = document.getElementById("said");
const clamp = (n, max) => Math.max(0, Math.min(max, n));
// The smallest region worth recording.
const SMALLEST = 20;
function draw() {
  Object.assign(box.style, {
    display: "block",
    left: rect.x + "px",
    top: rect.y + "px",
    width: rect.w + "px",
    height: rect.h + "px",
  });
}
const choose = () =>
  window.relayControls.chooseRegion({
    x: rect.x / innerWidth,
    y: rect.y / innerHeight,
    w: rect.w / innerWidth,
    h: rect.h / innerHeight,
  });
const dragged = (e) => {
  const x = clamp(e.clientX, innerWidth),
    y = clamp(e.clientY, innerHeight);
  return {
    x: Math.min(start.x, x),
    y: Math.min(start.y, y),
    w: Math.abs(x - start.x),
    h: Math.abs(y - start.y),
  };
};
onpointerdown = (e) => {
  start = { x: clamp(e.clientX, innerWidth), y: clamp(e.clientY, innerHeight) };
};
onpointermove = (e) => {
  if (!start) return;
  rect = dragged(e);
  draw();
};
onpointerup = (e) => {
  if (!start) return;
  const made = dragged(e);
  start = undefined;
  // A click, or a drag too small to mean anything, leaves things as they were.
  if (made.w < SMALLEST || made.h < SMALLEST) return;
  rect = made;
  choose();
};
onkeydown = (e) => {
  if (e.key === "Escape") return window.relayControls.chooseRegion(null);
  if (e.key === "Enter" && rect) return choose();
  const way = {
    ArrowLeft: [-1, 0],
    ArrowRight: [1, 0],
    ArrowUp: [0, -1],
    ArrowDown: [0, 1],
  }[e.key];
  if (!way) return;
  e.preventDefault();
  // The first arrow key puts a rectangle in the middle to start from.
  rect ||= {
    x: Math.round(innerWidth / 4),
    y: Math.round(innerHeight / 4),
    w: Math.round(innerWidth / 2),
    h: Math.round(innerHeight / 2),
  };
  const step = e.altKey ? 1 : 10,
    dx = way[0] * step,
    dy = way[1] * step;
  if (e.shiftKey) {
    rect.w = Math.max(SMALLEST, Math.min(innerWidth - rect.x, rect.w + dx));
    rect.h = Math.max(SMALLEST, Math.min(innerHeight - rect.y, rect.h + dy));
  } else {
    rect.x = clamp(rect.x + dx, innerWidth - rect.w);
    rect.y = clamp(rect.y + dy, innerHeight - rect.h);
  }
  draw();
  // For someone who can't see the rectangle: where it is and how large.
  said.textContent = `${rect.w} by ${rect.h}, ${rect.x} from the left and ${rect.y} from the top. Press Return to record this region.`;
};
