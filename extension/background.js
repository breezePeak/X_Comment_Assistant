import { normalizePost } from "./core.js";

// API 密钥仅供扩展自身页面读取，隔离 X 页面的内容脚本。
chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" }).catch(console.error);
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(console.error);

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== "POST_SELECTED") return;
  if (sender.id !== chrome.runtime.id || !Number.isInteger(sender.tab?.id) ||
      !/^https:\/\/(x|twitter)\.com\//.test(sender.url || "")) return;
  let post;
  try { post = normalizePost(message.post); }
  catch (error) { sendResponse({ ok: false, error: error.message }); return; }

  // 必须在点击消息到达时立即打开，保留 Chrome 要求的用户手势。
  if (message.openPanel !== false) {
    chrome.sidePanel.open({ tabId: sender.tab.id }).catch(error => console.warn("请点击工具栏图标打开助手。", error));
  }
  chrome.storage.session.set({ [`post:${sender.tab.id}`]: post })
    .then(() => sendResponse({ ok: true }))
    .catch(() => sendResponse({ ok: false, error: "未能保存帖子，请重试。" }));
  return true;
});

function clearTab(tabId) {
  chrome.storage.session.remove([`post:${tabId}`, `draft:${tabId}`]).catch(console.error);
}

chrome.tabs.onRemoved.addListener(clearTab);
chrome.tabs.onUpdated.addListener((tabId, change) => {
  if (change.status === "loading") clearTab(tabId);
});
