// 文档附件 → 纯文本。只抽文字：不保留排版、不处理扫描件、不做 OCR。
// 支持 pdf / docx / pptx / xlsx；后三者同为 ZIP+XML，共用一套 OOXML 抽取逻辑。

export const DOC_MAX_CHARS = 60000;
const MAX_PAGES = 300;

const EXTS = [".pdf", ".docx", ".pptx", ".xlsx"];

// node_modules 不在打包白名单的加压路径里，但 app:// 协议以 ROOT 为根，可以直接解析
const libUrl = (rel) => new URL(`../../node_modules/${rel}`, import.meta.url).href;

let pdfjsPromise = null;
function loadPdfjs() {
	if (!pdfjsPromise) {
		pdfjsPromise = import(libUrl("pdfjs-dist/build/pdf.mjs")).then((m) => {
			// worker 与主 bundle 同源（app://），CSP 的 'self' 已经覆盖
			m.GlobalWorkerOptions.workerSrc = libUrl("pdfjs-dist/build/pdf.worker.mjs");
			return m;
		});
	}
	return pdfjsPromise;
}

let fflatePromise = null;
function loadFflate() {
	if (!fflatePromise) fflatePromise = import(libUrl("fflate/esm/browser.js"));
	return fflatePromise;
}

export function docKind(name) {
	const n = String(name || "").toLowerCase();
	const dot = n.lastIndexOf(".");
	if (dot < 0) return null;
	const ext = n.slice(dot);
	return EXTS.includes(ext) ? ext.slice(1) : null;
}

export function isDocFile(file) {
	return Boolean(file) && docKind(file.name) !== null;
}

export function docAccept() {
	return EXTS.join(",");
}

function decodeXml(s) {
	return s.replace(/&(#x?[0-9a-fA-F]+|lt|gt|amp|quot|apos);/g, (m, g) => {
		switch (g) {
			case "lt":
				return "<";
			case "gt":
				return ">";
			case "amp":
				return "&";
			case "quot":
				return '"';
			case "apos":
				return "'";
			default: {
				const hex = g[1] === "x" || g[1] === "X";
				const code = parseInt(hex ? g.slice(2) : g.slice(1), hex ? 16 : 10);
				return Number.isFinite(code) ? String.fromCodePoint(code) : m;
			}
		}
	});
}

// 取一段 XML 里所有 <tag> 的文本，按 order 拼起来
function texts(xml, tag) {
	const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "g");
	const out = [];
	for (const m of xml.matchAll(re)) {
		// 嵌套标签先剥掉，只留文字
		const plain = m[1].replace(/<[^>]+>/g, "");
		if (plain) out.push(decodeXml(plain));
	}
	return out;
}

function zipText(zip, path) {
	const buf = zip[path];
	if (!buf) return "";
	return new TextDecoder("utf-8").decode(buf);
}

