const video = document.getElementById("video");
let current = "",
  stream;
function mark(size) {
  for (const b of document.querySelectorAll("[data-size]"))
    b.setAttribute("aria-pressed", String(b.dataset.size === size));
}
async function open(deviceId) {
  if (stream && deviceId === current) return;
  current = deviceId;
  stream?.getTracks().forEach((t) => t.stop());
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: {
        ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
        width: { ideal: 640 },
        height: { ideal: 640 },
      },
      audio: false,
    });
    video.srcObject = stream;
    document.getElementById("empty").hidden = true;
  } catch {
    document.getElementById("empty").hidden = false;
  }
}
window.relayOverlay.onBubbleConfig((config) => {
  if (config.size) mark(config.size);
  if (typeof config.deviceId === "string") void open(config.deviceId);
});
for (const b of document.querySelectorAll("[data-size]"))
  b.onclick = () => window.relayOverlay.bubbleSize(b.dataset.size);
document.getElementById("hide").onclick = () => {
  stream?.getTracks().forEach((t) => t.stop());
  window.relayOverlay.hideBubble();
};
addEventListener("beforeunload", () =>
  stream?.getTracks().forEach((t) => t.stop()),
);
