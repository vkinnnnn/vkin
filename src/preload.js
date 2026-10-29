// Narrow bridge. Never exposes keys, config or Node APIs to renderers.
const { contextBridge, ipcRenderer } = require('electron');

const IPC = {
  AUDIO_FRAME: 'audio:frame',
  CAPTURE_STATUS: 'capture:status',
  CAPTURE_CMD: 'capture:cmd',
  UI_EVENT: 'ui:event',
  UI_CMD: 'ui:cmd',
};

contextBridge.exposeInMainWorld('copilot', {
  capture: {
    sendFrame: (channel, buffer, level) => ipcRenderer.send(IPC.AUDIO_FRAME, { channel, pcm: buffer, level }),
    sendStatus: (status) => ipcRenderer.send(IPC.CAPTURE_STATUS, status),
    onCmd: (cb) => ipcRenderer.on(IPC.CAPTURE_CMD, (_e, msg) => cb(msg)),
  },
  ui: {
    onEvent: (cb) => ipcRenderer.on(IPC.UI_EVENT, (_e, msg) => cb(msg)),
    send: (cmd, args = {}) => ipcRenderer.send(IPC.UI_CMD, { cmd, ...args }),
    invoke: (cmd, args = {}) => ipcRenderer.invoke(IPC.UI_CMD, { cmd, ...args }),
  },
  // Prep window only; main rejects prep commands from any other window.
  prep: {
    invoke: (cmd, args = {}) => ipcRenderer.invoke('prep:cmd', { cmd, ...args }),
  },
});