function docxText(zip) {
	const xml = zipText(zip, "word/document.xml");
	if (!xml) return "";
	const out = [];
	// 段落就是行；表格单元格在 OOXML 里也是 w:p，会自然各占一行
	for (const m of xml.matchAll(/<w:p(?:\s[^>]*)?>([\s\S]*?)<\/w:p>/g)) {
		const line = texts(m[1], "w:t").join("");
		out.push(line);
	}
	return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

function pptxText(zip) {
	const slides = Object.keys(zip)
		.filter((p) => /^ppt\/slides\/slide\d+\.xml$/.test(p))
		.sort((a, b) => {
			const na = Number(a.match(/(\d+)\.xml$/)?.[1] || 0);
			const nb = Number(b.match(/(\d+)\.xml$/)?.[1] || 0);
			return na - nb;
		});
	const out = [];
	slides.forEach((p, i) => {
		const xml = zipText(zip, p);
		const body = texts(xml, "a:t").join(" ").replace(/\s{2,}/g, " ").trim();
		out.push(`[Slide ${i + 1}]`);
		if (body) out.push(body);
		out.push("");
	});
	return out.join("\n").trim();
}

function xlsxText(zip) {
	// 共享字符串表：单元格 t="s" 时 <v> 是这里的下标
	const shared = [];
	const ss = zipText(zip, "xl/sharedStrings.xml");
	if (ss) {
		for (const m of ss.matchAll(/<si(?:\s[^>]*)?>([\s\S]*?)<\/si>/g)) {
			shared.push(texts(m[1], "t").join(""));
		}
	}
	const sheets = Object.keys(zip)
		.filter((p) => /^xl\/worksheets\/sheet\d+\.xml$/.test(p))
		.sort((a, b) => {
			const na = Number(a.match(/(\d+)\.xml$/)?.[1] || 0);
			const nb = Number(b.match(/(\d+)\.xml$/)?.[1] || 0);
			return na - nb;
		});
	const out = [];
	sheets.forEach((p, i) => {
		const xml = zipText(zip, p);
		if (!xml) return;
		const lines = [];
		for (const row of xml.matchAll(/<row(?:\s[^>]*)?>([\s\S]*?)<\/row>/g)) {
			const cells = [];
			for (const c of row[1].matchAll(/<c(\s[^>]*)?>([\s\S]*?)<\/c>/g)) {
				const attrs = c[1] || "";
				const body = c[2] || "";
				const t = attrs.match(/\st="([^"]+)"/)?.[1];
				const v = body.match(/<v(?:\s[^>]*)?>([\s\S]*?)<\/v>/)?.[1];
				if (t === "s" && v !== undefined) {
					cells.push(shared[Number(v)] ?? "");
				} else if (t === "inlineStr") {
					cells.push(texts(body, "t").join(""));
				} else if (v !== undefined) {
					cells.push(decodeXml(v));
				} else {
					cells.push("");
				}
			}
			if (cells.some((x) => x !== "")) lines.push(cells.join("\t"));
		}
		if (!lines.length) return;
		out.push(`[Sheet ${i + 1}]`, ...lines, "");
	});
	return out.join("\n").trim();
}

async function ooxmlText(buf, kind) {
	const { unzipSync } = await loadFflate();
	const zip = unzipSync(buf);
	if (kind === "docx") return docxText(zip);
	if (kind === "pptx") return pptxText(zip);
	if (kind === "xlsx") return xlsxText(zip);
	return "";
}

async function pdfText(buf) {
	const pdfjs = await loadPdfjs();
	const doc = await pdfjs.getDocument({
		data: buf,
		isEvalSupported: false,
		useWorkerFetch: false,
	}).promise;
	const pages = Math.min(doc.numPages, MAX_PAGES);
	const out = [];
	try {
		for (let i = 1; i <= pages; i++) {
			const page = await doc.getPage(i);
			const tc = await page.getTextContent();
			// 按 y 坐标分行：同一行的 item 共享 transform[5]
			const lines = new Map();
			for (const it of tc.items || []) {
				if (!it?.str) continue;
				const y = Math.round(it.transform?.[5] ?? 0);
				if (!lines.has(y)) lines.set(y, []);
				lines.get(y).push(it.str);
			}
			const body = [...lines.entries()]
				.sort((a, b) => b[0] - a[0])
				.map(([, parts]) => parts.join(" ").replace(/\s{2,}/g, " ").trim())
				.filter(Boolean)
				.join("\n");
			out.push(`[Page ${i}]`, body, "");
			page.cleanup?.();
		}
	} finally {
		await doc.destroy?.();
	}
	return out.join("\n").trim();
}

// 主入口：File → { name, kind, text, chars, truncated }
export async function extractDoc(file, { maxChars = DOC_MAX_CHARS } = {}) {
	const kind = docKind(file?.name);
	if (!kind) throw new Error("不支持的文档类型");
	if (!file.size) throw new Error("文件是空的");
	const buf = new Uint8Array(await file.arrayBuffer());
	let text = "";
	try {
		text = kind === "pdf" ? await pdfText(buf) : await ooxmlText(buf, kind);
	} catch (e) {
		throw new Error(`解析失败：${e?.message || e}`);
	}
	text = String(text || "").replace(/\u0000/g, "").trim();
	const truncated = text.length > maxChars;
	if (truncated) text = text.slice(0, maxChars);
	if (!text) throw new Error("没有抽到文字（可能是扫描件或空文档）");
	return { name: file.name, kind, text, chars: text.length, truncated };
}
