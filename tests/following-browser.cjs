const { chromium } = require("playwright");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

(async () => {
  const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    const html = fs.readFileSync(path.join(__dirname, "../extension/sidepanel.html"), "utf8");
    const section = html.match(/<section id="following-view"[\s\S]*?<\/section>/)[0];
    const cell = (handle, mutual = false) => `<div data-testid="UserCell"><a href="/${handle}">@${handle}</a><button data-testid="${handle}-unfollow">Following</button>${mutual ? '<span data-testid="userFollowIndicator">Follows you</span>' : ""}</div>`;
    await page.route("https://x.com/**", route => route.fulfill({ contentType: "text/html;charset=utf-8", body: `<a data-testid="AppTabBar_Profile_Link" href="/me">Me</a><main data-testid="primaryColumn">${cell("alice")}${cell("bob", true)}</main>${section}` }));
    await page.goto("https://x.com/me/following");
    await page.evaluate(() => {
      const listeners = [];
      window.__activated = [];
      window.__messages = [];
      window.chrome = {
        windows: { getCurrent: async () => ({ id: 1 }) },
        tabs: {
          query: async () => [{ id: 1, url: location.href }],
          onActivated: { addListener: listener => window.__activated.push(listener) },
          sendMessage: async (_, message) => new Promise(resolve => listeners.forEach(listener => listener(message, { id: "self" }, resolve)))
        },
        runtime: {
          id: "self", onMessage: { addListener: listener => listeners.push(listener) },
          sendMessage: async message => {
            window.__messages.push(message);
            listeners.forEach(listener => listener(message, { id: "self", tab: { id: 1 }, url: location.href }, () => {}));
          }
        }
      };
    });
    for (const file of ["following-content.js", "following-panel.js"]) await page.addScriptTag({ path: path.join(__dirname, "../extension", file) });
    await page.evaluate(() => { document.getElementById("following-view").hidden = false; });
    await page.locator(".following-account").waitFor();
    assert.equal(await page.locator(".following-account a").textContent(), "@alice", "进入视图自动读取并排除互关");
    assert.equal(await page.locator("#following-refresh").count(), 0);
    await page.evaluate(() => { document.querySelector('[data-testid="primaryColumn"]').insertAdjacentHTML("beforeend", '<div data-testid="UserCell"><a href="/carol">@carol</a><button data-testid="carol-unfollow">Following</button></div>'); dispatchEvent(new WheelEvent("wheel")); });
    await page.waitForFunction(() => document.querySelectorAll(".following-account").length === 2);
    await page.evaluate(() => { document.querySelector('[data-testid="alice-unfollow"]').closest('[data-testid="UserCell"]').insertAdjacentHTML("beforeend", '<span data-testid="userFollowIndicator">Follows you</span>'); });
    await page.waitForFunction(() => document.querySelectorAll(".following-account").length === 1);
    assert.equal(await page.locator(".following-account a").textContent(), "@carol", "异步回关标记更新后自动排除");
    await page.evaluate(() => { history.pushState({}, "", "/other/following"); dispatchEvent(new Event("scroll")); });
    await page.waitForFunction(() => document.querySelectorAll(".following-account").length === 0);
    await page.evaluate(() => { history.pushState({}, "", "/me/following"); dispatchEvent(new Event("scroll")); });
    await page.locator(".following-account").waitFor();
    await page.locator(".following-account button").click();
    await page.waitForFunction(() => document.getElementById("following-status").textContent.includes("弹窗"));
    await page.evaluate(() => document.querySelector('[data-testid="carol-unfollow"]').setAttribute("data-testid", "carol-follow"));
    await page.waitForFunction(() => document.querySelectorAll(".following-account").length === 0 && document.getElementById("following-status").textContent.includes("0 个未显示"));
    await page.evaluate(() => { document.getElementById("following-view").hidden = true; });
    await page.evaluate(() => { document.querySelector('[data-testid="carol-follow"]').setAttribute("data-testid", "carol-unfollow"); });
    await page.waitForTimeout(300);
    assert.equal(await page.locator(".following-account").count(), 0, "隐藏视图不自动填充");
    await page.evaluate(() => { document.getElementById("following-view").hidden = false; });
    await page.locator(".following-account").waitFor();
    assert.deepEqual(errors, []);
    console.log("✓ 未回关浏览器回归：自动读取、滚动识别、异步标记更新、页面隔离、确认后刷新、视图恢复。");
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
