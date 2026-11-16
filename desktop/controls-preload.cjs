const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("relayControls", {
  action: (action) => ipcRenderer.send("relay:control-action", action),
  chooseRegion: (region) => ipcRenderer.send("relay:region-result", region),
  onState: (fn) => ipcRenderer.on("relay:state", (_event, state) => fn(state)),
});
