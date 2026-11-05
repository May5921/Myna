// 首次启动引导：工作区 → 模型 → 测试消息。
// 只做三件事，不复制设置页的完整 provider 编辑器；缺模型时把用户送到设置页。
const DONE_KEY = "myna.onboarding.done";

const CSS = `
.onb-back {
	position: fixed; inset: 0; z-index: 55;
	display: flex; align-items: center; justify-content: center;
	padding: 24px; background: rgba(0, 0, 0, 0.30);
}
.onb-back[hidden] { display: none; }
.onb {
	width: min(480px, 100%);
	background: var(--bg); color: var(--text);
	border: 1px solid var(--line); border-radius: var(--radius-md);
	box-shadow: var(--shadow-menu); overflow: hidden;
}
.onb-head { padding: 20px 22px 10px; }
.onb-kicker { font: 11px/1.4 var(--mono); letter-spacing: .06em; color: var(--faint); text-transform: uppercase; }
.onb-title { margin-top: 6px; font-size: 18px; line-height: 24px; font-weight: 600; }
.onb-sub { margin-top: 5px; font-size: 12.5px; line-height: 1.55; color: var(--dim); }
.onb-body { padding: 6px 22px 4px; }
.onb-step { font-size: 12px; color: var(--faint); margin-bottom: 8px; }
.onb-path {
	padding: 9px 10px; border: 1px solid var(--line); border-radius: 7px;
	background: var(--surface-2); font: 12px/1.5 var(--mono); overflow-wrap: anywhere;
}
.onb-list { display: flex; flex-direction: column; gap: 4px; max-height: 220px; overflow: auto; }
.onb-model {
	display: flex; align-items: center; gap: 8px; width: 100%;
	padding: 8px 10px; border: 1px solid transparent; border-radius: 7px;
	background: none; color: var(--text); text-align: left; cursor: pointer; font-size: 12.5px;
}
.onb-model:hover, .onb-model.on { background: var(--hover); border-color: var(--line); }
.onb-model-prov { flex: none; color: var(--faint); font: 11px/1.4 var(--mono); }
.onb-model-id { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.onb-status { min-height: 18px; padding: 8px 22px 0; font-size: 12px; line-height: 1.5; color: var(--faint); }
.onb-status.err { color: var(--err); }
.onb-actions { display: flex; gap: 8px; justify-content: flex-end; padding: 14px 22px 18px; border-top: 1px solid var(--line); margin-top: 10px; }
.onb-btn {
	height: 30px; padding: 0 12px; border: 1px solid var(--line-strong); border-radius: 7px;
	background: var(--bg); color: var(--text); font-size: 12.5px; cursor: pointer;
}
.onb-btn:hover:not(:disabled) { background: var(--hover); }
.onb-btn.primary { background: var(--text); color: var(--bg); border-color: var(--text); }
.onb-btn:disabled { opacity: .5; cursor: default; }
.onb-link { border: 0; background: none; color: var(--faint); font-size: 12px; text-decoration: underline; cursor: pointer; padding: 0; }
`;

export function onboardingDone(storage) {
	try {
		return storage?.getItem(DONE_KEY) === "1";
	} catch {
		return false;
	}
}

export function modelLabel(m) {
	if (!m) return "";
	return `${m.provider || "默认"} · ${m.id || m.modelId || m.name || "未命名"}`;
}

export function readableError(e) {
	const text = String(e?.message || e || "").trim();
	return text.replace(/^Error invoking remote method '[^']+':\s*/, "").replace(/^Error:\s*/, "") || "操作失败";
}

