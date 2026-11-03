const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("pi", {
	boot: () => ipcRenderer.invoke("pi:boot"),
	command: (cmd) => ipcRenderer.invoke("pi:command", cmd),
	sendRaw: (payload) => ipcRenderer.invoke("pi:send-raw", payload),
	pickFolder: () => ipcRenderer.invoke("pi:pick-folder"),
	setCwd: (cwd) => ipcRenderer.invoke("pi:set-cwd", cwd),
	sessions: (opts) => ipcRenderer.invoke("pi:sessions", opts),
	searchSessions: (input) => ipcRenderer.invoke("pi:search-sessions", input),
	listFiles: (cwd) => ipcRenderer.invoke("pi:list-files", cwd),
	gitChanges: () => ipcRenderer.invoke("pi:git-changes"),
	gitDiff: (path) => ipcRenderer.invoke("pi:git-diff", path),
	perf: () => ipcRenderer.invoke("pi:perf"),
	appInfo: () => ipcRenderer.invoke("pi:app-info"),
	providers: () => ipcRenderer.invoke("pi:providers"),
	saveProvider: (input) => ipcRenderer.invoke("pi:save-provider", input),
	deleteProvider: (key) => ipcRenderer.invoke("pi:delete-provider", key),
	openPath: (path) => ipcRenderer.invoke("pi:open-path", path),
	openExternal: (url) => ipcRenderer.invoke("pi:open-external", url),
	highlight: (items) => ipcRenderer.invoke("pi:highlight", items),
	switchSession: (path) => ipcRenderer.invoke("pi:switch-session", path),
	newSession: () => ipcRenderer.invoke("pi:new-session"),
	onEvent: (fn) => ipcRenderer.on("pi:event", (_e, ev) => fn(ev)),
	onStderr: (fn) => ipcRenderer.on("pi:stderr", (_e, text) => fn(text)),
	termRun: (input) => ipcRenderer.invoke("pi:term-run", input),
	termKill: (runId) => ipcRenderer.invoke("pi:term-kill", runId),
	onTermData: (fn) => {
		const h = (_e, payload) => fn(payload);
		ipcRenderer.on("pi:term-data", h);
		return () => ipcRenderer.removeListener("pi:term-data", h);
	},
	onTermExit: (fn) => {
		const h = (_e, payload) => fn(payload);
		ipcRenderer.on("pi:term-exit", h);
		return () => ipcRenderer.removeListener("pi:term-exit", h);
	},
});
