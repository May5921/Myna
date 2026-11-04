// pi 原生侧栏模型：工作区是项目边界，会话属于工作区。
// 这里只负责筛选、分组和排序，不创建 DOM，也不依赖渲染层状态。

function textOf(session, getText) {
	if (typeof getText === "function") return String(getText(session) || "").toLowerCase();
	return [session?.name, session?.title, session?.path].filter(Boolean).join(" ").toLowerCase();
}

export function workspaceOrder(cwd, projects) {
	const out = [];
	const seen = new Set();
	for (const value of [cwd, ...(Array.isArray(projects) ? projects : [])]) {
		const path = typeof value === "string" ? value : "";
		if (!path || seen.has(path)) continue;
		seen.add(path);
		out.push(path);
	}
	return out;
}

export function buildSessionGroups(options = {}) {
	const sessions = Array.isArray(options.sessions) ? options.sessions : [];
	const cwd = typeof options.cwd === "string" ? options.cwd : "";
	const query = String(options.query || "").trim().toLowerCase();
	const archiveFilter = ["hide", "all", "only"].includes(options.archiveFilter) ? options.archiveFilter : "hide";
	const archived = options.archived instanceof Set ? options.archived : new Set();
	const pinned = options.pinned instanceof Set ? options.pinned : new Set();
	const currentSession = typeof options.currentSession === "string" ? options.currentSession : "";
	const byWorkspace = new Map();

	for (const session of sessions) {
		if (!session || typeof session !== "object") continue;
		if (query && !textOf(session, options.getText).includes(query)) continue;
		const id = typeof session.path === "string" ? session.path : "";
		const isArchived = id ? archived.has(id) : false;
		if (isArchived && id !== currentSession && archiveFilter === "hide") continue;
		if (!isArchived && id !== currentSession && archiveFilter === "only") continue;
		const workspace = typeof session.cwd === "string" ? session.cwd : "";
		if (!byWorkspace.has(workspace)) byWorkspace.set(workspace, []);
		byWorkspace.get(workspace).push(session);
	}

	for (const list of byWorkspace.values()) {
		list.sort((a, b) => Number(pinned.has(b?.path)) - Number(pinned.has(a?.path)));
	}

	return workspaceOrder(cwd, options.projects).map((workspace) => ({
		workspace,
		current: workspace === cwd,
		sessions: byWorkspace.get(workspace) || [],
	}));
}
