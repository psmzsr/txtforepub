import JSZip from "jszip";
import { saveAs } from "file-saver";

// 用于识别常见章节标题（中文“第X章”或英文“chapter 1”）
const chapterHeadingPattern =
  /^\s*(第[0-9零一二三四五六七八九十百千万两]+[章节回卷部篇][^\n]*|chapter\s+\d+[^\n]*)\s*$/i;

// XML 转义，避免标题/正文里的特殊字符破坏 EPUB 的 XML 结构
function escapeXml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

// 把 Windows/Mac 的换行统一成 \n，并去掉首尾空白
function normalizeText(text) {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
}

// 方案 1：按章节标题切分
function splitByHeadings(text) {
  // 逐行处理，确保能识别单独占一行的章节标题
  const lines = text.split("\n");
  // 产出的章节数组
  const chapters = [];
  // 当前章节标题；若没识别到，后续会自动补默认标题
  let currentTitle = "";
  // 当前章节累积的正文行
  let currentLines = [];

  // 把“当前缓存章节”压入 chapters
  const pushCurrent = () => {
    const content = currentLines.join("\n").trim();
    // 空章节直接跳过，避免出现空白章
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
    // 遇到新的章节标题：先收尾上一章，再开始新章
    if (chapterHeadingPattern.test(line)) {
      pushCurrent();
      currentTitle = line;
      continue;
    }

    // 普通正文行继续放入当前章节
    currentLines.push(rawLine);
  }

  // 循环结束后，把最后一章收尾
  pushCurrent();
  return chapters;
}

// 方案 2：按字数切分（按段落累计，超过阈值就分章）
function splitByLength(text, maxChapterChars) {
  // 先按“空行”拆段，尽量保持段落完整
  const blocks = text
    .split(/\n{2,}/)
    .map((item) => item.trim())
    .filter(Boolean);

  // 无有效段落时直接返回空数组
  if (blocks.length === 0) {
    return [];
  }

  const chapters = [];
  // buffer：当前章节的段落列表
  let buffer = [];
  // size：当前章节累计字符数
  let size = 0;

  // 把 buffer 写入一个章节并清空缓存
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
    // 新段落会超阈值，且当前已有内容时，先切一章
    if (nextSize > maxChapterChars && buffer.length > 0) {
      pushBuffer();
    }
    // 把当前段落放进本章
    buffer.push(block);
    size += block.length;
  }

  // 收尾最后一章
  pushBuffer();
  return chapters;
}

// 根据用户配置选择切分策略
function splitChapters(text, mode, maxChapterChars) {
  if (mode === "chapter-markers") {
    return splitByHeadings(text);
  }

  if (mode === "fixed-length") {
    return splitByLength(text, maxChapterChars);
  }

  // auto 模式：先试章节标题；若识别结果太少（<=1），改用按字数切分兜底
  const autoChapters = splitByHeadings(text);
  if (autoChapters.length > 1) {
    return autoChapters;
  }
  return splitByLength(text, maxChapterChars);
}

// 把纯文本正文转成 XHTML 段落结构
function toParagraphHtml(text) {
  // 连续空行作为段落分隔
  const blocks = text
    .split(/\n{2,}/)
    .map((item) => item.trim())
    .filter(Boolean);

  return blocks
    .map((block) => {
      // 段内单换行转成 <br/>，保证阅读器中换行可见
      const withLineBreak = block
        .split("\n")
        .map((line) => escapeXml(line.trim()))
        .filter(Boolean)
        .join("<br/>");

      return `<p>${withLineBreak}</p>`;
    })
    .join("\n");
}

// 章节文件名采用 001、002 这种形式，便于排序稳定
function chapterFileName(index) {
  return `chapter-${String(index + 1).padStart(3, "0")}.xhtml`;
}

// 生成单章 XHTML 文件内容
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

// 生成 content.opf（EPUB 的核心清单与元数据）
function makeContentOpf(metadata, chapters) {
  // manifest: 列出包内资源文件
  const manifestItems = chapters
    .map((chapter, index) => {
      const href = chapterFileName(index);
      return `<item id="chapter-${index + 1}" href="${href}" media-type="application/xhtml+xml"/>`;
    })
    .join("\n    ");

  // spine: 定义阅读顺序
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

// 生成 toc.ncx（EPUB 2 目录文件）
function makeTocNcx(metadata, chapters) {
  // navMap 下每个 navPoint 对应一章
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

// 生成 META-INF/container.xml，告诉阅读器 OPF 在哪里
function makeContainerXml() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`;
}

// 生成电子书内部使用的默认样式
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

// 生成书籍唯一 ID（优先用 randomUUID，失败则退化到时间戳 + 随机数）
function makeBookId() {
  if (typeof crypto !== "undefined" && crypto.randomUUID) {
    return `urn:uuid:${crypto.randomUUID()}`;
  }

  const randomId = Math.random().toString(16).slice(2);
  return `urn:uuid:fallback-${Date.now()}-${randomId}`;
}

// 主入口：从 TXT 文本生成 EPUB 并触发下载
export async function createEpubFromTxt(options) {
  // 1) 清洗输入文本
  const sourceText = normalizeText(options.text || "");
  if (!sourceText) {
    throw new Error("TXT 内容为空，请先输入或上传内容。");
  }

  // 2) 按配置分章
  const maxChapterChars = Number(options.maxChapterChars) || 6000;
  const chapters = splitChapters(sourceText, options.splitMode, maxChapterChars);
  if (chapters.length === 0) {
    throw new Error("无法识别章节，请检查文本内容。");
  }

  // 3) 组装元数据
  const metadata = {
    id: makeBookId(),
    title: options.title || "未命名书籍",
    author: options.author || "佚名",
    language: options.language || "zh-CN",
    date: new Date().toISOString().slice(0, 10)
  };

  // 4) 创建 ZIP 容器并写入 EPUB 必需文件
  const zip = new JSZip();
  // mimetype 必须放根目录、且通常要求不压缩
  zip.file("mimetype", "application/epub+zip", {
    compression: "STORE"
  });
  // 容器声明 + 元数据清单 + 目录 + 内部样式
  zip.file("META-INF/container.xml", makeContainerXml());
  zip.file("OEBPS/content.opf", makeContentOpf(metadata, chapters));
  zip.file("OEBPS/toc.ncx", makeTocNcx(metadata, chapters));
  zip.file("OEBPS/styles.css", makeStyles());

  // 5) 写入每一章 XHTML
  chapters.forEach((chapter, index) => {
    zip.file(
      `OEBPS/${chapterFileName(index)}`,
      makeChapterXhtml(chapter, metadata.language)
    );
  });

  // 6) 生成最终 .epub（二进制 Blob）
  const epubBlob = await zip.generateAsync({
    type: "blob",
    mimeType: "application/epub+zip",
    compression: "DEFLATE"
  });

  // 7) 清洗文件名并触发浏览器下载
  const safeName = (metadata.title || "book")
    .replace(/[\\/:*?"<>|]/g, "_")
    .trim();
  saveAs(epubBlob, `${safeName || "book"}.epub`);

  // 8) 返回章节给上层界面做预览
  return {
    chapters
  };
}
