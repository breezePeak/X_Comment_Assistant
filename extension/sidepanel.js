import { DEFAULTS, activeConfig, apiEndpoint, generateReplies, normalizePost, postKey, readSettings, validateSettings } from "./core.js";

const $ = id => document.getElementById(id);
let settings = { ...DEFAULTS };
let tabId;
let windowId;
let post;
let operation = 0;
let loading = 0;
let controller;
let enabled = false;
let stateKnown = false;

function status(message, error = false) {
  $("status").textContent = message;
  $("status").classList.toggle("error", error);
}

function cancel() {
  operation++;
  controller?.abort();
  controller = null;
  $("generate").disabled = !enabled || !ready();
  $("generate").textContent = "重新生成并复制 ↗";
  $("model-response").hidden = true;
  $("model-response").open = false;
  $("raw-response").textContent = "";
}

function draftKey(selected, config) {
  return JSON.stringify(["replies-v3", postKey(selected), config.providerId, config.baseUrl, config.model, config.language, config.preferences]);
}

function ready() {
  try { validateSettings(settings); return true; } catch { return false; }
}

function setEnabled(value) {
  if (stateKnown && enabled === value) return;
  stateKnown = true;
  enabled = value;
  loading++;
  cancel();
  post = null;
  $("source").hidden = true;
  $("results").hidden = true;
  $("empty").hidden = false;
  $("assistant-toggle").textContent = enabled ? "关闭助手" : "开启助手";
  $("assistant-toggle").setAttribute("aria-pressed", String(enabled));
  $("assistant-state").textContent = enabled ? "助手已开启" : "助手已关闭";
  $("read-current").disabled = !enabled;
  $("connection").textContent = enabled ? "等待选择帖子" : "未读取帖子";
  document.body.classList.toggle("assistant-off", !enabled);
  $("empty-title").textContent = enabled ? "好评论，从读懂开始。" : "先开启，再开始。";
  $("empty-hint").textContent = enabled ? "在 X 点击帖子的回复按钮，生成一条并自动复制。\n回复框已打开时，也可点击「重读帖子」。" : "点击上方「开启助手」，再到 X 点击要回复的帖子。";
  status(enabled ? "已开启，等待你选择帖子。" : "已关闭，停止读帖和生成评论。");
}

function resizeReply(field) {
  field.style.height = "0px";
  field.style.height = `${field.scrollHeight}px`;
}

function renderReplies(replies) {
  $("reply-list").replaceChildren();
  $("results").hidden = false;
  replies.forEach((reply, index) => {
    const card = document.createElement("article");
    card.className = "reply-card";
    const heading = document.createElement("div");
    heading.className = "reply-heading";
    const label = document.createElement("strong");
    label.textContent = `0${index + 1} / ${reply.style}`;
    heading.append(label);
    const field = document.createElement("textarea");
    field.className = "reply-text";
    field.value = reply.text;
    field.rows = 1;
    field.setAttribute("aria-label", `${reply.style}评论，可编辑`);
    const translation = document.createElement("div");
    translation.className = "reply-translation";
    translation.hidden = !reply.translation;
    const translationLabel = document.createElement("span");
    const translationText = document.createElement("p");
    translationText.textContent = reply.translation || "";
    translation.append(translationLabel, translationText);
    const bottom = document.createElement("div");
    bottom.className = "reply-bottom";
    const count = document.createElement("span");
    const copy = document.createElement("button");
    copy.className = "copy-button";
    copy.textContent = "复制评论";
    function countText() {
      const length = [...field.value].length;
      count.textContent = `${length} 字符`;
      copy.disabled = !field.value.trim();
      translationLabel.textContent = field.value === reply.text ? "中文参考" : "中文参考（编辑前）";
      resizeReply(field);
    }
    field.addEventListener("input", countText);
    copy.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(field.value.trim());
        copy.textContent = "已复制 ✓";
        status("已复制，回到 X 的回复框粘贴即可。");
        setTimeout(() => { copy.textContent = "复制评论"; }, 1800);
      } catch { status("复制失败，请选中评论文字后按 Ctrl+C 复制。", true); }
    });
    bottom.append(count, copy);
    card.append(heading, field, translation, bottom);
    $("reply-list").append(card);
    countText();
  });
}

