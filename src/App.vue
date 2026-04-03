<script setup>
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { analyzeTxtStructure, createEpubFromTxt } from "./lib/epub";

const form = ref({
  title: "我的 TXT 电子书",
  author: "匿名作者",
  language: "zh-CN",
  splitMode: "auto",
  maxChapterChars: 6000
});

const txtContent = ref("");
const sourceFileName = ref("");
const chapterPreview = ref([]);
const isConverting = ref(false);
const message = ref("准备就绪：先上传 TXT 或直接粘贴内容。");
const errorMessage = ref("");
const coverImage = ref(null);
const inlineImages = ref([]);
const nextInlineImageId = ref(1);
const textAreaRef = ref(null);
const expandedInlineImageId = ref(null);

const canConvert = computed(() => txtContent.value.trim().length > 0 && !isConverting.value);
const chapterStructure = computed(() =>
  analyzeTxtStructure({
    text: txtContent.value,
    splitMode: form.value.splitMode,
    maxChapterChars: form.value.maxChapterChars
  })
);
const chapterOptions = computed(() =>
  chapterStructure.value.map((chapter) => ({
    value: chapter.index,
    label: `${chapter.title} · ${chapter.blocks.length} 段`
  }))
);
const arrangedInlineCount = computed(() => inlineImages.value.filter(hasPlacement).length);
const positionedInlineImages = computed(() =>
  [...inlineImages.value]
    .map((image) => ({
      ...image,
      context: getPlacementContext(image)
    }))
    .filter((image) => image.context)
    .sort(
      (left, right) =>
        left.context.chapterIndex - right.context.chapterIndex ||
        left.context.position - right.context.position ||
        left.name.localeCompare(right.name, "zh-CN")
    )
);
const inlineImageTip = computed(() => {
  if (inlineImages.value.length === 0) {
    return "上传正文插图后，直接为图片选择章节和段落位置。";
  }

  if (chapterStructure.value.length === 0) {
    return "先输入正文并识别出章节，才能为插图定位。";
  }

  return `当前已上传 ${inlineImages.value.length} 张正文插图，已定位 ${arrangedInlineCount.value} 张。`;
});

function fileBaseName(fileName) {
  return fileName.replace(/\.[^.]+$/, "") || "未命名图片";
}

function createInlineToken(id) {
  return `[[image:${id}]]`;
}

function summarizeText(text, maxLength = 24) {
  const singleLine = String(text || "").replace(/\s+/g, " ").trim();
  if (!singleLine) {
    return "空段落";
  }

  return singleLine.length > maxLength ? `${singleLine.slice(0, maxLength)}...` : singleLine;
}

function summarizePreviewText(text, fallback, maxLength = 88) {
  const singleLine = String(text || "").replace(/\s+/g, " ").trim();
  if (!singleLine) {
    return fallback;
  }

  return singleLine.length > maxLength ? `${singleLine.slice(0, maxLength)}...` : singleLine;
}

