let n = Math.min(
  10,
  Math.max(1, Number(new URLSearchParams(location.search).get("seconds")) || 3),
);
const label = document.getElementById("n");
label.textContent = String(n);
let done = false;
const finish = (value) => {
  if (done) return;
  done = true;
  clearInterval(timer);
  window.relayOverlay.countdownResult(value);
};
const timer = setInterval(() => {
  n -= 1;
  if (n <= 0) return finish("go");
  label.textContent = String(n);
  label.style.animation = "none";
  void label.offsetWidth;
  label.style.animation = "";
}, 1000);
document.getElementById("dial").onclick = () => finish("go");
addEventListener("keydown", (e) => {
  if (e.key === "Escape") finish("cancel");
  if (e.key === " " || e.key === "Enter") finish("go");
});
