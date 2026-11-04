// 生成端到端用的文档样本（docx / pptx / xlsx / pdf），产物放 tests/fixtures。
// 只在内容变化时重跑：node scripts/make-fixtures.mjs
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const out = join(root, "tests", "fixtures");
mkdirSync(out, { recursive: true });

const { zipSync } = await import(
	"file:///" + join(root, "node_modules", "fflate", "esm", "browser.js").replace(/\\/g, "/")
);
const enc = (s) => new TextEncoder().encode(s);

// ---------- docx ----------
const docxXml =
	`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
	`<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>` +
	`<w:p><w:r><w:t>季度总结报告</w:t></w:r></w:p>` +
	`<w:p><w:r><w:t>营收同比增长 12.4%，主要来自企业客户。</w:t></w:r></w:p>` +
	`<w:tbl><w:tr><w:tc><w:p><w:r><w:t>指标</w:t></w:r></w:p></w:tc>` +
	`<w:tc><w:p><w:r><w:t>数值</w:t></w:r></w:p></w:tc></w:tr>` +
	`<w:tr><w:tc><w:p><w:r><w:t>毛利</w:t></w:r></w:p></w:tc>` +
	`<w:tc><w:p><w:r><w:t>63%</w:t></w:r></w:p></w:tc></w:tr></w:tbl>` +
	`<w:p><w:r><w:t>下一步：拓展东南亚市场。</w:t></w:r></w:p>` +
	`</w:body></w:document>`;
writeFileSync(
	join(out, "report.docx"),
	zipSync({
		"[Content_Types].xml": enc(`<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>`),
		"word/document.xml": enc(docxXml),
	}),
);

// ---------- pptx ----------
writeFileSync(
	join(out, "slides.pptx"),
	zipSync({
		"ppt/slides/slide1.xml": enc(`<p:sld xmlns:a="a"><a:t>产品路线图</a:t><a:t>2026 上半年</a:t></p:sld>`),
		"ppt/slides/slide2.xml": enc(`<p:sld xmlns:a="a"><a:t>第一阶段：稳定性</a:t><a:t>崩溃率降到 0.1%</a:t></p:sld>`),
		"ppt/slides/slide3.xml": enc(`<p:sld xmlns:a="a"><a:t>第二阶段：性能</a:t></p:sld>`),
	}),
);

// ---------- xlsx ----------
writeFileSync(
	join(out, "budget.xlsx"),
	zipSync({
		"xl/sharedStrings.xml": enc(
			`<sst><si><t>项目</t></si><si><t>预算</t></si><si><t>服务器</t></si><si><t>人力</t></si></sst>`,
		),
		"xl/worksheets/sheet1.xml": enc(
			`<worksheet><sheetData>` +
				`<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>` +
				`<row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2"><v>120000</v></c></row>` +
				`<row r="3"><c r="A3" t="s"><v>3</v></c><c r="B3"><v>450000</v></c></row>` +
				`</sheetData></worksheet>`,
		),
	}),
);

// ---------- pdf ----------
// 手写一个带正确 xref 的最小文本 PDF：不依赖任何生成库
function makePdf(lines) {
	const objs = [];
	const push = (body) => {
		objs.push(body);
		return objs.length; // 对象号从 1 开始
	};
	push("<< /Type /Catalog /Pages 2 0 R >>");
	push("<< /Type /Pages /Kids [3 0 R] /Count 1 >>");
	const content =
		"BT /F1 16 Tf 40 700 Td 20 TL\n" +
		lines.map((l) => `(${l.replace(/([()\\])/g, "\\$1")}) Tj T*`).join("\n") +
		"\nET";
	push("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>");
	push(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
	push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");

	let pdf = "%PDF-1.4\n";
	const offsets = [];
	objs.forEach((body, i) => {
		offsets.push(pdf.length);
		pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
	});
	const xrefAt = pdf.length;
	pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
	for (const off of offsets) pdf += `${String(off).padStart(10, "0")} 00000 n \n`;
	pdf += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`;
	return Buffer.from(pdf, "latin1");
}
writeFileSync(
	join(out, "notes.pdf"),
	makePdf([
		"Quarterly Report 2026",
		"Revenue grew 12.4 percent year over year.",
		"Next step: expand into Southeast Asia.",
	]),
);

console.log("fixtures written to", out);
