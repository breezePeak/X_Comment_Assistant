(() => {
  function ownHandle() {
    const link = document.querySelector('a[data-testid="AppTabBar_Profile_Link"]');
    const path = link && new URL(link.href, location.href).pathname;
    return path?.match(/^\/([A-Za-z0-9_]{1,15})\/?$/)?.[1];
  }

  function readCells() {
    const owner = ownHandle();
    if (!owner || location.pathname.toLowerCase().replace(/\/$/, "") !== `/${owner.toLowerCase()}/following`) {
      throw new Error("请先打开自己的「正在关注」页面，列表加载后会自动识别。");
    }
    const main = document.querySelector('[data-testid="primaryColumn"]');
    if (!main) throw new Error("关注列表尚未加载，请稍后重试。");
    // shortcut: 依据 X 网页的关注按钮和回关标记判断，X 改版时需更新选择器。
    return [...main.querySelectorAll('[data-testid="UserCell"]')].flatMap(cell => {
      const button = cell.querySelector('button[data-testid$="-unfollow"]');
      if (!button) return [];
      const handle = [...cell.querySelectorAll('a[href]')].map(link => {
        const url = new URL(link.href, location.href);
        return url.origin === location.origin && url.pathname.match(/^\/([A-Za-z0-9_]{1,15})\/?$/)?.[1];
      }).find(value => value && cell.textContent.includes(`@${value}`));
      if (!handle || handle.toLowerCase() === owner.toLowerCase()) return [];
      return [{ handle, followsYou: Boolean(cell.querySelector('[data-testid="userFollowIndicator"]')), button }];
    });
  }

  let previous = "";
  let scanTimer;
  function scan() {
    let current = "";
    try { current = JSON.stringify([ownHandle(), readCells().map(({ handle, followsYou }) => [handle, followsYou])]); }
    catch { /* 页面离开关注列表或尚未加载，等待下一次变化。 */ }
    if (current === previous) return;
    previous = current;
    chrome.runtime.sendMessage({ type: "FOLLOWING_LIST_CHANGED" }).catch(() => {});
  }
  function scheduleScan() {
    // 固定窗口合并页面变化，连续滚动时也持续识别。
    if (!scanTimer) scanTimer = setTimeout(() => { scanTimer = null; scan(); }, 200);
  }
  const observer = new MutationObserver(scheduleScan);
  observer.observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["data-testid", "href"] });
  window.addEventListener("wheel", scheduleScan, { passive: true, capture: true });
  window.addEventListener("scroll", scheduleScan, { passive: true, capture: true });
  window.addEventListener("popstate", scheduleScan);
  scan();

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (sender.id !== chrome.runtime.id || !["GET_NON_FOLLOWERS", "UNFOLLOW_ACCOUNT", "OPEN_OWN_FOLLOWING"].includes(message?.type)) return;
    try {
      if (message.type === "OPEN_OWN_FOLLOWING") {
        const owner = ownHandle();
        if (!owner) throw new Error("未识别到当前登录账号，请先登录 X 并刷新页面。");
        sendResponse({ ok: true });
        location.assign(`/${owner}/following`);
        return;
      }
      const cells = readCells();
      if (message.type === "GET_NON_FOLLOWERS") {
        const accounts = [...new Map(cells.filter(cell => !cell.followsYou).map(cell => [cell.handle.toLowerCase(), { handle: cell.handle }])).values()];
        sendResponse({ ok: true, owner: ownHandle(), checked: new Set(cells.map(cell => cell.handle.toLowerCase())).size, accounts });
      } else {
        if (message.owner !== ownHandle()) throw new Error("登录账号已改变，请等待列表自动更新后重试。");
        if (typeof message.handle !== "string" || !/^[A-Za-z0-9_]{1,15}$/.test(message.handle)) throw new Error("账号无效。");
        const cell = cells.find(cell => cell.handle.toLowerCase() === message.handle.toLowerCase());
        if (!cell) throw new Error("该账号已不在当前加载的列表中，请等待列表自动更新后操作。");
        if (cell.followsYou) throw new Error("该账号当前显示已关注你，已停止取消操作，列表会自动更新。");
        if (document.querySelector('[role="dialog"]') || cell.button.disabled) throw new Error("请先处理 X 中的弹窗，或稍后重试。");
        cell.button.click();
        sendResponse({ ok: true });
      }
    } catch (error) { sendResponse({ ok: false, error: error.message }); }
  });
})();
