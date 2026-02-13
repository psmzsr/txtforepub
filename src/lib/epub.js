import JSZip from "jszip";
import { saveAs } from "file-saver";

const chapterHeadingPattern =
  /^\s*(第[0-9零一二三四五六七八九十百千万两]+[章节回卷部篇][^\n]*|chapter\s+\d+[^\n]*)\s*$/i;

function escapeXml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function normalizeText(text) {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
}

function splitByHeadings(text) {
  const lines = text.split("\n");
  const chapters = [];
  let currentTitle = "";
  let currentLines = [];

  const pushCurrent = () => {
    const content = currentLines.join("\n").trim();
    if (!content) {
      currentLines = [];
      return;
    }

    chapters.push({
      title: currentTitle || `第 ${chapters.length + 1} 章`,
      content
    });
    currentLines = [];
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (chapterHeadingPattern.test(line)) {
      pushCurrent();
      currentTitle = line;
      continue;
    }

    currentLines.push(rawLine);
  }

  pushCurrent();
  return chapters;
}

function splitByLength(text, maxChapterChars) {
  const blocks = text
    .split(/\n{2,}/)
    .map((item) => item.trim())
    .filter(Boolean);

  if (blocks.length === 0) {
    return [];
  }

  const chapters = [];
  let buffer = [];
  let size = 0;

  const pushBuffer = () => {
    const content = buffer.join("\n\n").trim();
    if (!content) {
      return;
    }

    chapters.push({
      title: `第 ${chapters.length + 1} 章`,
      content
    });
    buffer = [];
    size = 0;
  };

  for (const block of blocks) {
    const nextSize = size + block.length;
    if (nextSize > maxChapterChars && buffer.length > 0) {
      pushBuffer();
    }
    buffer.push(block);
    size += block.length;
  }

  pushBuffer();
  return chapters;
}

function splitChapters(text, mode, maxChapterChars) {
  if (mode === "chapter-markers") {
    return splitByHeadings(text);
  }

  if (mode === "fixed-length") {
    return splitByLength(text, maxChapterChars);
  }

  const autoChapters = splitByHeadings(text);
  if (autoChapters.length > 1) {
    return autoChapters;
  }
  return splitByLength(text, maxChapterChars);
}

function toParagraphHtml(text) {
  const blocks = text
    .split(/\n{2,}/)
    .map((item) => item.trim())
    .filter(Boolean);

  return blocks
    .map((block) => {
      const withLineBreak = block
        .split("\n")
        .map((line) => escapeXml(line.trim()))
        .filter(Boolean)
        .join("<br/>");

      return `<p>${withLineBreak}</p>`;
    })
    .join("\n");
}

function chapterFileName(index) {
  return `chapter-${String(index + 1).padStart(3, "0")}.xhtml`;
}

function makeChapterXhtml(chapter, language) {
  const title = escapeXml(chapter.title);
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="${escapeXml(language)}" lang="${escapeXml(language)}">
  <head>
    <title>${title}</title>
    <link rel="stylesheet" type="text/css" href="styles.css"/>
  </head>
  <body>
    <h1>${title}</h1>
    ${toParagraphHtml(chapter.content)}
  </body>
</html>`;
}

function makeContentOpf(metadata, chapters) {
  const manifestItems = chapters
    .map((chapter, index) => {
      const href = chapterFileName(index);
      return `<item id="chapter-${index + 1}" href="${href}" media-type="application/xhtml+xml"/>`;
    })
    .join("\n    ");

  const spineItems = chapters
    .map((_, index) => `<itemref idref="chapter-${index + 1}"/>`)
    .join("\n    ");

  return `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" unique-identifier="book-id" version="2.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="book-id">${escapeXml(metadata.id)}</dc:identifier>
    <dc:title>${escapeXml(metadata.title)}</dc:title>
    <dc:creator>${escapeXml(metadata.author)}</dc:creator>
    <dc:language>${escapeXml(metadata.language)}</dc:language>
    <dc:date>${escapeXml(metadata.date)}</dc:date>
  </metadata>
  <manifest>
    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
    <item id="css" href="styles.css" media-type="text/css"/>
    ${manifestItems}
  </manifest>
  <spine toc="ncx">
    ${spineItems}
  </spine>
</package>`;
}

function makeTocNcx(metadata, chapters) {
  const navPoints = chapters
    .map((chapter, index) => {
      const playOrder = index + 1;
      return `<navPoint id="nav-point-${playOrder}" playOrder="${playOrder}">
      <navLabel><text>${escapeXml(chapter.title)}</text></navLabel>
      <content src="${chapterFileName(index)}"/>
    </navPoint>`;
    })
    .join("\n    ");

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE ncx PUBLIC "-//NISO//DTD ncx 2005-1//EN"
  "http://www.daisy.org/z3986/2005/ncx-2005-1.dtd">
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <head>
    <meta name="dtb:uid" content="${escapeXml(metadata.id)}"/>
    <meta name="dtb:depth" content="1"/>
    <meta name="dtb:totalPageCount" content="0"/>
    <meta name="dtb:maxPageNumber" content="0"/>
  </head>
  <docTitle>
    <text>${escapeXml(metadata.title)}</text>
  </docTitle>
  <navMap>
    ${navPoints}
  </navMap>
</ncx>`;
}

function makeContainerXml() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`;
}

function makeStyles() {
  return `body {
  font-family: "Noto Serif SC", "Source Han Serif SC", serif;
  margin: 0;
  padding: 0 0.8em;
  line-height: 1.7;
  text-align: justify;
}

h1 {
  font-size: 1.4em;
  margin: 1.2em 0 1em 0;
  text-align: center;
}

p {
  text-indent: 2em;
  margin: 0 0 0.8em 0;
}`;
}

function makeBookId() {
  if (typeof crypto !== "undefined" && crypto.randomUUID) {
    return `urn:uuid:${crypto.randomUUID()}`;
  }

  const randomId = Math.random().toString(16).slice(2);
  return `urn:uuid:fallback-${Date.now()}-${randomId}`;
}

export async function createEpubFromTxt(options) {
  const sourceText = normalizeText(options.text || "");
  if (!sourceText) {
    throw new Error("TXT 内容为空，请先输入或上传内容。");
  }

  const maxChapterChars = Number(options.maxChapterChars) || 6000;
  const chapters = splitChapters(sourceText, options.splitMode, maxChapterChars);
  if (chapters.length === 0) {
    throw new Error("无法识别章节，请检查文本内容。");
  }

  const metadata = {
    id: makeBookId(),
    title: options.title || "未命名书籍",
    author: options.author || "佚名",
    language: options.language || "zh-CN",
    date: new Date().toISOString().slice(0, 10)
  };

  const zip = new JSZip();
  zip.file("mimetype", "application/epub+zip", {
    compression: "STORE"
  });
  zip.file("META-INF/container.xml", makeContainerXml());
  zip.file("OEBPS/content.opf", makeContentOpf(metadata, chapters));
  zip.file("OEBPS/toc.ncx", makeTocNcx(metadata, chapters));
  zip.file("OEBPS/styles.css", makeStyles());

  chapters.forEach((chapter, index) => {
    zip.file(
      `OEBPS/${chapterFileName(index)}`,
      makeChapterXhtml(chapter, metadata.language)
    );
  });

  const epubBlob = await zip.generateAsync({
    type: "blob",
    mimeType: "application/epub+zip",
    compression: "DEFLATE"
  });

  const safeName = (metadata.title || "book")
    .replace(/[\\/:*?"<>|]/g, "_")
    .trim();
  saveAs(epubBlob, `${safeName || "book"}.epub`);

  return {
    chapters
  };
}
