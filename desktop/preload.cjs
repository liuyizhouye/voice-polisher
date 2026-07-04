const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("voicePolisher", {
  saveNote(payload) {
    return ipcRenderer.invoke("voice-polisher:save-note", payload);
  }
});
