const $ = (id) => document.getElementById(id);
const mb = (n) => `${(n / 1e6).toFixed(1)} MB`;
window.relayOverlay.onEngine((state) => {
  document.body.classList.toggle("failed", state.status === "failed");
  if (state.status === "failed") {
    $("title").textContent = "Couldn’t finish setting up";
    $("detail").textContent = `${state.message} Check your internet connection and try again.`;
    return;
  }
  if (state.status === "ready") {
    $("title").textContent = "All set.";
    $("detail").textContent = "Opening Relay…";
  } else {
    $("title").textContent = "Getting Relay ready…";
    $("detail").textContent =
      "Downloading the video engine. This happens once and takes a few seconds.";
  }
  const pct = Math.round((state.progress || 0) * 100);
  $("bar").style.width = `${Math.max(3, pct)}%`;
  $("pct").textContent = `${pct}%`;
  $("size").textContent = state.total ? `${mb(state.received)} of ${mb(state.total)}` : "";
});
$("retry").onclick = () => window.relayOverlay.engineChoice("retry");
$("quit").onclick = () => window.relayOverlay.engineChoice("quit");
