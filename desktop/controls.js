for (const action of ["pause", "retake", "stop", "studio", "cancel", "draw"])
  document.getElementById(action).onclick = () =>
    window.relayControls.action(action);
window.relayControls.onState((state) => {
  const n = Math.floor(state.seconds);
  document.getElementById("time").textContent =
    `${Math.floor(n / 60)}:${String(n % 60).padStart(2, "0")}`;
  document.getElementById("pause").textContent = state.paused
    ? "Resume"
    : "Pause";
  document.getElementById("status").textContent = state.paused
    ? "Paused"
    : "Recording";
  document.body.classList.toggle("paused", !!state.paused);
  document
    .getElementById("draw")
    .setAttribute("aria-pressed", String(!!state.draw));
  document.getElementById("draw").hidden = state.canDraw === false;
  document.getElementById("notes").textContent =
    state.notes || "Your talking points appear here.";
});
