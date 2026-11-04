// 从 pi 消息 content 里提取图片块，兼容 {data,mimeType} 与 content-block source 形态。
export function imagesFromContent(content) {
	if (!Array.isArray(content)) return [];
	const out = [];
	for (const block of content) {
		if (block?.type !== "image") continue;
		const data = block.data || block.source?.data;
		if (!data) continue;
		const mime =
			block.mimeType ||
			block.mime_type ||
			block.source?.media_type ||
			block.source?.mimeType ||
			"image/png";
		// data 可能已经是完整 data URL（不同来源写法不一），再拼前缀会得到无效 src
		const raw = String(data);
		const url = raw.startsWith("data:") ? raw : `data:${mime};base64,${raw}`;
		out.push({ url, name: "图片" });
	}
	return out;
}
