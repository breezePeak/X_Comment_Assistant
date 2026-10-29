import { imageSource, postServiceRequest, validatePostService } from "./posts-api.js";

const $ = id => document.getElementById(id);
let controller;
let cursor = null;
let revision = 0;
const imageUrls = new Set();

function status(message, error = false) {
  $("posts-status").textContent = message;
  $("posts-status").classList.toggle("error", error);
}

function clear() {
  controller?.abort();
  revision++;
  for (const url of imageUrls) URL.revokeObjectURL(url);
  imageUrls.clear();
  $("posts-list").replaceChildren();
  $("posts-more").hidden = true;
  cursor = null;
}

function button(label, action) {
  const element = document.createElement("button");
  element.type = "button";
  element.className = "secondary";
  element.textContent = label;
  element.addEventListener("click", async () => {
    const current = revision;
    element.disabled = true;
    try { await action(); }
    catch (error) { if (current === revision) status(error.message, true); }
    finally { element.disabled = false; }
  });
  return element;
}

async function renderImage(image, index, post, parent, config, signal, current) {
  const figure = document.createElement("figure");
  const img = document.createElement("img");
  img.alt = image.alt || `配图 ${index + 1}`;
  img.referrerPolicy = "no-referrer";
  img.loading = "lazy";
  const link = document.createElement("a");
  link.textContent = `配图 ${index + 1} 加载中…`;
  figure.append(img, link);
  parent.append(figure);
  img.addEventListener("error", () => {
    img.hidden = true;
    link.textContent = `配图 ${index + 1} 无法预览，点击打开或保存`;
  });
  try {
    const source = imageSource(image, post.id, index);
    if (source.path) {
      const blob = await postServiceRequest(config, source.path, { signal, binary: true });
      if (current !== revision) return;
      const url = URL.createObjectURL(blob);
      imageUrls.add(url);
      img.src = url;
      link.href = url;
      link.download = `post-${post.id}-${index + 1}.${blob.type.split("/")[1]}`;
      link.textContent = `保存配图 ${index + 1}`;
    } else {
      img.src = source.url;
      link.href = source.url;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.textContent = `打开配图 ${index + 1} 并保存`;
    }
  } catch (error) {
    if (current !== revision || signal.aborted) return;
    img.hidden = true;
    link.textContent = `配图 ${index + 1}：${error.message}`;
  }
}

function renderPost(post, selectedConfig, signal, current) {
  const card = document.createElement("article");
  card.className = "hot-post source-card";
  const heading = document.createElement("h2");
  heading.textContent = post.title || "热点帖子";
  const meta = document.createElement("small");
  meta.textContent = `${post.consumedAt ? "已消费" : "待发布"} · ${new Date(post.createdAt).toLocaleString()}`;
  const field = document.createElement("textarea");
  field.value = post.text;
  field.rows = 6;
  field.maxLength = 25000;
  field.setAttribute("aria-label", "热点帖子正文，可编辑后复制");
  const media = document.createElement("div");
  media.className = "hot-post-images";
  const sources = document.createElement("div");
  sources.className = "hot-post-sources";
  for (const source of post.sources || []) {
    try {
      const url = new URL(source.url);
      if (url.protocol !== "https:" || url.username || url.password) continue;
      const link = document.createElement("a");
      link.href = url.href;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.textContent = source.title || url.hostname;
      sources.append(link);
    } catch { /* 忽略无效的来源地址。 */ }
  }
  const actions = document.createElement("div");
  actions.className = "hot-post-actions";
  actions.append(button("复制正文", async () => {
    await navigator.clipboard.writeText(field.value.trim());
    status("正文已复制；保存配图后，在 X 发帖框粘贴文字并添加图片。发布成功后点击「我已发布」。");
  }));
  const compose = document.createElement("a");
  compose.className = "secondary";
  compose.textContent = "去 X 发帖 ↗";
  compose.href = "https://x.com/compose/post";
  compose.target = "_blank";
  compose.rel = "noopener noreferrer";
  actions.append(compose, button(post.consumedAt ? "恢复待发布" : "我已发布", async () => {
    const result = await postServiceRequest(selectedConfig, `/api/posts/${post.id}/consume`, { method: "POST", body: { consumed: !post.consumedAt }, signal });
    if (current !== revision) return;
    if (!result.post || typeof result.post.id !== "number") throw new Error("消费状态响应无效，请刷新核对。");
    const consumed = Boolean(result.post.consumedAt);
    if (consumed && !$("posts-show-consumed").checked) card.remove();
    else card.replaceWith(renderPost(result.post, selectedConfig, signal, current));
    status(consumed ? "已标记为已消费；勾选「显示已消费」可查看和恢复。" : "已恢复为待发布。");
  }));
  card.append(heading, meta, field, media, sources, actions);
  (post.images || []).forEach((image, index) => { void renderImage(image, index, post, media, selectedConfig, signal, current); });
  return card;
}

async function load(more = false) {
  if (!more) clear();
  const current = revision;
  controller ??= new AbortController();
  if (controller.signal.aborted) controller = new AbortController();
  const signal = controller.signal;
  $("posts-refresh").disabled = true;
  $("posts-more").disabled = true;
  status("正在读取热点帖子…");
  try {
    const stored = await chrome.storage.local.get("postService");
    const config = validatePostService(stored.postService);
    if (!await chrome.permissions.contains({ origins: [`${new URL(config.baseUrl).origin}/*`] })) throw new Error("请在设置中保存并授权热点服务域名。");
    if (current !== revision) return;
    const filter = $("posts-show-consumed").checked ? "all" : "pending";
    const data = await postServiceRequest(config, `/api/posts?status=${filter}&limit=20${more && cursor ? `&before=${cursor}` : ""}`, { signal });
    if (current !== revision) return;
    if (!Array.isArray(data.posts) || data.posts.some(post => !Number.isSafeInteger(post.id) || post.id < 1 || typeof post.text !== "string") ||
        !(data.nextCursor === null || (Number.isSafeInteger(data.nextCursor) && data.nextCursor > 0))) throw new Error("热点服务返回格式无效。");
    data.posts.forEach(post => $("posts-list").append(renderPost(post, config, signal, current)));
    cursor = data.nextCursor;
    $("posts-more").hidden = !cursor;
    status($("posts-list").children.length ? "检查正文与配图，发布成功后手动标记。编辑仅用于本次复制，刷新后恢复原文。" : "暂无帖子。等待 GPT bot 入库，或勾选「显示已消费」。");
  } catch (error) { if (current === revision) status(error.message, true); }
  finally {
    if (current === revision) { $("posts-refresh").disabled = false; $("posts-more").disabled = false; }
  }
}

const views = ["comments", "friendly", "posts", "following", "analytics"];
for (const view of views) {
  $(`view-${view}`).addEventListener("click", () => {
    for (const name of views) {
      $(`${name}-view`).hidden = view !== name;
      $(`view-${name}`).setAttribute("aria-pressed", String(view === name));
    }
    if (view === "posts") void load();
    else { clear(); window.dispatchEvent(new Event("resize")); }
  });
}
$("posts-refresh").addEventListener("click", () => { void load(); });
$("posts-more").addEventListener("click", () => { void load(true); });
$("posts-show-consumed").addEventListener("change", () => { void load(); });
$("posts-configure").addEventListener("click", () => chrome.runtime.openOptionsPage());
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.postService) {
    if (!$("posts-view").hidden) void load();
    else clear();
  }
});
window.addEventListener("pagehide", clear);
