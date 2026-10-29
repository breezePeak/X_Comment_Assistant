import { analyticsProfile } from "./analytics-profile.js";
import { normalizePost } from "./core.js";
import { handleAnalyticsMessage } from "./analytics-sync.js";

// API 密钥仅供扩展自身页面读取，隔离 X 页面的内容脚本。
chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" }).catch(console.error);
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(console.error);

let enabled = false;
let stateKnown = false;
const stateReady = chrome.storage.session.get("assistantEnabled").then(state => {
  if (!stateKnown) enabled = state.assistantEnabled === true;
}).catch(console.error).finally(() => { stateKnown = true; });

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.analyticsProfileUrl) {
    try {
      const { owner } = analyticsProfile(changes.analyticsProfileUrl.newValue);
      chrome.tabs.query({ url: ["https://x.com/*", "https://twitter.com/*"] }).then(tabs => {
        tabs.forEach(tab => chrome.tabs.sendMessage(tab.id, { type: "ANALYTICS_PROFILE", ok: true, owner }).catch(() => {}));
      }).catch(console.error);
    } catch (error) { console.warn(error); }
  }
  if (area !== "session" || !changes.assistantEnabled) return;
  stateKnown = true;
  enabled = changes.assistantEnabled.newValue === true;
  chrome.tabs.query({ url: ["https://x.com/*", "https://twitter.com/*"] }).then(tabs => {
    tabs.forEach(tab => chrome.tabs.sendMessage(tab.id, { type: "ASSISTANT_STATE", enabled }).catch(() => {}));
  }).catch(console.error);
});

chrome.runtime.onMessage.addListener(function onMessage(message, sender, sendResponse) {
  if (message?.type === "GET_ANALYTICS_PROFILE") {
    if (sender.id !== chrome.runtime.id || !Number.isInteger(sender.tab?.id) || !/^https:\/\/(x|twitter)\.com\//.test(sender.url || "")) return;
    chrome.storage.local.get("analyticsProfileUrl")
      .then(({ analyticsProfileUrl }) => sendResponse({ ok: true, ...analyticsProfile(analyticsProfileUrl) }))
      .catch(error => sendResponse({ ok: false, error: error.message }));
    return true;
  }
  if (["SAVE_OWN_POSTS", "SAVE_ORIGINAL_IMPRESSIONS", "ADD_ORIGINAL_IMPRESSIONS", "LOAD_OWN_POSTS", "CLEAR_OWN_POSTS"].includes(message?.type)) return handleAnalyticsMessage(message, sender, sendResponse);
  if (!["POST_SELECTED", "GET_ASSISTANT_STATE"].includes(message?.type)) return;
  if (sender.id !== chrome.runtime.id || !Number.isInteger(sender.tab?.id) ||
      !/^https:\/\/(x|twitter)\.com\//.test(sender.url || "")) return;
  if (message.type === "GET_ASSISTANT_STATE") {
    stateReady.then(() => sendResponse({ ok: true, enabled }));
    return true;
  }
  if (!stateKnown) { stateReady.then(() => onMessage(message, sender, sendResponse)); return true; }
  if (!enabled) { sendResponse({ ok: true, ignored: true }); return; }
  let post;
  try { post = normalizePost(message.post); }
  catch (error) { sendResponse({ ok: false, error: error.message }); return; }

  // 在点击消息中打开，不推迟到后续存储回调，保留 Chrome 要求的用户手势。
  if (message.openPanel !== false) {
    chrome.sidePanel.open({ tabId: sender.tab.id }).catch(error => console.warn("请点击工具栏图标打开助手。", error));
  }
  // 同一帖子重新开启后仍要通知侧边栏；候选缓存继续按帖子内容复用。
  chrome.storage.session.set({ [`post:${sender.tab.id}`]: { ...post, selectionId: crypto.randomUUID() } })
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