async function copyReply(text) {
  try {
    await navigator.clipboard.writeText(text.trim());
    return "已生成一条回复并复制到剪切板，回到 X 粘贴即可。";
  } catch {
    return "已生成一条回复，但自动复制失败；请点击「复制评论」。";
  }
}

async function generate() {
  if (!enabled || !post || !ready()) return;
  cancel();
  const current = operation;
  const selected = post;
  const selectedTab = tabId;
  const config = { ...settings, language: $("language").value };
  const instruction = $("instruction").value;
  const requestController = new AbortController();
  controller = requestController;
  const signal = requestController.signal;
  let timedOut = false;
  const timeout = setTimeout(() => { timedOut = true; requestController.abort(); }, 60000);
  $("generate").disabled = true;
  $("generate").textContent = "正在生成并复制…";
  $("results").hidden = true;
  status("正在生成一条简短回复…");
  try {
    const endpoint = apiEndpoint(config.baseUrl);
    const allowed = await chrome.permissions.contains({ origins: [`${endpoint.origin}/*`] });
    if (!allowed) throw new Error("尚未授权 API 域名，请前往配置页重新保存并授权。");
    if (current !== operation) return;
    const replies = await generateReplies(selected, config, instruction, signal, fetch, true);
    if (current !== operation) return;
    await chrome.storage.session.set({ [`draft:${selectedTab}`]: { key: draftKey(selected, config), replies } });
    if (current !== operation) return;
    renderReplies(replies);
    status(await copyReply(replies[0].text));
  } catch (error) {
    if (current !== operation) return;
    status(timedOut ? "生成超过 60 秒，请稍后重试或选择更快的模型。" : error.message, true);
    if (error.rawResponse) {
      $("raw-response").textContent = error.rawResponse;
      $("model-response").hidden = false;
    }
  } finally {
    clearTimeout(timeout);
    if (current === operation) {
      controller = null;
      $("generate").disabled = !enabled || !ready();
      $("generate").textContent = "重新生成并复制 ↗";
    }
  }
}

async function loadSelection(recover = false, manual = false) {
  if (!enabled) return;
  const revision = ++loading;
  const [tab] = await chrome.tabs.query({ active: true, windowId });
  const id = tab?.id;
  const state = id !== undefined ? await chrome.storage.session.get([`post:${id}`, `draft:${id}`]) : {};
  if (revision !== loading) return;
  let selected = state[`post:${id}`];
  let readError = "";
  if (recover && /^https:\/\/(x|twitter)\.com\//.test(tab?.url || "")) {
    try {
      const response = await chrome.tabs.sendMessage(id, { type: "GET_CURRENT_POST" });
      if (revision !== loading) return;
      if (response?.post) {
        const recovered = normalizePost(response.post);
        if (!selected || postKey(recovered) !== postKey(selected)) {
          await chrome.storage.session.set({ [`post:${id}`]: recovered });
          selected = recovered;
        }
      } else if (manual) readError = "未发现正在回复的帖子，请先打开某条帖子的回复框。";
    } catch (error) {
      readError = error.message.includes("帖子") ? error.message : "未连接到 X 页面，请刷新 X 网页后点击上方按钮重新读取。";
    }
  } else if (manual) readError = "请切回 X 页面，并打开要回复的帖子。";
  if (revision !== loading) return;
  if (id === tabId && selected && post && postKey(selected) === postKey(post)) {
    if (readError) status(readError, true);
    else if (manual) status("已读取当前回复帖子。");
    return;
  }
  cancel();
  tabId = id;
  post = selected;
  status(readError, Boolean(readError));
  $("results").hidden = true;
  $("source").hidden = !post;
  $("empty").hidden = Boolean(post);
  $("connection").textContent = post ? (post.rootPost ? "已读取主帖和评论" : "已读取回复对象") : "等待选择帖子";
  $("instruction").value = "";
  if (!post) return;
  $("source-preview").classList.remove("expanded");
  $("expand-source").setAttribute("aria-expanded", "false");
  $("expand-source").textContent = "展开全文";
  $("source-title").textContent = post.isReply ? "回复评论" : "正在回复";
  $("root-context").hidden = !post.rootPost;
  $("root-author").textContent = post.rootPost?.author || "X 帖子";
  $("root-text").textContent = post.rootPost?.text || "（主帖无正文）";
  $("root-quote").textContent = post.rootPost?.quote || "";
  $("root-quote").hidden = !post.rootPost?.quote;
  $("context-note").hidden = !post.isReply || Boolean(post.rootPost);
  $("post-author").textContent = post.author || "X 帖子";
  $("post-text").textContent = post.text || "（原帖无正文，以下为引用内容）";
  $("post-quote").textContent = post.quote;
  $("post-quote").hidden = !post.quote;
  $("media-note").hidden = !post.hasMedia && !post.rootPost?.hasMedia;
  $("post-link").href = post.url;
  $("post-link").hidden = !post.url;
  const draft = state[`draft:${id}`];
  if (draft?.key === draftKey(post, settings)) {
    renderReplies(draft.replies);
    status(await copyReply(draft.replies[0].text));
  }
  else if (ready()) await generate(true);
}

