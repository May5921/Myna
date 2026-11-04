// 文档抽取单测：只验 OOXML 三种（pdf 需要 canvas/DOM，放在 e2e 里验）
import { test } from "node:test";
import assert from "node:assert/strict";
import { docKind, extractDoc, isDocFile, docAccept } from "../src/core/doc-extract.js";

const fflate = await import("file:///" + new URL("../node_modules/fflate/esm/browser.js", import.meta.url).pathname.replace(/^\//, ""));

const enc = (s) => new TextEncoder().encode(s);

function zipFile(files, name) {
	const zip = fflate.zipSync(files);
	return new File([zip], name);
}

const docx = () =>
	zipFile(
		{
			"[Content_Types].xml": enc(`<?xml version="1.0"?><Types/>`),
			"word/document.xml": enc(
				`<?xml version="1.0"?><w:document><w:body>` +
					`<w:p><w:r><w:t>第一段 &amp; 标题</w:t></w:r></w:p>` +
					`<w:p><w:r><w:t>第二段</w:t></w:r><w:r><w:t>续写</w:t></w:r></w:p>` +
					`<w:p/>` +
					`<w:tbl><w:tr><w:tc><w:p><w:r><w:t>单元格A</w:t></w:r></w:p></w:tc>` +
					`<w:tc><w:p><w:r><w:t>单元格B</w:t></w:r></w:p></w:tc></w:tr></w:tbl>` +
					`</w:body></w:document>`,
			),
		},
		"报告.docx",
	);

const pptx = () =>
	zipFile(
		{
			"ppt/slides/slide1.xml": enc(`<p:sld><a:t>封面标题</a:t><a:t>副标题</a:t></p:sld>`),
			"ppt/slides/slide10.xml": enc(`<p:sld><a:t>第十页</a:t></p:sld>`),
			"ppt/slides/slide2.xml": enc(`<p:sld><a:t>第二页要点</a:t></p:sld>`),
			"ppt/slides/_rels/slide1.xml.rels": enc(`<Relationships/>`),
		},
		"汇报.pptx",
	);

const xlsx = () =>
	zipFile(
		{
			"xl/sharedStrings.xml": enc(`<sst><si><t>姓名</t></si><si><t>年龄</t></si><si><t>张三</t></si></sst>`),
			"xl/worksheets/sheet1.xml": enc(
				`<worksheet><sheetData>` +
					`<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>` +
					`<row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2"><v>30</v></c></row>` +
					`<row r="3"><c r="A3" t="inlineStr"><is><t>内联</t></is></c></row>` +
					`</sheetData></worksheet>`,
			),
		},
		"表格.xlsx",
	);

test("docKind 按扩展名识别（大小写不敏感）", () => {
	assert.equal(docKind("a.PDF"), "pdf");
	assert.equal(docKind("b.DocX"), "docx");
	assert.equal(docKind("c.pptx"), "pptx");
	assert.equal(docKind("d.xlsx"), "xlsx");
	assert.equal(docKind("e.txt"), null);
	assert.equal(docKind("noext"), null);
	assert.equal(docKind(""), null);
});

test("isDocFile / docAccept", () => {
	assert.equal(isDocFile({ name: "x.pdf" }), true);
	assert.equal(isDocFile({ name: "x.txt" }), false);
	assert.equal(isDocFile(null), false);
	assert.equal(docAccept(), ".pdf,.docx,.pptx,.xlsx");
});

test("docx：段落成行、拼 run、解实体、表格单元格不丢", async () => {
	const r = await extractDoc(docx());
	assert.equal(r.kind, "docx");
	assert.equal(r.name, "报告.docx");
	assert.match(r.text, /第一段 & 标题/);
	assert.match(r.text, /第二段续写/);
	assert.match(r.text, /单元格A/);
	assert.match(r.text, /单元格B/);
	const lines = r.text.split("\n").filter(Boolean);
	assert.deepEqual(lines, ["第一段 & 标题", "第二段续写", "单元格A", "单元格B"]);
});

test("pptx：按 slide 数字序，不是字符串序", async () => {
	const r = await extractDoc(pptx());
	assert.equal(r.kind, "pptx");
	assert.match(r.text, /\[Slide 1\]/);
	assert.match(r.text, /封面标题/);
	const i2 = r.text.indexOf("第二页要点");
	const i10 = r.text.indexOf("第十页");
	assert.ok(i2 > -1 && i10 > -1);
	assert.ok(i2 < i10, "slide2 应排在 slide10 之前");
});

test("xlsx：共享字符串按索引还原，数字单元格保留", async () => {
	const r = await extractDoc(xlsx());
	assert.equal(r.kind, "xlsx");
	assert.match(r.text, /\[Sheet 1\]/);
	assert.match(r.text, /姓名\t年龄/);
	assert.match(r.text, /张三\t30/);
	assert.match(r.text, /内联/);
});

test("截断：超过 maxChars 时标记 truncated", async () => {
	const r = await extractDoc(docx(), { maxChars: 5 });
	assert.equal(r.truncated, true);
	assert.equal(r.chars, 5);
});

test("空文档报错而不是静默返回空串", async () => {
	const empty = zipFile({ "word/document.xml": enc(`<w:document><w:body><w:p/></w:body></w:document>`) }, "空.docx");
	await assert.rejects(() => extractDoc(empty), /没有抽到文字/);
});

test("坏文件报解析失败", async () => {
	const broken = new File([enc("not a zip")], "坏的.docx");
	await assert.rejects(() => extractDoc(broken), /解析失败/);
});

test("不支持的类型直接报错", async () => {
	const f = new File([enc("hi")], "a.txt");
	await assert.rejects(() => extractDoc(f), /不支持的文档类型/);
});
