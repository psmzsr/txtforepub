<script setup>
import { computed, ref } from "vue";
import { createEpubFromTxt } from "./lib/epub";

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

const canConvert = computed(() => txtContent.value.trim().length > 0 && !isConverting.value);

async function onSelectFile(event) {
  const [file] = event.target.files || [];
  if (!file) {
    return;
  }

  sourceFileName.value = file.name;
  txtContent.value = await file.text();
  message.value = `已加载文件：${file.name}`;
  errorMessage.value = "";
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
      text: txtContent.value
    });
    chapterPreview.value = result.chapters.slice(0, 10);
    message.value = `转换成功，已下载 EPUB（共 ${result.chapters.length} 章）。`;
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : "转换失败，请重试。";
    message.value = "转换失败";
  } finally {
    isConverting.value = false;
  }
}
</script>

<template>
  <main class="page">
    <section class="card">
      <h1>TXT 转 EPUB（Vue 初版）</h1>
      <p class="sub">本地浏览器转换，不上传服务器。</p>

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

      <label>
        TXT 内容（可手动编辑）
        <textarea
          v-model="txtContent"
          rows="14"
          placeholder="把 txt 内容粘贴到这里，或通过上方文件选择导入。"
        />
      </label>

      <button :disabled="!canConvert" class="convert-btn" @click="onConvert">
        {{ isConverting ? "转换中..." : "生成 EPUB 并下载" }}
      </button>

      <p class="status">{{ message }}</p>
      <p v-if="errorMessage" class="error">{{ errorMessage }}</p>
    </section>

    <section class="card">
      <h2>章节预览（最多显示 10 章）</h2>
      <ul v-if="chapterPreview.length > 0" class="preview-list">
        <li v-for="chapter in chapterPreview" :key="chapter.title">
          <strong>{{ chapter.title }}</strong>
          <span>{{ chapter.content.slice(0, 42) }}{{ chapter.content.length > 42 ? "..." : "" }}</span>
        </li>
      </ul>
      <p v-else class="sub">转换后会在这里显示章节标题，便于确认分章是否正确。</p>
    </section>
  </main>
</template>