async function loadSettings() {
  const stored = await chrome.storage.local.get("settings");
  const state = readSettings(stored.settings);
  settings = activeConfig(state);
  $("language").value = settings.language;
  $("setup").hidden = ready();
  $("generate").disabled = !enabled || !ready();
}

$("assistant-toggle").addEventListener("click", async () => {
  const previous = enabled;
  $("assistant-toggle").disabled = true;
  if (previous) setEnabled(false);
  try {
    await chrome.storage.session.set({ assistantEnabled: !previous });
    setEnabled(!previous);
  } catch {
    setEnabled(previous);
    status("切换助手失败，请重试。", true);
  } finally { $("assistant-toggle").disabled = false; }
});

$("settings").addEventListener("click", () => chrome.runtime.openOptionsPage());
$("configure").addEventListener("click", () => chrome.runtime.openOptionsPage());
$("generate").addEventListener("click", generate);
$("expand-source").addEventListener("click", () => {
  const expanded = $("source-preview").classList.toggle("expanded");
  $("expand-source").setAttribute("aria-expanded", String(expanded));
  $("expand-source").textContent = expanded ? "收起全文" : "展开全文";
});
$("read-current").addEventListener("click", async () => {
  $("read-current").disabled = true;
  try { await loadSelection(true, true); }
  catch (error) { status(error.message, true); }
  finally { $("read-current").disabled = !enabled; }
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "session" && changes.assistantEnabled) setEnabled(changes.assistantEnabled.newValue === true);
  if (area === "session" && Object.keys(changes).some(key => key.startsWith("post:"))) {
    const removed = changes[`post:${tabId}`] && !changes[`post:${tabId}`].newValue;
    loadSelection(Boolean(removed)).catch(error => status(error.message, true));
  }
  if (area === "local" && changes.settings) {
    cancel();
    $("results").hidden = true;
    loadSettings()
      .then(() => status(ready() ? (enabled ? "AI 配置已更新，点击重新生成即可应用。" : "AI 配置已保存，开启助手后即可使用。") : "请先在设置中填写并保存 API 配置。"))
      .catch(error => status(error.message, true));
  }
});
chrome.tabs.onActivated.addListener(info => {
  if (info.windowId === windowId) loadSelection(true).catch(error => status(error.message, true));
});
window.addEventListener("pagehide", cancel);
window.addEventListener("resize", () => {
  if (!$("results").hidden) document.querySelectorAll(".reply-text").forEach(resizeReply);
});

try {
  windowId = (await chrome.windows.getCurrent()).id;
  await loadSettings();
  const state = await chrome.storage.session.get("assistantEnabled");
  if (!stateKnown) setEnabled(state.assistantEnabled === true);
  $("assistant-toggle").disabled = false;
  if (enabled) await loadSelection(true);
} catch (error) { status(`初始化失败：${error.message}`, true); }
