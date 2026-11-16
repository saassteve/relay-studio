const { contextBridge, ipcRenderer } = require("electron");
// Restricted bridge for local, file-loaded recording surfaces. No Node access.
contextBridge.exposeInMainWorld("relayOverlay", {
  countdownResult: (value) =>
    ipcRenderer.send(
      "relay:countdown-result",
      value === "go" ? "go" : "cancel",
    ),
  onBubbleConfig: (fn) =>
    ipcRenderer.on("relay:bubble-config", (_e, config) => fn(config)),
  bubbleSize: (size) => ipcRenderer.send("relay:bubble-size", size),
  hideBubble: () => ipcRenderer.send("relay:bubble-hide"),
  onDrawMode: (fn) => ipcRenderer.on("relay:draw-mode", (_e, on) => fn(!!on)),
  exitDraw: () => ipcRenderer.send("relay:draw-exit"),
  onEngine: (fn) => ipcRenderer.on("relay:engine", (_e, state) => fn(state)),
  engineChoice: (value) =>
    ipcRenderer.send(
      "relay:engine-choice",
      value === "retry" ? "retry" : "quit",
    ),
});