function guessImageMediaType(file) {
  if (file?.type?.startsWith("image/")) {
    return file.type.toLowerCase();
  }

  const extension = file?.name?.split(".").pop()?.toLowerCase();

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

function isSupportedImage(file) {
  return Boolean(guessImageMediaType(file));
}

function makeImageRecord(file, id, source = "upload") {
  return {
    id,
    token: createInlineToken(id),
    name: file.name,
    alt: fileBaseName(file.name),
    file,
    mediaType: guessImageMediaType(file),
    previewUrl: URL.createObjectURL(file),
    placement: null,
    source
  };
}

function setExpandedInlineImage(imageId) {
  expandedInlineImageId.value = imageId;
}

function isInlineImageExpanded(imageId) {
  return expandedInlineImageId.value === imageId;
}

function toggleInlineImageExpanded(imageId) {
  expandedInlineImageId.value = expandedInlineImageId.value === imageId ? null : imageId;
}

function revokePreview(item) {
  if (item?.previewUrl) {
    URL.revokeObjectURL(item.previewUrl);
  }
}

function normalizeTextSpacing(value) {
  return value.replace(/\n{3,}/g, "\n\n").replace(/^\n+|\n+$/g, "");
}

function removeInlineTokenFromText(token) {
  const escapedToken = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const blockPattern = new RegExp(`(?:\\n{2,}|^)${escapedToken}(?=\\n{2,}|$)`, "g");

  txtContent.value = normalizeTextSpacing(txtContent.value.replace(blockPattern, ""));
}

function isTokenInText(token) {
  return txtContent.value.includes(token);
}

function insertInlineTokensAtCursor(tokens) {
  if (!tokens || tokens.length === 0) {
    return;
  }

  const textArea = textAreaRef.value;
  const currentText = txtContent.value;
  const insertedText = tokens.join("\n\n");

  if (!textArea) {
    txtContent.value = normalizeTextSpacing(`${currentText}\n\n${insertedText}\n\n`);
    return;
  }

  const start = textArea.selectionStart ?? currentText.length;
  const end = textArea.selectionEnd ?? start;
  const before = currentText.slice(0, start);
  const after = currentText.slice(end);
  const leading = before.length > 0 && !before.endsWith("\n\n") ? (before.endsWith("\n") ? "\n" : "\n\n") : "";
  const trailing = after.length > 0 && !after.startsWith("\n\n") ? (after.startsWith("\n") ? "\n" : "\n\n") : "";
  const nextText = `${before}${leading}${insertedText}${trailing}${after}`;

  txtContent.value = nextText;

  requestAnimationFrame(() => {
    if (!textAreaRef.value) {
      return;
    }

    const cursor = (before + leading + insertedText).length;
    textAreaRef.value.focus();
    textAreaRef.value.setSelectionRange(cursor, cursor);
  });
}

function appendInlineImages(files, source = "upload") {
  const validFiles = files.filter(isSupportedImage);
  const ignoredCount = files.length - validFiles.length;

  if (validFiles.length === 0) {
    return {
      appendedImages: [],
      ignoredCount
    };
  }

  const appendedImages = validFiles.map((file) => {
    const id = `image-${nextInlineImageId.value++}`;
    return makeImageRecord(file, id, source);
  });

  inlineImages.value = [...inlineImages.value, ...appendedImages];
  if (appendedImages.length > 0) {
    setExpandedInlineImage(appendedImages[appendedImages.length - 1].id);
  }

  return {
    appendedImages,
    ignoredCount
  };
}

function hasPlacement(image) {
  const chapterIndex = Number(image?.placement?.chapterIndex);
  const position = Number(image?.placement?.position);

  return Number.isInteger(chapterIndex) && chapterIndex >= 0 && Number.isInteger(position) && position >= 0;
}

function normalizeInlineImagePlacement(image) {
  if (!hasPlacement(image)) {
    image.placement = null;
    return;
  }

  const chapter = chapterStructure.value[image.placement.chapterIndex];
  if (!chapter) {
    image.placement = null;
    return;
  }

  const safePosition = Math.min(Math.max(Number(image.placement.position) || 0, 0), chapter.blocks.length);

  image.placement = {
    chapterIndex: image.placement.chapterIndex,
    position: safePosition
  };
}

function getPositionOptions(image) {
  if (!hasPlacement(image)) {
    return [];
  }

  const chapter = chapterStructure.value[image.placement.chapterIndex];
  if (!chapter) {
    return [];
  }

  return [
    {
      value: 0,
      label: "章首"
    },
    ...chapter.blocks.map((block, index) => ({
      value: index + 1,
      label: `第 ${index + 1} 段后 · ${summarizeText(block.text, 20)}`
    }))
  ];
}

function describePlacement(image) {
  const context = getPlacementContext(image);
  if (!context) {
    return "未设置插图位置。";
  }
  if (context.mode === "token") {
    return `这张图片已按正文中的粘贴位置插入《${context.chapterTitle}》。`;
  }

  if (context.position === 0) {
    return `将出现在《${context.chapterTitle}》开头。`;
  }

  return `将出现在《${context.chapterTitle}》第 ${context.position} 段后：${summarizeText(context.anchorText, 26)}`;
}

function getPlacementContext(image) {
  if (hasPlacement(image)) {
    const chapter = chapterStructure.value[image.placement.chapterIndex];
    if (!chapter) {
      return null;
    }

    const position = image.placement.position;
    const previousBlock = position > 0 ? chapter.blocks[position - 1] : null;
    const nextBlock = chapter.blocks[position] || null;

    return {
      chapterIndex: image.placement.chapterIndex,
      chapterTitle: chapter.title,
      position,
      positionLabel: position === 0 ? "章首" : `第 ${position} 段后`,
      previousText: summarizePreviewText(previousBlock?.text, "这是章节开头，图片会在正文之前出现。"),
      nextText: summarizePreviewText(nextBlock?.text, "这是章节结尾，图片后面没有更多正文。"),
      anchorText: previousBlock?.text || "",
      mode: "panel"
    };
  }

  if (!isTokenInText(image.token)) {
    return null;
  }

  for (const chapter of chapterStructure.value) {
    const tokenIndex = chapter.blocks.findIndex((block) => block.text.trim() === image.token);
    if (tokenIndex === -1) {
      continue;
    }

    const previousBlock = tokenIndex > 0 ? chapter.blocks[tokenIndex - 1] : null;
    const nextBlock = chapter.blocks[tokenIndex + 1] || null;

    return {
      chapterIndex: chapter.index,
      chapterTitle: chapter.title,
      position: tokenIndex,
      positionLabel: tokenIndex === 0 ? "正文锚点 · 章首" : `正文锚点 · 第 ${tokenIndex} 段后`,
      previousText: summarizePreviewText(previousBlock?.text, "这是章节开头，图片会在正文之前出现。"),
      nextText: summarizePreviewText(nextBlock?.text, "这是章节结尾，图片后面没有更多正文。"),
      anchorText: previousBlock?.text || "",
      mode: "token"
    };
  }

  return null;
}

function clearInlinePlacement(image) {
  image.placement = null;
  message.value = `已清空插图位置：${image.name}`;
}

function onInlineImageChapterChange(image, rawValue) {
  if (rawValue === "") {
    clearInlinePlacement(image);
    return;
  }

  const chapterIndex = Number(rawValue);
  const chapter = chapterStructure.value[chapterIndex];
  if (!chapter) {
    clearInlinePlacement(image);
    return;
  }

  image.placement = {
    chapterIndex,
    position: Math.min(Number(image.placement?.position) || 0, chapter.blocks.length)
  };
  removeInlineTokenFromText(image.token);
  message.value = `已设置插图章节：${image.name}`;
  errorMessage.value = "";
}

function onInlineImagePositionChange(image, rawValue) {
  if (!hasPlacement(image)) {
    return;
  }

  const chapter = chapterStructure.value[image.placement.chapterIndex];
  if (!chapter) {
    clearInlinePlacement(image);
    return;
  }

  image.placement = {
    chapterIndex: image.placement.chapterIndex,
    position: Math.min(Math.max(Number(rawValue) || 0, 0), chapter.blocks.length)
  };
  removeInlineTokenFromText(image.token);
  message.value = `已更新插图位置：${image.name}`;
  errorMessage.value = "";
}

async function onSelectFile(event) {
  const [file] = event.target.files || [];
  if (!file) {
    return;
  }

  sourceFileName.value = file.name;
  txtContent.value = await file.text();
  message.value = `已加载文件：${file.name}`;
  errorMessage.value = "";
  event.target.value = "";
}

function onSelectCover(event) {
  const [file] = event.target.files || [];
  if (!file) {
    return;
  }

  if (!isSupportedImage(file)) {
    errorMessage.value = "封面必须是 JPG、PNG、GIF 或 WEBP 图片。";
    event.target.value = "";
    return;
  }

  if (coverImage.value) {
    revokePreview(coverImage.value);
  }

  coverImage.value = {
    ...makeImageRecord(file, "cover"),
    alt: `${form.value.title || "电子书"} 封面`
  };
  message.value = `已添加封面：${file.name}`;
  errorMessage.value = "";
  event.target.value = "";
}

function clearCoverImage() {
  if (!coverImage.value) {
    return;
  }

  const removedName = coverImage.value.name;
  revokePreview(coverImage.value);
  coverImage.value = null;
  message.value = `已移除封面：${removedName}`;
}

function onSelectInlineImages(event) {
  const files = Array.from(event.target.files || []);
  if (files.length === 0) {
    return;
  }

  const { appendedImages, ignoredCount } = appendInlineImages(files, "upload");
  if (appendedImages.length === 0) {
    errorMessage.value = "没有可用的图片文件，请选择 JPG、PNG、GIF 或 WEBP。";
    event.target.value = "";
    return;
  }

  message.value = `已添加 ${appendedImages.length} 张正文插图。`;
  errorMessage.value = ignoredCount > 0 ? `已忽略 ${ignoredCount} 个非图片文件。` : "";
  event.target.value = "";
}

function onPasteTextImages(event) {
  const clipboardItems = Array.from(event.clipboardData?.items || []);
  const files = clipboardItems
    .filter((item) => item.kind === "file")
    .map((item) => item.getAsFile())
    .filter(Boolean);

  if (files.length === 0) {
    return;
  }

  const { appendedImages, ignoredCount } = appendInlineImages(files, "paste");
  if (appendedImages.length === 0) {
    return;
  }

  event.preventDefault();
  insertInlineTokensAtCursor(appendedImages.map((item) => item.token));
  message.value = `已从剪贴板插入 ${appendedImages.length} 张图片到正文当前位置。`;
  errorMessage.value = ignoredCount > 0 ? `已忽略 ${ignoredCount} 个非图片内容。` : "";
}

function clearInlineImage(imageId) {
  const target = inlineImages.value.find((item) => item.id === imageId);
  if (!target) {
    return;
  }

  revokePreview(target);
  inlineImages.value = inlineImages.value.filter((item) => item.id !== imageId);
  removeInlineTokenFromText(target.token);
  if (expandedInlineImageId.value === imageId) {
    expandedInlineImageId.value = inlineImages.value[0]?.id || null;
  }
  message.value = `已移除插图：${target.name}`;
}

async function onConvert() {
  if (!canConvert.value) {
    return;
  }

  isConverting.value = true;
  errorMessage.value = "";
  message.value = "正在生成 EPUB...";

  try {
    const result = await createEpubFromTxt({
      ...form.value,
      text: txtContent.value,
      coverImage: coverImage.value
        ? {
            name: coverImage.value.name,
            file: coverImage.value.file,
            mediaType: coverImage.value.mediaType,
            alt: coverImage.value.alt
          }
        : null,
      inlineImages: inlineImages.value.map((item) => ({
        id: item.id,
        name: item.name,
        alt: item.alt,
        file: item.file,
        mediaType: item.mediaType,
        placement: item.placement
      }))
    });

    chapterPreview.value = result.chapters.slice(0, 10);

    const assetSummary = [
      result.coverIncluded ? "已写入封面" : "未添加封面",
      `正文插图已定位 ${arrangedInlineCount.value}/${inlineImages.value.length} 张`
    ].join("，");

    message.value = `转换成功，已下载 EPUB（共 ${result.chapters.length} 章，${assetSummary}）。`;
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : "转换失败，请重试。";
    message.value = "转换失败";
  } finally {
    isConverting.value = false;
  }
}

watch(chapterStructure, () => {
  inlineImages.value.forEach((image) => {
    normalizeInlineImagePlacement(image);
  });
});

onBeforeUnmount(() => {
  if (coverImage.value) {
    revokePreview(coverImage.value);
  }

  inlineImages.value.forEach(revokePreview);
});
</script>

<template>
  <main class="page">
    <section class="card">
      <h1>TXT 转 EPUB</h1>
      <p class="zb">工欲善其事必先利其器</p>

      <div class="grid two-cols">
        <label>
          书名
          <input v-model.trim="form.title" type="text" placeholder="请输入书名" />
        </label>
        <label>
          作者
          <input v-model.trim="form.author" type="text" placeholder="请输入作者" />
        </label>
      </div>

      <div class="grid two-cols">
        <label>
          语言
          <select v-model="form.language">
            <option value="zh-CN">中文（简体）</option>
            <option value="zh-TW">中文（繁体）</option>
            <option value="en">English</option>
          </select>
        </label>
        <label>
          分章方式
          <select v-model="form.splitMode">
            <option value="auto">自动（优先识别“第X章”）</option>
            <option value="chapter-markers">只按章节标题</option>
            <option value="fixed-length">按字数切分</option>
          </select>
        </label>
      </div>

      <label>
        每章最大字数（按字数切分时生效）
        <input
          v-model.number="form.maxChapterChars"
          min="1000"
          step="500"
          type="number"
          placeholder="如 6000"
        />
      </label>

      <div class="grid two-cols file-row">
        <label>
          上传 TXT 文件
          <input accept=".txt,text/plain" type="file" @change="onSelectFile" />
        </label>
        <div class="file-name">
          <span>当前文件：</span>
          <strong>{{ sourceFileName || "未选择文件" }}</strong>
        </div>
      </div>

      <div class="asset-section">
        <div class="asset-header">
          <h2>封面与插图</h2>
          <p class="sub">封面会写入 EPUB 封面页；正文插图现在可以直接按章节和段落定位。</p>
        </div>

        <div class="grid two-cols asset-grid">
          <div class="asset-card">
            <label>
              上传封面
              <input accept="image/*" type="file" @change="onSelectCover" />
            </label>

            <div v-if="coverImage" class="cover-preview">
              <img :src="coverImage.previewUrl" :alt="coverImage.alt" />
              <div class="asset-meta">
                <strong>{{ coverImage.name }}</strong>
                <span>导出时作为电子书封面</span>
              </div>
              <button class="ghost-btn" type="button" @click="clearCoverImage">移除封面</button>
            </div>

            <p v-else class="sub small">支持 JPG、PNG、GIF、WEBP。</p>
          </div>

          <div class="asset-card">
            <label>
              上传正文插图
              <input accept="image/*" multiple type="file" @change="onSelectInlineImages" />
            </label>
            <p class="sub small">{{ inlineImageTip }}</p>

            <ul v-if="inlineImages.length > 0" class="asset-list">
              <li v-for="image in inlineImages" :key="image.id">
                <img class="asset-thumb" :src="image.previewUrl" :alt="image.alt" />
                <div class="asset-body">
                  <div class="asset-item-head">
                    <div class="asset-item-meta">
                      <strong>{{ image.name }}</strong>
                      <div class="placement-preview-header">
                        <span class="preview-chip">{{ image.source === "paste" ? "正文粘贴" : "手动上传" }}</span>
                        <span v-if="isTokenInText(image.token) && !hasPlacement(image)" class="preview-chip soft">
                          光标位置锚点
                        </span>
                        <span v-else-if="hasPlacement(image)" class="preview-chip soft">面板定位</span>
                        <span v-else class="preview-chip soft">未定位</span>
                      </div>
                      <p class="placement-hint compact">{{ describePlacement(image) }}</p>
                    </div>

                    <button class="ghost-btn inline-toggle-btn" type="button" @click="toggleInlineImageExpanded(image.id)">
                      {{ isInlineImageExpanded(image.id) ? "收起" : "展开" }}
                    </button>
                  </div>

                  <div v-if="isInlineImageExpanded(image.id)" class="asset-item-details">
                    <label class="mini-label">
                      图片说明
                      <input v-model.trim="image.alt" type="text" placeholder="用于 EPUB 中的图片说明" />
                    </label>

                    <div class="placement-grid">
                      <label class="mini-label">
                        所在章节
                        <select
                          :value="hasPlacement(image) ? image.placement.chapterIndex : ''"
                          @change="onInlineImageChapterChange(image, $event.target.value)"
                        >
                          <option value="">未放置</option>
                          <option v-for="chapter in chapterOptions" :key="chapter.value" :value="chapter.value">
                            {{ chapter.label }}
                          </option>
                        </select>
                      </label>

                      <label class="mini-label">
                        插图位置
                        <select
                          :disabled="!hasPlacement(image)"
                          :value="hasPlacement(image) ? image.placement.position : 0"
                          @change="onInlineImagePositionChange(image, $event.target.value)"
                        >
                          <option v-for="option in getPositionOptions(image)" :key="`${image.id}-${option.value}`" :value="option.value">
                            {{ option.label }}
                          </option>
                        </select>
                      </label>
                    </div>

                    <div v-if="getPlacementContext(image)" class="placement-preview">
                      <div class="placement-preview-header">
                        <span class="preview-chip">{{ getPlacementContext(image).chapterTitle }}</span>
                        <span class="preview-chip soft">{{ getPlacementContext(image).positionLabel }}</span>
                      </div>

                      <div class="placement-preview-flow">
                        <div class="placement-preview-block">
                          <span>前文</span>
                          <p>{{ getPlacementContext(image).previousText }}</p>
                        </div>
                        <div class="placement-preview-image">插图</div>
                        <div class="placement-preview-block">
                          <span>后文</span>
                          <p>{{ getPlacementContext(image).nextText }}</p>
                        </div>
                      </div>
                    </div>

                    <div class="asset-actions">
                      <button class="ghost-btn" type="button" @click="clearInlinePlacement(image)">清空位置</button>
                      <button class="ghost-btn danger" type="button" @click="clearInlineImage(image.id)">删除插图</button>
                    </div>
                  </div>
                </div>
              </li>
            </ul>

            <p v-else class="sub small">上传后直接选“第几章、第几段后”，不需要再往正文里插入标记。</p>
          </div>
        </div>
      </div>

      <label>
        TXT 内容（可手动编辑）
        <textarea
          ref="textAreaRef"
          v-model="txtContent"
          @paste="onPasteTextImages"
          rows="16"
          placeholder="把 txt 内容粘贴到这里，或通过上方文件选择导入。支持直接在这里粘贴截图或剪贴板图片。"
        />
      </label>
      <p class="sub small">支持在编辑框内直接粘贴图片，系统会把图片插入到当前光标位置。</p>

      <button :disabled="!canConvert" class="convert-btn" @click="onConvert">
        {{ isConverting ? "转换中..." : "生成 EPUB 并下载" }}
      </button>

      <p class="status">{{ message }}</p>
      <p v-if="errorMessage" class="error">{{ errorMessage }}</p>
    </section>

    <section class="card">
      <h2>章节预览</h2>
      <p class="sub">最多显示前 10 章，方便先确认分章结果。</p>

      <ul v-if="chapterPreview.length > 0" class="preview-list">
        <li v-for="chapter in chapterPreview" :key="chapter.title">
          <strong>{{ chapter.title }}</strong>
          <span>{{ chapter.content.slice(0, 72) }}{{ chapter.content.length > 72 ? "..." : "" }}</span>
        </li>
      </ul>

      <p v-else-if="chapterStructure.length > 0" class="sub">
        当前可识别 {{ chapterStructure.length }} 章，你可以先给插图定位，再导出 EPUB。
      </p>

      <p v-else class="sub">转换后会在这里显示章节标题，便于确认分章是否正确。</p>
    </section>

    <section v-if="positionedInlineImages.length > 0" class="card">
      <h2>插图总览</h2>
      <p class="sub">这里会集中显示所有已定位的插图，方便检查整本书的图文落点。</p>

      <ul class="placement-gallery">
        <li v-for="image in positionedInlineImages" :key="image.id">
          <img class="placement-gallery-thumb" :src="image.previewUrl" :alt="image.alt" />
          <div class="placement-gallery-body">
            <div class="placement-gallery-head">
              <strong>{{ image.name }}</strong>
              <span>{{ image.context.chapterTitle }} · {{ image.context.positionLabel }}</span>
            </div>
            <p>前文：{{ image.context.previousText }}</p>
            <p>后文：{{ image.context.nextText }}</p>
          </div>
        </li>
      </ul>
    </section>
  </main>
</template>
