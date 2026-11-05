// 附件 → pi RPC 载荷的纯函数：prompt 与 steer 共用，避免两条路径对图片格式处理不一致。
// 附件里 kind === "doc" 的是抽取后的纯文本，走正文；其余按图片处理。

export function splitAttachments(list) {
	const all = Array.isArray(list) ? list : [];
	return {
		docs: all.filter((it) => it && it.kind === "doc"),
		images: all.filter((it) => it && it.kind !== "doc" && typeof it?.data === "string" && it.data),
	};
}

// 文档文本拼在用户正文后面，和 app.js submit 原来的格式保持一致。
export function composeMessage(text, docs) {
	const body = String(text ?? "").trim();
	const parts = [body];
	for (const d of Array.isArray(docs) ? docs : []) {
		parts.push(`[${d?.name || "文档"}]\n${d?.text || ""}`);
	}
	return parts.filter(Boolean).join("\n\n");
}

// pi 只认 { type, data, mimeType }；url/name/w/h 是本地渲染用的，别塞进 RPC。
export function toRpcImages(images) {
	return (Array.isArray(images) ? images : [])
		.filter((it) => it && typeof it.data === "string" && it.data)
		.map((it) => ({ type: "image", data: it.data, mimeType: it.mimeType || "image/jpeg" }));
}
