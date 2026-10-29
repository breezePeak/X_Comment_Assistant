import { PRESET_COMMENTS } from "./friendly-data.js";
import { LOCAL_POST_SERVICE, postServiceRequest } from "./posts-api.js";

const $ = id => document.getElementById(id);
const STORAGE_KEY = "friendly_comments_v1";

let commentsList = [];
let isGenerating = false;

function status(message, error = false) {
  const el = $("friendly-status");
  if (!el) return;
  el.textContent = message;
  el.classList.toggle("error", error);
}

function generateId() {
  return `fc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

async function loadFromStorage() {
  try {
    const data = await chrome.storage.local.get(STORAGE_KEY);
    if (Array.isArray(data[STORAGE_KEY])) {
      commentsList = data[STORAGE_KEY].filter(item => item && typeof item.text === "string" && item.text.trim());
    } else {
      commentsList = [];
    }
  } catch {
    commentsList = [];
  }
}

async function saveToStorage() {
  try {
    await chrome.storage.local.set({ [STORAGE_KEY]: commentsList });
  } catch (err) {
    console.error("保存交友评论失败", err);
  }
}

function updateEmptyState() {
  const emptyEl = $("friendly-empty");
  if (emptyEl) {
    emptyEl.hidden = commentsList.length > 0;
  }
}

function getPresetBatch(count = 6) {
  const existingTexts = new Set(commentsList.map(item => item.text));
  const available = PRESET_COMMENTS.filter(item => !existingTexts.has(item.text));
  const pool = available.length >= count ? available : PRESET_COMMENTS;
  // 随机洗牌抽取
  const shuffled = [...pool].sort(() => 0.5 - Math.random());
  return shuffled.slice(0, count).map(item => ({
    id: generateId(),
    style: item.style,
    text: item.text
  }));
}

async function copyToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    textarea.select();
    const successful = document.execCommand("copy");
    document.body.removeChild(textarea);
    return successful;
  }
}

function renderCard(item) {
  const card = document.createElement("article");
  card.className = "friendly-card";
  card.dataset.id = item.id;
  card.setAttribute("tabindex", "0");
  card.setAttribute("role", "button");
  card.setAttribute("aria-label", `${item.style}评论：${item.text}，点击复制并消费`);

  const header = document.createElement("div");
  header.className = "friendly-card-header";

  const tag = document.createElement("span");
  tag.className = "friendly-tag";
  tag.textContent = item.style || "同频交流";

  const actionHint = document.createElement("span");
  actionHint.className = "friendly-hint";
  actionHint.textContent = "点击复制并消费 ↗";

  header.append(tag, actionHint);

  const textP = document.createElement("p");
  textP.className = "friendly-text";
  textP.textContent = item.text;

  card.append(header, textP);

  // 点击消费
  const handleConsume = async () => {
    if (card.classList.contains("consuming")) return;
    card.classList.add("consuming");

    const copied = await copyToClipboard(item.text);
    actionHint.textContent = copied ? "已复制 ✓" : "复制失败";
    actionHint.style.color = copied ? "var(--accent)" : "#b34b3d";

    status(copied ? `已复制并消费：「${item.text.slice(0, 16)}…」` : "复制到剪切板失败，请重试。", !copied);

    if (item.dbId) {
      void postServiceRequest(LOCAL_POST_SERVICE, "/api/friendly/consume", { method: "POST", body: { id: item.dbId } }).catch(() => {});
    }

    // 动画完成后从DOM和存储中移除
    setTimeout(async () => {
      card.remove();
      commentsList = commentsList.filter(c => c.id !== item.id);
      await saveToStorage();
      updateEmptyState();
    }, 220);
  };

  card.addEventListener("click", handleConsume);
  card.addEventListener("keydown", e => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      void handleConsume();
    }
  });

  return card;
}

function renderList() {
  const listEl = $("friendly-list");
  if (!listEl) return;
  listEl.replaceChildren();
  for (const item of commentsList) {
    listEl.appendChild(renderCard(item));
  }
  updateEmptyState();
}

// 优先从本地 SQLite 数据库中读取，未启动时平滑降级到离线库
async function generateNewComments() {
  if (isGenerating) return;
  isGenerating = true;
  const generateBtn = $("friendly-generate");
  if (generateBtn) generateBtn.disabled = true;

  try {
    status("正在从本地 SQLite 数据库中读取…");
    let newItems = [];
    let fromDb = false;

    try {
      const res = await postServiceRequest(LOCAL_POST_SERVICE, "/api/friendly/batch?count=6");
      if (Array.isArray(res?.comments) && res.comments.length) {
        newItems = res.comments.map(c => ({
          id: generateId(),
          dbId: c.id,
          style: c.style,
          text: c.text
        }));
        fromDb = true;
      }
    } catch {
      // 本地服务未运行或无法连接时平滑降级
    }

    if (!newItems.length) {
      newItems = getPresetBatch(6);
    }

    if (newItems.length) {
      commentsList = [...newItems, ...commentsList];
      await saveToStorage();
      renderList();
      status(fromDb ? `已从 SQLite 数据库提取 ${newItems.length} 条交友短评，点击即可复制消费！` : `已提取 ${newItems.length} 条交友短评，点击即可复制消费！`);
    } else {
      status("库中评论已全部取出，点击清空可重新循环取用。");
    }
  } catch (err) {
    status(err.message || "获取评论失败，请重试。", true);
  } finally {
    isGenerating = false;
    if (generateBtn) generateBtn.disabled = false;
  }
}

async function clearComments() {
  if (!commentsList.length) return;
  commentsList = [];
  await saveToStorage();
  renderList();
  status("已清空待消费评论列表。");
}

// 初始化
async function init() {
  await loadFromStorage();
  renderList();

  const generateBtn = $("friendly-generate");
  const clearBtn = $("friendly-clear");

  if (generateBtn) {
    generateBtn.addEventListener("click", () => {
      void generateNewComments();
    });
  }

  if (clearBtn) {
    clearBtn.addEventListener("click", () => {
      void clearComments();
    });
  }

  // 如果初次打开且没有任何评论，默认自动从数据库预加载一批
  if (commentsList.length === 0) {
    commentsList = getPresetBatch(6);
    await saveToStorage();
    renderList();
  }
}

function start() {
  void init();
}

if (typeof document !== "undefined" && typeof chrome !== "undefined") {
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start);
  } else {
    start();
  }
}

export { PRESET_COMMENTS, getPresetBatch };
