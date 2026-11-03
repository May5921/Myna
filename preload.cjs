const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("pi", {
	boot: () => ipcRenderer.invoke("pi:boot"),
	command: (cmd) => ipcRenderer.invoke("pi:command", cmd),
	sendRaw: (payload) => ipcRenderer.invoke("pi:send-raw", payload),
	pickFolder: () => ipcRenderer.invoke("pi:pick-folder"),
	setCwd: (cwd) => ipcRenderer.invoke("pi:set-cwd", cwd),
	sessions: (opts) => ipcRenderer.invoke("pi:sessions", opts),
	listFiles: (cwd) => ipcRenderer.invoke("pi:list-files", cwd),
	gitChanges: () => ipcRenderer.invoke("pi:git-changes"),
	gitDiff: (path) => ipcRenderer.invoke("pi:git-diff", path),
	perf: () => ipcRenderer.invoke("pi:perf"),
	openPath: (path) => ipcRenderer.invoke("pi:open-path", path),
	openExternal: (url) => ipcRenderer.invoke("pi:open-external", url),
	highlight: (items) => ipcRenderer.invoke("pi:highlight", items),
	switchSession: (path) => ipcRenderer.invoke("pi:switch-session", path),
	newSession: () => ipcRenderer.invoke("pi:new-session"),
	onEvent: (fn) => ipcRenderer.on("pi:event", (_e, ev) => fn(ev)),
	onStderr: (fn) => ipcRenderer.on("pi:stderr", (_e, text) => fn(text)),
});
