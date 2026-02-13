<script setup>
import { computed, ref } from "vue";
import { createEpubFromTxt } from "./lib/epub";

// 表单基础配置：电子书元数据 + 分章策略
const form = ref({
  title: "我的 TXT 电子书",
  author: "匿名作者",
  language: "zh-CN",
  splitMode: "auto",
  maxChapterChars: 6000
});
// 文本原始内容（来自文件上传或手动粘贴）
const txtContent = ref("");
// 已选择的源文件名（仅用于界面展示）
const sourceFileName = ref("");
// 转换后的章节预览（只显示前 10 章）
const chapterPreview = ref([]);
// 转换中的加载态，防止重复点击
const isConverting = ref(false);
// 过程提示信息（成功/失败/进行中）
const message = ref("准备就绪：先上传 TXT 或直接粘贴内容。");
// 错误信息（单独高亮展示）
const errorMessage = ref("");

// 转换按钮是否可用：有内容且当前不在转换中
const canConvert = computed(() => txtContent.value.trim().length > 0 && !isConverting.value);

// 处理文件选择：读取 TXT 到文本框
async function onSelectFile(event) {
  // 只取首个文件
  const [file] = event.target.files || [];
  if (!file) {
    return;
  }

  // 记录文件名，并读取文本内容
  sourceFileName.value = file.name;
  txtContent.value = await file.text();
  // 更新状态提示并清空旧错误
  message.value = `已加载文件：${file.name}`;
  errorMessage.value = "";
}

// 处理“生成 EPUB”按钮点击
async function onConvert() {
  // 防御式判断，避免非法触发
  if (!canConvert.value) {
    return;
  }

  // 进入加载态，重置错误并给出进度提示
  isConverting.value = true;
  errorMessage.value = "";
  message.value = "正在生成 EPUB...";

  try {
    // 把表单参数和正文一起交给 EPUB 生成器
    const result = await createEpubFromTxt({
      ...form.value,
      text: txtContent.value
    });
    // 仅预览前 10 章，避免界面过长
    chapterPreview.value = result.chapters.slice(0, 10);
    // 生成器内部已触发下载，这里只做结果反馈
    message.value = `转换成功，已下载 EPUB（共 ${result.chapters.length} 章）。`;
  } catch (error) {
    // 统一错误展示：优先显示异常对象中的 message
    errorMessage.value = error instanceof Error ? error.message : "转换失败，请重试。";
    message.value = "转换失败";
  } finally {
    // 无论成功失败都要退出加载态
    isConverting.value = false;
  }
}
</script>

<template>
  <main class="page">
    <!-- 左侧：输入与转换区 -->
    <section class="card">
      <h1>TXT 转 EPUB（Vue 初版）</h1>
      <p class="sub">本地浏览器转换，不上传服务器。</p>

      <!-- 基础元数据 -->
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

      <!-- 分章参数 -->
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

      <!-- 文件输入 + 文件名展示 -->
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

      <!-- 文本编辑区 -->
      <label>
        TXT 内容（可手动编辑）
        <textarea
          v-model="txtContent"
          rows="14"
          placeholder="把 txt 内容粘贴到这里，或通过上方文件选择导入。"
        />
      </label>

      <!-- 触发转换 -->
      <button :disabled="!canConvert" class="convert-btn" @click="onConvert">
        {{ isConverting ? "转换中..." : "生成 EPUB 并下载" }}
      </button>

      <!-- 状态反馈 -->
      <p class="status">{{ message }}</p>
      <p v-if="errorMessage" class="error">{{ errorMessage }}</p>
    </section>

    <!-- 右侧：分章结果预览 -->
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
