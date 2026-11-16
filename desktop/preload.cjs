const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("relayDesktop", {
  platform: process.platform,
  sources: () => ipcRenderer.invoke("relay:sources"),
  selectSource: (id) => ipcRenderer.invoke("relay:select-source", id),
  selectRegion: (sourceId) => ipcRenderer.invoke("relay:region", sourceId),
  permissionStatus: () => ipcRenderer.invoke("relay:permissions"),
  captureState: (state) => ipcRenderer.send("relay:capture-state", state),
  notify: (message) => ipcRenderer.send("relay:notify", message),
  checkForUpdates: () => ipcRenderer.invoke("relay:updates"),
  info: () => ipcRenderer.invoke("relay:info"),
  requestPermission: (kind) =>
    ipcRenderer.invoke("relay:permission-request", kind),
  openPermissionSettings: (kind) =>
    ipcRenderer.invoke("relay:permission-settings", kind),
  relaunch: () => ipcRenderer.invoke("relay:relaunch"),
  prepareRecording: (options) =>
    ipcRenderer.invoke("relay:prepare-recording", options),
  cameraLayout: () => ipcRenderer.invoke("relay:camera-layout"),
  onControl: (fn) => {
    const listener = (_e, action) => fn(action);
    ipcRenderer.on("relay:control", listener);
    return () => ipcRenderer.removeListener("relay:control", listener);
  },
  onPointer: (fn) => {
    const listener = (_e, point) => fn(point);
    ipcRenderer.on("relay:pointer", listener);
    return () => ipcRenderer.removeListener("relay:pointer", listener);
  },
  onRecord: (fn) => {
    const listener = () => fn();
    ipcRenderer.on("relay:record", listener);
    return () => ipcRenderer.removeListener("relay:record", listener);
  },
});