export function init(ctx) {
	if (!ctx?.pi) return;
	if ((window.__piE2E && !window.__piE2EOnboarding) || onboardingDone(localStorage)) return;

	const style = document.createElement("style");
	style.textContent = CSS;
	document.head.append(style);

	const back = document.createElement("div");
	back.className = "onb-back";
	back.hidden = true;
	back.setAttribute("role", "dialog");
	back.setAttribute("aria-modal", "true");
	back.setAttribute("aria-label", "Myna 首次设置");

	const card = document.createElement("div");
	card.className = "onb";
	const head = document.createElement("div");
	head.className = "onb-head";
	const kicker = document.createElement("div");
	kicker.className = "onb-kicker";
	const title = document.createElement("div");
	title.className = "onb-title";
	const sub = document.createElement("div");
	sub.className = "onb-sub";
	head.append(kicker, title, sub);

	const body = document.createElement("div");
	body.className = "onb-body";
	const status = document.createElement("div");
	status.className = "onb-status";
	const actions = document.createElement("div");
	actions.className = "onb-actions";
	card.append(head, body, status, actions);
	back.append(card);
	document.body.append(back);

	let step = 0;
	let selected = null;
	let busy = false;
	let testTimer = 0;
	let finished = false;

	const setStatus = (text, err = false) => {
		status.textContent = text || "";
		status.classList.toggle("err", Boolean(err));
	};

	const finish = (skipped = false) => {
		if (finished) return;
		finished = true;
		try {
			localStorage.setItem(DONE_KEY, "1");
		} catch {}
		clearTimeout(testTimer);
		back.hidden = true;
		back.remove();
		if (!skipped) {
			ctx.input?.focus?.();
			ctx.follow?.();
		}
	};

	const btn = (label, primary, onClick, disabled = false) => {
		const b = document.createElement("button");
		b.type = "button";
		b.className = `onb-btn${primary ? " primary" : ""}`;
		b.textContent = label;
		b.disabled = disabled;
		b.onclick = onClick;
		return b;
	};

	const modelsNow = () => (Array.isArray(ctx.state?.models) ? ctx.state.models : []);

	const renderStep1 = () => {
		kicker.textContent = "1 / 3 · 工作区";
		title.textContent = "先选一个工作区";
		sub.textContent = "pi 的会话、文件和 git 操作都以这个目录为根。";
		body.replaceChildren();
		const path = document.createElement("div");
		path.className = "onb-path";
		path.textContent = ctx.state?.cwd || "尚未选择";
		body.append(path);
		actions.replaceChildren();
		actions.append(
			btn("跳过引导", false, () => finish(true)),
			btn("选择文件夹", false, async () => {
				if (busy) return;
				busy = true;
				const b = actions.querySelectorAll("button");
				b.forEach((x) => (x.disabled = true));
				setStatus("正在切换工作区…");
				try {
					await ctx.pickFolder?.();
					if (!ctx.state?.cwd) throw new Error("没有选择工作区");
					setStatus("");
					step = 1;
					renderStep2();
				} catch (e) {
					setStatus(readableError(e), true);
					b.forEach((x) => (x.disabled = false));
				} finally {
					busy = false;
				}
			}),
			btn("使用当前", true, () => {
				if (!ctx.state?.cwd) return setStatus("请选择一个工作区", true);
				step = 1;
				renderStep2();
			}),
		);
	};

	const renderStep2 = () => {
		kicker.textContent = "2 / 3 · 模型";
		title.textContent = "选一个模型";
		sub.textContent = "没有模型时，先去设置里添加 provider 和 API key。";
		body.replaceChildren();
		actions.replaceChildren();
		const models = modelsNow();
		const list = document.createElement("div");
		list.className = "onb-list";
		if (!models.length) {
			const empty = document.createElement("div");
			empty.className = "onb-path";
			empty.textContent = "还没有可用模型。";
			list.append(empty);
		} else {
			for (const m of models) {
				const b = document.createElement("button");
				b.type = "button";
				b.className = "onb-model";
				const prov = document.createElement("span");
				prov.className = "onb-model-prov";
				prov.textContent = m.provider || "默认";
				const id = document.createElement("span");
				id.className = "onb-model-id";
				id.textContent = m.id || m.modelId || m.name || "未命名";
				b.append(prov, id);
				b.onclick = async () => {
					if (busy) return;
					busy = true;
					setStatus(`切换到 ${modelLabel(m)}…`);
					try {
						await ctx.pi.command({ type: "set_model", provider: m.provider, modelId: m.id || m.modelId });
						selected = m;
						list.querySelectorAll(".onb-model").forEach((x) => x.classList.remove("on"));
						b.classList.add("on");
						setStatus("");
					} catch (e) {
						setStatus(readableError(e), true);
					} finally {
						busy = false;
					}
				};
				list.append(b);
			}
		}
		body.append(list);
		actions.append(
			btn("上一步", false, () => {
				step = 0;
				renderStep1();
			}),
			btn("打开设置", false, () => window.dispatchEvent(new CustomEvent("myna:open-settings", { detail: { pane: "providers" } }))),
			btn("重新检测", false, async () => {
				try {
					const d = await ctx.pi.command({ type: "get_available_models" });
					if (Array.isArray(d?.models)) ctx.state.models = d.models;
					renderStep2();
				} catch (e) {
					setStatus(readableError(e), true);
				}
			}),
			btn("下一步", true, () => {
				if (!modelsNow().length) return setStatus("先配置一个可用模型", true);
				if (!selected && ctx.state?.model) selected = ctx.state.model;
				if (!selected) {
					// 没手动点也行：用当前模型做测试
					selected = ctx.state?.model || modelsNow()[0];
				}
				step = 2;
				renderStep3();
			}),
		);
	};

	const renderStep3 = () => {
		kicker.textContent = "3 / 3 · 测试";
		title.textContent = "发一条测试消息";
		sub.textContent = "会真的调用一次模型，只发“只回复 ok”。失败时会显示可读原因。";
		body.replaceChildren();
		const path = document.createElement("div");
		path.className = "onb-path";
		path.textContent = selected ? modelLabel(selected) : ctx.state?.model ? modelLabel(ctx.state.model) : "当前模型";
		body.append(path);
		actions.replaceChildren();
		actions.append(
			btn("跳过测试", false, () => finish()),
			btn("上一步", false, () => {
				step = 1;
				renderStep2();
			}),
			btn("发送测试", true, async () => {
				if (busy) return;
				busy = true;
				actions.querySelectorAll("button").forEach((x) => (x.disabled = true));
				setStatus("已发送，等待模型回复…");
				let settled = false;
				const failTest = (message) => {
					if (settled) return;
					settled = true;
					clearTimeout(testTimer);
					setStatus(`测试失败：${message}`, true);
					actions.querySelectorAll("button").forEach((x) => (x.disabled = false));
					busy = false;
				};
				const off = ctx.pi.onEvent?.((ev) => {
					if (settled) return;
					if (ev?.type === "error") {
						failTest(ev.message || "未知错误");
					} else if (ev?.type === "process_exit") {
						failTest(readableError(ev.message || "pi 进程已停止"));
					} else if (ev?.type === "message_end" && ev.message?.role === "assistant" && ev.message.stopReason === "error") {
						failTest(ev.message.errorMessage || "模型返回错误");
					} else if (ev?.type === "agent_settled") {
						if (ev.aborted) failTest("测试被中断");
						else {
							settled = true;
							clearTimeout(testTimer);
							finish();
						}
					}
				});
				try {
					await ctx.pi.command({ type: "prompt", message: "只回复 ok" });
					clearTimeout(testTimer);
					testTimer = setTimeout(() => {
						if (settled) return;
						settled = true;
						setStatus("等待回复超时。检查模型/API key 后可以在对话里直接重试。", true);
						actions.querySelectorAll("button").forEach((x) => (x.disabled = false));
						busy = false;
					}, 60000);
				} catch (e) {
					clearTimeout(testTimer);
					settled = true;
					setStatus(readableError(e), true);
					actions.querySelectorAll("button").forEach((x) => (x.disabled = false));
					busy = false;
				}
				// onEvent 没有取消接口；用 settled 闩锁忽略迟到事件即可
				void off;
			}),
		);
	};

	back.addEventListener("click", (e) => {
		if (e.target === back) setStatus("完成或跳过引导后再关闭", true);
	});

	// 等 boot 完成再决定是否弹；已有模型/工作区也仍然展示一次，避免用户不知道下一步
	const show = () => {
		if (finished) return;
		back.hidden = false;
		renderStep1();
	};
	let tries = 0;
	const timer = setInterval(() => {
		tries += 1;
		if (window.__ready || tries > 40) {
			clearInterval(timer);
			if ((!window.__piE2E || window.__piE2EOnboarding) && !onboardingDone(localStorage)) show();
		}
	}, 250);
}
