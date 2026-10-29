const $ = id => document.getElementById(id);
let revision = 0;
let loadedTabId = null;

function status(text, error = false) {
  $("following-status").textContent = text;
  $("following-status").classList.toggle("error", error);
}

async function activeTab() {
  const { id: windowId } = await chrome.windows.getCurrent();
  const [tab] = await chrome.tabs.query({ active: true, windowId });
  if (!tab?.id || !/^https:\/\/(x|twitter)\.com\//.test(tab.url || "")) throw new Error("请切换到已登录的 X 标签页。");
  return tab.id;
}

async function request(tabId, message) {
  let response;
  try { response = await chrome.tabs.sendMessage(tabId, message); }
  catch { throw new Error("无法连接 X 页面，请刷新 X 后重试。"); }
  if (!response?.ok) throw new Error(response?.error || "X 页面没有返回有效结果，请刷新后重试。");
  return response;
}

function clear() {
  revision++;
  loadedTabId = null;
  $("following-list").replaceChildren();
  status("");
}

async function load() {
  clear();
  const current = revision;
  status("正在读取当前已加载的关注列表…");
  try {
    const tabId = await activeTab();
    if (current !== revision) return;
    loadedTabId = tabId;
    const data = await request(tabId, { type: "GET_NON_FOLLOWERS" });
    if (current !== revision) return;
    if (!/^[A-Za-z0-9_]{1,15}$/.test(data.owner) || !Number.isSafeInteger(data.checked) || data.checked < 0 || !Array.isArray(data.accounts) || data.accounts.some(account => !/^[A-Za-z0-9_]{1,15}$/.test(account?.handle))) throw new Error("关注列表格式无效，请刷新 X 后重试。");
    for (const { handle } of data.accounts) {
      const card = document.createElement("article");
      card.className = "source-card following-account";
      const link = document.createElement("a");
      link.href = `https://x.com/${handle}`;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.textContent = `@${handle}`;
      const button = document.createElement("button");
      button.type = "button";
      button.className = "secondary";
      button.textContent = "取消关注";
      button.addEventListener("click", async () => {
        button.disabled = true;
        try {
          if (await activeTab() !== tabId) throw new Error("当前 X 标签页已改变，请等待列表自动更新后重试。");
          await request(tabId, { type: "UNFOLLOW_ACCOUNT", handle, owner: data.owner });
          if (current === revision) status(`请在 X 弹窗中核对 @${handle} 并确认取消关注，列表变化后会自动刷新。`);
        } catch (error) { if (current === revision) status(error.message, true); }
        finally { button.disabled = false; }
      });
      card.append(link, button);
      $("following-list").append(card);
    }
    status(`已检查当前加载的 ${data.checked} 个关注账号，${data.accounts.length} 个未显示回关标记。${data.checked ? "滚动 X 时自动识别并更新。" : "等待列表加载后自动识别。"}`);
  } catch (error) { if (current === revision) status(error.message, true); }
}

$("following-open").addEventListener("click", async () => {
  clear();
  try {
    const tabId = await activeTab();
    loadedTabId = tabId;
    await request(tabId, { type: "OPEN_OWN_FOLLOWING" });
    status("等待 X 的关注列表加载，随后自动识别；向下滚动会自动更新。");
  }
  catch (error) { status(error.message, true); }
});
chrome.tabs.onActivated.addListener(() => { clear(); if (!$("following-view").hidden) void load(); });
new MutationObserver(() => { if ($("following-view").hidden) clear(); else void load(); })
  .observe($("following-view"), { attributes: true, attributeFilter: ["hidden"] });
chrome.runtime.onMessage.addListener((message, sender) => {
  if (message?.type !== "FOLLOWING_LIST_CHANGED" || sender.id !== chrome.runtime.id ||
      sender.tab?.id !== loadedTabId || !/^https:\/\/(x|twitter)\.com\//.test(sender.url || "") || $("following-view").hidden) return;
  void load();
});
