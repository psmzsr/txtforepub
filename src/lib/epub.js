import JSZip from "jszip";
import { saveAs } from "file-saver";

const chapterHeadingPattern =
  /^\s*(第[0-9零一二三四五六七八九十百千万两]+[章节回卷部篇][^\n]*|chapter\s+\d+[^\n]*)\s*$/i;

const inlineImageTokenPattern = /^\[\[image:([a-z0-9-]+)\]\]$/i;

const supportedImageTypes = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/gif": ".gif",
  "image/webp": ".webp"
};

function escapeXml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function normalizeText(text) {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
}

function splitIntoBlocks(text) {
  return text
    .split(/\n{2,}/)
    .map((item) => item.trim())
    .filter(Boolean);
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
  const blocks = splitIntoBlocks(text);
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

function sanitizeStem(value, fallback) {
  const stem = String(value || "")
    .replace(/\.[^.]+$/, "")
    .replace(/[^a-zA-Z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();

  return stem || fallback;
}

function normalizeMediaType(mediaType, fileName) {
  const lowerType = String(mediaType || "").toLowerCase();
  if (supportedImageTypes[lowerType]) {
    return lowerType;
  }

  const extension = String(fileName || "")
    .split(".")
    .pop()
    ?.toLowerCase();

  if (extension === "jpg" || extension === "jpeg") {
    return "image/jpeg";
  }

  if (extension === "png") {
    return "image/png";
  }

  if (extension === "gif") {
    return "image/gif";
  }

  if (extension === "webp") {
    return "image/webp";
  }

  return "";
}

function normalizePlacement(placement) {
  const chapterIndex = Number(placement?.chapterIndex);
  const position = Number(placement?.position);

  if (!Number.isInteger(chapterIndex) || chapterIndex < 0) {
    return null;
  }

  if (!Number.isInteger(position) || position < 0) {
    return null;
  }

  return {
    chapterIndex,
    position
  };
}

function placementKey(chapterIndex, position) {
  return `${chapterIndex}:${position}`;
}

function buildBookImages(coverImage, inlineImages) {
  const coverMediaType = normalizeMediaType(coverImage?.mediaType, coverImage?.name || coverImage?.file?.name);
  const cover =
    coverImage?.file && coverMediaType
      ? {
          id: "cover-image",
          href: `images/cover${supportedImageTypes[coverMediaType]}`,
          file: coverImage.file,
          mediaType: coverMediaType,
          alt: coverImage.alt || "封面"
        }
      : null;

  const inline = (inlineImages || [])
    .map((image, index) => {
      const mediaType = normalizeMediaType(image?.mediaType, image?.name || image?.file?.name);
      if (!image?.file || !mediaType || !image?.id) {
        return null;
      }

      const safeStem = sanitizeStem(image.name || image.file.name, `image-${index + 1}`);

      return {
        id: image.id,
        href: `images/${String(index + 1).padStart(3, "0")}-${safeStem}${supportedImageTypes[mediaType]}`,
        file: image.file,
        mediaType,
        alt: image.alt || image.name || `插图 ${index + 1}`,
        placement: normalizePlacement(image.placement)
      };
    })
    .filter(Boolean);

  const placementsByPosition = new Map();
  const placedImageIds = new Set();

  inline.forEach((image) => {
    if (!image.placement) {
      return;
    }

    const key = placementKey(image.placement.chapterIndex, image.placement.position);
    const bucket = placementsByPosition.get(key) || [];
    bucket.push(image);
    placementsByPosition.set(key, bucket);
    placedImageIds.add(image.id);
  });

  return {
    cover,
    inline,
    inlineMap: new Map(inline.map((item) => [item.id, item])),
    placementsByPosition,
    placedImageIds
  };
}

function makeParagraph(block) {
  const withLineBreak = block
    .split("\n")
    .map((line) => escapeXml(line.trim()))
    .filter(Boolean)
    .join("<br/>");

  return `<p>${withLineBreak}</p>`;
}

function makeInlineFigure(image) {
  return `<figure class="illustration">
      <img src="${escapeXml(image.href)}" alt="${escapeXml(image.alt)}"/>
    </figure>`;
}

function renderBlock(block, inlineImageMap, placedImageIds) {
  const imageMatch = block.match(inlineImageTokenPattern);
  if (!imageMatch) {
    return makeParagraph(block);
  }

  const image = inlineImageMap.get(imageMatch[1]);
  if (!image) {
    return makeParagraph(block);
  }

  if (placedImageIds.has(image.id)) {
    return "";
  }

  return makeInlineFigure(image);
}

function renderPlacedImages(chapterIndex, position, bookImages) {
  const key = placementKey(chapterIndex, position);
  const images = bookImages.placementsByPosition.get(key) || [];

  return images.map((image) => makeInlineFigure(image));
}

function renderChapterBody(chapter, chapterIndex, bookImages) {
  const blocks = splitIntoBlocks(chapter.content);
  const output = [];

  for (let index = 0; index <= blocks.length; index += 1) {
    output.push(...renderPlacedImages(chapterIndex, index, bookImages));

    if (index < blocks.length) {
      const renderedBlock = renderBlock(blocks[index], bookImages.inlineMap, bookImages.placedImageIds);
      if (renderedBlock) {
        output.push(renderedBlock);
      }
    }
  }

  return output.join("\n");
}

function chapterFileName(index) {
  return `chapter-${String(index + 1).padStart(3, "0")}.xhtml`;
}

function makeChapterXhtml(chapter, chapterIndex, language, bookImages) {
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
    ${renderChapterBody(chapter, chapterIndex, bookImages)}
  </body>
</html>`;
}

function makeCoverXhtml(metadata, cover) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="${escapeXml(metadata.language)}" lang="${escapeXml(metadata.language)}">
  <head>
    <title>${escapeXml(metadata.title)}</title>
    <link rel="stylesheet" type="text/css" href="styles.css"/>
  </head>
  <body class="cover-page">
    <div class="cover-wrap">
      <img class="cover-image" src="${escapeXml(cover.href)}" alt="${escapeXml(cover.alt || metadata.title)}"/>
    </div>
  </body>
</html>`;
}

function makeContentOpf(metadata, chapters, bookImages) {
  const chapterManifestItems = chapters
    .map((chapter, index) => {
      const href = chapterFileName(index);
      return `<item id="chapter-${index + 1}" href="${href}" media-type="application/xhtml+xml"/>`;
    })
    .join("\n    ");

  const imageManifestItems = bookImages.inline
    .map(
      (image, index) =>
        `<item id="illustration-${index + 1}" href="${escapeXml(image.href)}" media-type="${escapeXml(image.mediaType)}"/>`
    )
    .join("\n    ");

  const coverManifestItems = bookImages.cover
    ? [
        `<item id="cover-image" href="${escapeXml(bookImages.cover.href)}" media-type="${escapeXml(bookImages.cover.mediaType)}"/>`,
        `<item id="cover-page" href="cover.xhtml" media-type="application/xhtml+xml"/>`
      ].join("\n    ")
    : "";

  const manifestItems = [chapterManifestItems, imageManifestItems, coverManifestItems].filter(Boolean).join("\n    ");

  const spineItems = [
    bookImages.cover ? `<itemref idref="cover-page"/>` : "",
    ...chapters.map((_, index) => `<itemref idref="chapter-${index + 1}"/>`)
  ]
    .filter(Boolean)
    .join("\n    ");

  const coverMeta = bookImages.cover ? `\n    <meta name="cover" content="cover-image"/>` : "";
  const guide = bookImages.cover
    ? `
  <guide>
    <reference href="cover.xhtml" title="Cover" type="cover"/>
  </guide>`
    : "";

  return `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" unique-identifier="book-id" version="2.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="book-id">${escapeXml(metadata.id)}</dc:identifier>
    <dc:title>${escapeXml(metadata.title)}</dc:title>
    <dc:creator>${escapeXml(metadata.author)}</dc:creator>
    <dc:language>${escapeXml(metadata.language)}</dc:language>
    <dc:date>${escapeXml(metadata.date)}</dc:date>${coverMeta}
  </metadata>
  <manifest>
    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
    <item id="css" href="styles.css" media-type="text/css"/>
    ${manifestItems}
  </manifest>
  <spine toc="ncx">
    ${spineItems}
  </spine>${guide}
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
  padding: 0 0.8em 1.2em;
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
}

img {
  max-width: 100%;
}

.illustration {
  margin: 1.4em auto;
  text-align: center;
}

.illustration img {
  display: block;
  margin: 0 auto;
}

.cover-page {
  margin: 0;
  padding: 0;
}

.cover-wrap {
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 1.4em;
}

.cover-image {
  max-height: 96vh;
  object-fit: contain;
}`;
}

function makeBookId() {
  if (typeof crypto !== "undefined" && crypto.randomUUID) {
    return `urn:uuid:${crypto.randomUUID()}`;
  }

  const randomId = Math.random().toString(16).slice(2);
  return `urn:uuid:fallback-${Date.now()}-${randomId}`;
}

export function analyzeTxtStructure(options = {}) {
  const sourceText = normalizeText(options.text || "");
  if (!sourceText) {
    return [];
  }

  const maxChapterChars = Number(options.maxChapterChars) || 6000;
  const chapters = splitChapters(sourceText, options.splitMode, maxChapterChars);

  return chapters.map((chapter, index) => ({
    index,
    title: chapter.title,
    content: chapter.content,
    blocks: splitIntoBlocks(chapter.content).map((block, blockIndex) => ({
      index: blockIndex,
      text: block
    }))
  }));
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
    author: options.author || "匿名作者",
    language: options.language || "zh-CN",
    date: new Date().toISOString().slice(0, 10)
  };

  const bookImages = buildBookImages(options.coverImage, options.inlineImages);

  const zip = new JSZip();
  zip.file("mimetype", "application/epub+zip", {
    compression: "STORE"
  });

  zip.file("META-INF/container.xml", makeContainerXml());
  zip.file("OEBPS/content.opf", makeContentOpf(metadata, chapters, bookImages));
  zip.file("OEBPS/toc.ncx", makeTocNcx(metadata, chapters));
  zip.file("OEBPS/styles.css", makeStyles());

  if (bookImages.cover) {
    zip.file(`OEBPS/${bookImages.cover.href}`, bookImages.cover.file);
    zip.file("OEBPS/cover.xhtml", makeCoverXhtml(metadata, bookImages.cover));
  }

  bookImages.inline.forEach((image) => {
    zip.file(`OEBPS/${image.href}`, image.file);
  });

  chapters.forEach((chapter, index) => {
    zip.file(`OEBPS/${chapterFileName(index)}`, makeChapterXhtml(chapter, index, metadata.language, bookImages));
  });

  const epubBlob = await zip.generateAsync({
    type: "blob",
    mimeType: "application/epub+zip",
    compression: "DEFLATE"
  });

  const safeName = (metadata.title || "book").replace(/[\\/:*?"<>|]/g, "_").trim();
  saveAs(epubBlob, `${safeName || "book"}.epub`);

  return {
    chapters,
    coverIncluded: Boolean(bookImages.cover),
    inlineImageCount: bookImages.inline.length
  };
}
