const { chromium } = require("playwright");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const root = path.resolve(__dirname, "../extension");
const artifacts = path.resolve(__dirname, "../artifacts");

async function main() {
  const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
  try {
    const context = await browser.newContext({ viewport: { width: 320, height: 900 }, acceptDownloads: true });
    const errors = [];
    context.on("page", page => page.on("pageerror", error => errors.push(error.message)));
    await context.route("**/*", route => route.abort());
    const tweet = (handle, id, text, extra = "") => `<article data-testid="tweet"><div data-testid="User-Name">Name @${handle}<a href="/${handle}/status/${id}"><time datetime="2026-10-24T01:00:00Z">1d</time></a></div>${text ? `<div data-testid="tweetText">${text}</div>` : ""}${extra}<button data-testid="reply" aria-label="0 Replies"></button><button data-testid="like" aria-label="12 Likes"></button><button data-testid="unretweet" aria-label="3 Reposts"></button><a href="/${handle}/status/${id}/analytics" aria-label="View post analytics">1.2K</a></article>`;
    const quote = `<div role="link" data-testid="quoteTweet"><div data-testid="User-Name">Quoted @other</div><div data-testid="tweetText">引用原帖的文字</div><div data-testid="tweetPhoto"></div><button data-testid="like" aria-label="9999 Likes"></button></div>`;
    const fixture = `<a data-testid="AppTabBar_Profile_Link" href="/Me">Me</a><main data-testid="primaryColumn">${tweet("ME", "1234567890123456789", '第一行<br>第二行<img alt="😀">', '<div data-testid="tweetPhoto"></div><a data-testid="tweet-text-show-more-link">Show more</a>')}${tweet("me", "2", "自己的引用评论", quote)}${tweet("me", "3", "", quote)}${tweet("other", "4", "他人帖子（本人转发）")}${tweet("other", "5", "他人引用本人", `<div role="link">${tweet("me", "6", "被引用的本人帖")}</div>`)}</main>`;
    await context.route("https://x.com/**", route => route.fulfill({ contentType: "text/html;charset=utf-8", body: fixture }));
    await context.addInitScript(() => {
      const listeners = [];
      const storageListeners = [];
      window.__listeners = listeners;
      window.__local = {};
      try { window.__local = JSON.parse(sessionStorage.getItem("test-storage") || "{}"); } catch { /* about:blank 没有存储权限。 */ }
      window.__data = null;
      window.__failure = false;
      window.__sent = [];
      window.__impressions = [];
      window.__account = "me";
      window.chrome = {
        runtime: { id: "self", onMessage: { addListener: listener => listeners.push(listener) }, openOptionsPage: async () => {},
          sendMessage: async message => {
            if (message.type === "GET_ANALYTICS_PROFILE") return { ok: true, owner: "me" };
            if (message.type === "ADD_ORIGINAL_IMPRESSIONS") {
              const { validateImpression, mergeImpressions } = await import("./analytics-data.js");
              const row = validateImpression({ ...message.data, source: "manual" });
              const key = `analytics:${row.owner}`;
              const saved = window.__local[key] || { owner: row.owner, posts: [] };
              await chrome.storage.local.set({ [key]: { ...saved, impressions: mergeImpressions(saved.impressions || [], [row]) } });
              return { ok: true };
            }
            if (message.type === "SAVE_ORIGINAL_IMPRESSIONS") {
              if (window.__failure) throw new Error("模拟保存失败");
              window.__impressions.push(structuredClone(message.data));
              return { ok: true };
            }
            if (message.type === "SAVE_OWN_POSTS") {
              if (window.__failure) throw new Error("模拟保存失败");
              window.__sent.push(structuredClone(message.data));
              return { ok: true };
            }
            if (message.type === "LOAD_OWN_POSTS") return { ok: true, owner: message.owner, posts: window.__local[`analytics:${message.owner}`]?.posts || [], impressions: window.__local[`analytics:${message.owner}`]?.impressions || [], pending: 0, error: "" };
            if (message.type === "CLEAR_OWN_POSTS") { await chrome.storage.local.remove(`analytics:${message.owner}`); return { ok: true }; }
          }
        },
        storage: {
          local: {
            get: async key => ({ [key]: structuredClone(window.__local[key]) }),
            set: async data => {
              if (window.__failure) throw new Error("模拟存储空间不足");
              const changes = Object.fromEntries(Object.entries(data).map(([key, value]) => [key, { oldValue: window.__local[key], newValue: structuredClone(value) }]));
              Object.assign(window.__local, structuredClone(data));
              sessionStorage.setItem("test-storage", JSON.stringify(window.__local));
              storageListeners.forEach(listener => listener(changes, "local"));
            },
            remove: async key => { delete window.__local[key]; sessionStorage.setItem("test-storage", JSON.stringify(window.__local)); }
          },
          onChanged: { addListener: listener => storageListeners.push(listener) }
        },
        windows: { getCurrent: async () => ({ id: 1 }) },
        permissions: { contains: async () => true, request: async () => true },
        tabs: { onUpdated: { addListener() {} }, onActivated: { addListener() {} }, query: async () => [{ id: 1, url: "https://x.com/me" }], sendMessage: async (_, message) => {
          window.__lastMessage = message;
          return message.type === "GET_OWN_POSTS_OWNER" ? { ok: true, owner: window.__account } : { ok: true };
        } }
      };
      window.__request = (message, id = "self") => {
        let result;
        listeners.forEach(listener => listener(message, { id }, value => { result = value; }));
        return result;
      };
    });
    const x = await context.newPage();
    await x.goto("https://x.com/Me");
    await x.addScriptTag({ path: path.join(root, "analytics-content.js") });
    await x.waitForFunction(() => window.__request({ type: "GET_OWN_POSTS_OWNER" })?.ok);
    const data = await x.evaluate(() => window.__request({ type: "COLLECT_OWN_POSTS" }));
    assert.equal(data.ok, true);
    assert.equal(data.owner, "me");
    assert.deepEqual(data.posts.map(post => post.id), ["1234567890123456789", "2", "3"]);
    assert.equal(data.posts[0].text, "第一行\n第二行😀");
    assert.equal(data.posts[0].textMayBeTruncated, true);
    assert.equal(data.posts[0].hasImage, true);
    assert.deepEqual(data.posts[0].metrics, { replies: 0, reposts: 3, likes: 12, bookmarks: null, views: 1200 });
    assert.equal(data.posts[1].text, "自己的引用评论");
    assert.equal(data.posts[1].quote, "引用原帖的文字");
    assert.equal(data.posts[1].isQuote, true);
    assert.equal(data.posts[1].metrics.likes, 12, "排除引用卡片中的他人指标");
    assert.equal(data.posts[1].hasImage, false, "引用原帖媒体不冒充本人配图");
    assert.equal(data.posts[2].text, "");
    assert.equal(data.posts[2].quote, "引用原帖的文字");
    await x.waitForFunction(() => window.__sent.length === 1);
    assert.equal((await x.evaluate(() => window.__sent[0].posts)).length, 3, "不开侧栏也应自动采集");
    await x.evaluate(() => { for (let i = 0; i < 10; i++) dispatchEvent(new Event("scroll")); });
    await x.waitForTimeout(1000);
    assert.equal(await x.evaluate(() => window.__sent.length), 1, "互动未变化不重复保存");
    await x.locator('[data-testid="like"]').first().evaluate(node => node.setAttribute("aria-label", "20 Likes"));
    await x.waitForTimeout(1000);
    assert.equal(await x.evaluate(() => window.__sent.length), 1, "仅 DOM 变化不触发采集");
    await x.evaluate(() => dispatchEvent(new WheelEvent("wheel")));
    await x.waitForFunction(() => window.__sent.length === 2);
    assert.equal((await x.evaluate(() => window.__sent.at(-1).posts))[0].metrics.likes, 20, "互动变化自动更新");
    await x.locator("main").evaluate((node, html) => node.insertAdjacentHTML("beforeend", html), tweet("me", "7", "滚动加载的新帖", quote));
    await x.evaluate(() => dispatchEvent(new Event("scroll")));
    await x.waitForFunction(() => window.__sent.some(batch => batch.posts.some(post => post.id === "7")));
    await x.evaluate(() => dispatchEvent(new WheelEvent("wheel")));
    await x.locator("main").evaluate((node, html) => node.insertAdjacentHTML("beforeend", html), tweet("me", "10", "滚轮后异步加载"));
    await x.waitForFunction(() => window.__sent.some(batch => batch.posts.some(post => post.id === "10")));
    assert.equal(await x.evaluate(() => window.__sent.flatMap(batch => batch.posts).some(post => ["4", "5", "6"].includes(post.id))), false);
    assert.equal(await x.evaluate(() => window.__request({ type: "COLLECT_OWN_POSTS" }, "external")), undefined);
    for (const [label, expected] of [["1,234 Likes", 1234], ["1.5万 次浏览", 15000], ["2M views", 2000000], ["1\u202f234 views", 1234], ["2 Bookmarks", 2], ["1.2B Views", 1200000000], ["Likes", null]]) {
      await x.locator('[data-testid="like"]').first().evaluate((node, value) => node.setAttribute("aria-label", value), label);
      const result = await x.evaluate(() => window.__request({ type: "COLLECT_OWN_POSTS" }));
      assert.equal(result.posts[0].metrics.likes, expected, label);
    }
    await x.evaluate(() => history.pushState({}, "", "/other"));
    assert.equal((await x.evaluate(() => window.__request({ type: "COLLECT_OWN_POSTS" }))).ok, false);
    await x.locator("main").evaluate((node, html) => node.insertAdjacentHTML("beforeend", html), tweet("me", "8", "不在本人主页时不得采集"));
    await x.evaluate(() => dispatchEvent(new Event("scroll")));
    await x.waitForTimeout(600);
    assert.equal(await x.evaluate(() => window.__sent.flatMap(batch => batch.posts).some(post => post.id === "8")), false);
    await x.evaluate(() => history.pushState({}, "", "/ME/with_replies"));
    await x.waitForFunction(() => window.__sent.some(batch => batch.posts.some(post => post.id === "8")));
    await x.locator("main").evaluate((node, html) => node.insertAdjacentHTML("beforeend", html), tweet("me", "9", "虚拟列表移走前缓存"));
    await x.evaluate(() => dispatchEvent(new Event("scroll")));
    await x.locator('a[href="/me/status/9"]').evaluate(node => node.closest("article").remove());
    await x.waitForFunction(() => window.__sent.some(batch => batch.posts.some(post => post.id === "9")));
    await x.evaluate(() => { window.__failure = true; });
    await x.locator('[data-testid="like"]').first().evaluate(node => node.setAttribute("aria-label", "30 Likes"));
    await x.evaluate(() => dispatchEvent(new WheelEvent("wheel")));
    await x.waitForTimeout(600);
    await x.evaluate(() => { window.__failure = false; dispatchEvent(new Event("online")); });
    await x.waitForFunction(() => window.__sent.some(batch => batch.posts.some(post => post.metrics.likes === 30)));
    await x.locator('[data-testid="AppTabBar_Profile_Link"]').evaluate(node => node.remove());
    assert.equal((await x.evaluate(() => window.__request({ type: "COLLECT_OWN_POSTS" }))).ok, true, "配置主页无需依赖登录账号导航链接");
    await x.evaluate(() => window.__request({ type: "ANALYTICS_PROFILE", ok: true, owner: "second" }));
    assert.equal((await x.evaluate(() => window.__request({ type: "COLLECT_OWN_POSTS" }))).ok, false, "修改配置后停止采集旧主页");
    console.log("✓ 网页自动采集：无需侧栏、滚动新增、同帖互动变化才更新、本人身份与引用卡片隔离");

    const rewards = await context.newPage();
    await rewards.goto("https://x.com/me");
    await rewards.addScriptTag({ path: path.join(root, "analytics-content.js") });
    await rewards.evaluate(() => {
      history.pushState({}, "", "/i/monetization/original-content-rewards");
      document.querySelector("main").innerHTML = '<h1>Check back later</h1><div>500 Verified followers</div><section id="reward"><div><span>Have at least 500K Verified Home Timeline impressions in the last 90 days</span></div><div><div role="progressbar" aria-valuenow="23600"></div><span id="exposure">23.6K</span></div><p>Does not include replies</p></section>';
    });
    await rewards.waitForFunction(() => window.__impressions.length === 1);
    assert.equal((await rewards.evaluate(() => window.__impressions[0])).value, 23600, "采集实际数值而非500K门槛");
    await rewards.waitForTimeout(1100);
    assert.equal(await rewards.evaluate(() => window.__impressions.length), 1);
    await rewards.evaluate(() => { window.__failure = true; document.getElementById("exposure").textContent = "24K"; });
    await rewards.waitForTimeout(600);
    assert.equal(await rewards.evaluate(() => window.__impressions.length), 1);
    await rewards.evaluate(() => { window.__failure = false; });
    await rewards.waitForFunction(() => window.__impressions.length === 2);
    await rewards.evaluate(() => { document.querySelector('[data-testid="AppTabBar_Profile_Link"]').href = "/other"; document.getElementById("exposure").textContent = "25K"; });
    await rewards.waitForTimeout(1100);
    assert.equal(await rewards.evaluate(() => window.__impressions.length), 2, "不采集其他登录账号的奖励数据");
    await rewards.evaluate(() => { document.querySelector('[data-testid="AppTabBar_Profile_Link"]').href = "/me"; document.querySelector("#reward span").textContent = "过去90天已认证用户首页时间线曝光次数至少达到50万"; document.getElementById("exposure").textContent = "2.5万"; });
    await rewards.waitForFunction(() => window.__impressions.length === 3);
    assert.equal(await rewards.evaluate(() => window.__impressions.at(-1).value), 25000);
    await rewards.close();

    const cutoff = await context.newPage();
    await cutoff.goto("https://x.com/me");
    await cutoff.evaluate(() => {
      window.__now = "2026-10-30T01:59:59Z";
      const NativeDate = Date;
      window.Date = class extends NativeDate {
        constructor(...args) { super(...(args.length ? args : [window.__now])); }
        static now() { return NativeDate.parse(window.__now); }
      };
      history.pushState({}, "", "/i/monetization/original-content-rewards");
      document.querySelector("main").innerHTML = '<section><span>Verified Home Timeline impressions in the last 90 days</span><span id="cutoff-value">26K</span></section>';
    });
    await cutoff.addScriptTag({ path: path.join(root, "analytics-content.js") });
    await cutoff.waitForFunction(() => window.__impressions.length === 1);
    await cutoff.evaluate(() => { window.__now = "2026-10-30T02:00:00Z"; });
    await cutoff.waitForFunction(() => window.__impressions.length === 2);
    await cutoff.evaluate(() => { document.getElementById("cutoff-value").textContent = "27K"; });
    await cutoff.waitForFunction(() => window.__impressions.length === 3);
    assert.equal(await cutoff.evaluate(() => window.__impressions.at(-1).value), 27000, "10点后延迟更新仍会采集");
    await cutoff.close();

    for (const mode of ["missing-id", "post-send", "impression-send", "profile-send"]) {
      const stale = await context.newPage();
      await stale.goto("https://x.com/me");
      await stale.evaluate(mode => {
        window.__staleWarnings = [];
        window.__staleSends = 0;
        console.warn = (...args) => window.__staleWarnings.push(args.map(String).join(" "));
        const send = chrome.runtime.sendMessage;
        chrome.runtime.sendMessage = message => {
          if (message.type === "GET_ANALYTICS_PROFILE" && mode !== "profile-send") return send(message);
          window.__staleSends++;
          throw new Error("Extension context invalidated.");
        };
        if (mode === "impression-send") {
          history.pushState({}, "", "/i/monetization/original-content-rewards");
          document.querySelector("main").innerHTML = '<section><span>Verified Home Timeline impressions in the last 90 days</span><span>23.6K</span></section>';
        }
      }, mode);
      await stale.addScriptTag({ path: path.join(root, "analytics-content.js") });
      if (mode === "missing-id") await stale.evaluate(() => { chrome.runtime.id = undefined; });
      await stale.waitForTimeout(1100);
      const attempts = await stale.evaluate(() => window.__staleSends);
      assert.equal(attempts, mode === "missing-id" ? 0 : 1, mode);
      await stale.evaluate(() => {
        for (const event of ["wheel", "scroll", "popstate", "online", "pagehide"]) dispatchEvent(new Event(event));
        history.pushState({}, "", "/me/with_replies");
      });
      await stale.waitForTimeout(5500);
      assert.equal(await stale.evaluate(() => window.__staleSends), attempts, `${mode} 失效后不再发送或重试`);
      assert.deepEqual(await stale.evaluate(() => window.__staleWarnings), [], `${mode} 失效不重复报错`);
      await stale.close();
    }
    console.log("✓ 扩展重新加载：runtime ID 消失、发送时失效、曝光与初始化失效均停止旧脚本且无重试报错");

    await context.route("https://extension.test/**", route => {
      const file = path.resolve(root, "." + new URL(route.request().url()).pathname);
      if (!file.startsWith(root + path.sep) || !fs.existsSync(file)) return route.fulfill({ status: 404, body: "" });
      // 本回归专门加载数据功能与共用视图切换，不运行评论生成和未回关逻辑。
      const skip = ["sidepanel.js", "following-panel.js", "options.js"].includes(path.basename(file));
      return route.fulfill({ contentType: { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" }[path.extname(file)] || "text/plain", body: skip ? "" : fs.readFileSync(file) });
    });
    const panel = await context.newPage();
    await panel.goto("https://extension.test/sidepanel.html");
    await panel.evaluate(async data => { await chrome.storage.local.set({ "analytics:me": { owner: "me", posts: data.posts, pending: [] }, analyticsOwner: "me", analyticsProfileUrl: "https://x.com/me" }); }, data);
    await panel.locator("#view-analytics").click();
    await panel.waitForFunction(() => document.querySelectorAll(".analytics-post").length === 3);
    assert.equal(await panel.locator("#analytics-sort").inputValue(), "time");
    await panel.evaluate(async () => {
      const saved = window.__local["analytics:me"];
      saved.impressions = [{ owner: "me", date: "2026-10-29", value: 23600, raw: "23.6K", collectedAt: "2026-10-29T01:00:00Z" }];
      saved.posts[2].publishedAt = "2026-10-29T01:00:00Z";
      await chrome.storage.local.set({ "analytics:me": saved });
    });
    await panel.waitForFunction(() => document.getElementById("analytics-impressions").textContent.includes("23.6K"));
    assert(await panel.locator("#analytics-impressions-card").isVisible());
    assert.equal(await panel.locator("#analytics-impressions-value").textContent(), "23.6K");
    assert((await panel.locator("#analytics-impressions-date").textContent()).includes("2026-10-29"));
    assert.equal(await panel.locator("#analytics-impressions-value").evaluate(node => getComputedStyle(node).fontSize), "42px");
    assert(await panel.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "曝光卡片320px无水平溢出");
    await panel.screenshot({ path: path.join(artifacts, "analytics-impressions-card.png"), fullPage: true });
    assert.equal(await panel.locator(".analytics-post a").first().getAttribute("href"), "https://x.com/me/status/3", "新帖默认排在前面");
    await panel.evaluate(async data => {
      const saved = window.__local["analytics:me"];
      saved.posts = data.posts;
      await chrome.storage.local.set({ "analytics:me": saved });
    }, data);
    assert.equal(await panel.locator("#analytics-summary").textContent().then(text => text.includes("收藏 未显示")), true);
    assert.equal(await panel.locator("#analytics-collect").count(), 0, "不需要手动采集按钮");
    await panel.locator("#analytics-tab-analysis").click();
    assert(await panel.locator("#analytics-analysis-page").isVisible());
    assert.equal(await panel.locator("#analytics-metrics strong").allTextContents().then(values => values[0]), "3,600");
    assert((await panel.locator("#analytics-metrics article").first().textContent()).includes("篇均 1,200"));
    assert.equal(await panel.locator("#analytics-hours meter").count(), 1);
    assert.equal(await panel.locator("#analytics-hours meter").getAttribute("value"), "1200");
    assert(await panel.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "分析页320px无水平溢出");
    fs.mkdirSync(artifacts, { recursive: true });
    await panel.screenshot({ path: path.join(artifacts, "analytics-analysis.png"), fullPage: true });
    await panel.locator("#analytics-tab-posts").click();
    assert(await panel.locator("#analytics-posts-page").isVisible());
    await panel.evaluate(async () => {
      const saved = structuredClone(window.__local["analytics:me"]);
      saved.posts[0].metrics.views = 9999;
      saved.pending = [saved.posts[0].id];
      await chrome.storage.local.set({ "analytics:me": saved });
    });
    await panel.waitForFunction(() => document.getElementById("analytics-summary").textContent.includes("12,399"));
    assert.equal(await panel.locator("#analytics-metrics strong").first().textContent(), "12,399", "采集更新时分析同步刷新");
    assert.equal(await panel.locator(".analytics-post a").first().getAttribute("href"), data.posts[0].url);
    await panel.locator("#analytics-sort").selectOption("rate");
    assert.equal(await panel.locator(".analytics-post a").first().getAttribute("href"), "https://x.com/me/status/2");
    const downloadPromise = panel.waitForEvent("download");
    await panel.locator("#analytics-json").click();
    const download = await downloadPromise;
    const exported = JSON.parse(fs.readFileSync(await download.path(), "utf8"));
    assert.equal(exported.posts.length, 3);
    assert.equal(exported.posts[0].id, "1234567890123456789");
    assert.equal(exported.impressions[0].value, 23600);
    await panel.locator("#analytics-impressions-manual summary").click();
    await panel.locator("#analytics-impressions-input-date").fill("2026-10-28");
    await panel.locator("#analytics-impressions-input-value").fill("22000");
    await panel.locator("#analytics-impressions-save").click();
    await panel.waitForFunction(() => document.getElementById("analytics-status").textContent.includes("已保存 2026-10-28"));
    assert.equal(await panel.locator("#analytics-impressions-value").textContent(), "23.6K", "补历史不替换最新日期卡片");
    await panel.locator("#analytics-impressions-input-date").fill("2026-10-29");
    await panel.locator("#analytics-impressions-input-value").fill("26000");
    await panel.locator("#analytics-impressions-save").click();
    await panel.waitForFunction(() => document.getElementById("analytics-impressions-value").textContent === "26000");
    await panel.waitForFunction(() => !document.getElementById("analytics-impressions-save").disabled);
    await panel.locator("#analytics-impressions-input-value").fill("27000");
    await panel.locator("#analytics-impressions-save").click();
    await panel.waitForFunction(() => document.getElementById("analytics-impressions-value").textContent === "27000");
    assert.equal(await panel.evaluate(() => window.__local["analytics:me"].impressions.length), 2, "修正同日保持单条");
    assert(await panel.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "手动补录表单320px无水平溢出");
    const csvPromise = panel.waitForEvent("download");
    await panel.locator("#analytics-csv").click();
    const csvDownload = await csvPromise;
    assert(fs.readFileSync(await csvDownload.path(), "utf8").includes("引用原帖的文字"));
    await panel.evaluate(async () => { await chrome.storage.local.set({ analyticsSync: { owner: "me", error: "网络离线", syncedAt: null } }); });
    await panel.waitForFunction(() => document.getElementById("analytics-status").textContent.includes("自动重试"));
    assert.equal((await panel.evaluate(() => window.__local["analytics:me"])).posts[0].metrics.views, 9999);
    await panel.evaluate(async data => {
      window.__account = "second";
      await chrome.storage.local.set({ "analytics:second": { owner: "second", posts: [{ ...data.posts[0], owner: "second", url: `https://x.com/second/status/${data.posts[0].id}` }], pending: [] }, analyticsOwner: "second", analyticsProfileUrl: "https://x.com/second" });
    }, data);
    await panel.waitForFunction(() => document.getElementById("analytics-owner").textContent.includes("@second"));
    assert(!(await panel.locator("#analytics-impressions-card").isVisible()), "切换账号不展示旧账号曝光");
    assert.equal(await panel.locator(".analytics-post").count(), 1);
    assert.equal((await panel.evaluate(() => window.__local["analytics:me"])).posts.length, 3, "账号独立保存");
    await panel.reload();
    await panel.evaluate(() => { window.__account = "second"; });
    await panel.locator("#view-analytics").click();
    await panel.waitForFunction(() => document.getElementById("analytics-owner").textContent.includes("@second"));
    assert.equal(await panel.locator(".analytics-post").count(), 1, "重新打开恢复本机记录");
    assert.equal(await panel.locator("#analytics-refresh").count(), 0, "无服务端读取按钮");
    assert.equal(await panel.locator("#analytics-profile-form").count(), 0, "主页配置集中在设置页");
    const profileOptions = await context.newPage();
    await profileOptions.goto("https://extension.test/options.html");
    await profileOptions.waitForFunction(() => document.getElementById("analytics-profile-url").value === "https://x.com/1nhkjltx");
    await profileOptions.locator("#analytics-profile-url").fill("https://x.com/home");
    await profileOptions.locator("#analytics-profile-save").click();
    await profileOptions.waitForFunction(() => document.getElementById("analytics-profile-status").classList.contains("error"));
    assert.equal(await profileOptions.evaluate(() => window.__local.analyticsProfileUrl), undefined, "非法主页不保存");
    await profileOptions.locator("#analytics-profile-url").fill("https://twitter.com/THIRD/");
    await profileOptions.locator("#analytics-profile-save").click();
    await profileOptions.waitForFunction(() => window.__local.analyticsProfileUrl === "https://x.com/third");
    assert.equal(await profileOptions.evaluate(() => window.__local.postService), undefined, "保存主页不依赖服务连接");
    await profileOptions.reload();
    await profileOptions.waitForFunction(() => document.getElementById("analytics-profile-url").value === "https://x.com/third");
    await panel.evaluate(async url => chrome.storage.local.set({ analyticsProfileUrl: url }), await profileOptions.evaluate(() => window.__local.analyticsProfileUrl));
    await panel.waitForFunction(() => document.getElementById("analytics-owner").textContent.includes("@third"));
    await panel.locator("#analytics-tab-analysis").click();
    assert(await panel.locator("#analytics-analysis-page").isVisible());
    assert(!(await panel.locator("#analytics-posts-page").isVisible()));
    assert.equal(await panel.locator("#analytics-tab-analysis").getAttribute("aria-pressed"), "true");
    assert.equal(await panel.locator("#analytics-metrics strong").allTextContents().then(values => values.every(value => value === "未显示")), true);
    assert(await panel.locator("#analytics-hours-empty").isVisible());
    await panel.evaluate(async () => chrome.storage.local.set({ analyticsProfileUrl: "https://x.com/second" }));
    await panel.waitForFunction(() => document.querySelectorAll(".analytics-post").length === 1);
    assert(await panel.locator("#analytics-analysis-page").isVisible(), "账号切换保留当前分析页");
    await panel.locator("#analytics-tab-posts").click();
    await panel.locator("#analytics-open").click();
    await panel.waitForFunction(() => window.__lastMessage?.type === "OPEN_OWN_POSTS");
    assert(await panel.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "320px侧栏无水平溢出");
    fs.mkdirSync(artifacts, { recursive: true });
    await panel.screenshot({ path: path.join(artifacts, "analytics-panel.png"), fullPage: true });
    panel.once("dialog", dialog => dialog.dismiss());
    await panel.locator("#analytics-clear").click();
    await panel.waitForFunction(() => !document.getElementById("analytics-clear").disabled);
    assert.equal(await panel.locator(".analytics-post").count(), 1);
    panel.once("dialog", dialog => dialog.accept());
    await panel.locator("#analytics-clear").click();
    await panel.waitForFunction(() => document.querySelectorAll(".analytics-post").length === 0);
    assert.equal((await panel.evaluate(() => window.__local["analytics:me"])).posts.length, 3);
    await panel.locator("#analytics-tab-analysis").click();
    assert(await panel.locator("#analytics-hours-empty").isVisible(), "清除缓存后分析同步清空");
    assert.equal(await panel.locator("#analytics-metrics strong").first().textContent(), "未显示");
    await panel.locator("#view-following").click();
    assert(!(await panel.locator("#analytics-view").isVisible()));
    await panel.locator("#view-comments").click();
    assert(await panel.locator("#comments-view").isVisible());
    await context.route("http://127.0.0.1:12345/**", async route => {
      assert.equal(route.request().headers().authorization, undefined);
      await route.fulfill({ headers: { "Access-Control-Allow-Origin": "*" }, json: { posts: [], nextCursor: null } });
    });
    const localOptions = await context.newPage();
    await localOptions.addInitScript(() => { chrome.storage.local.setAccessLevel = async () => {}; });
    await localOptions.goto("https://extension.test/options.html");
    await localOptions.waitForFunction(() => document.getElementById("posts-base-url").value === "http://127.0.0.1:12345");
    assert.equal(await localOptions.locator("#posts-token").getAttribute("required"), null);
    await localOptions.locator("#posts-save").click();
    await localOptions.waitForFunction(() => window.__local.postService?.baseUrl === "http://127.0.0.1:12345");
    assert.equal(await localOptions.evaluate(() => window.__local.postService.token), "");
    await localOptions.locator("#posts-base-url").fill("https://remote.test");
    await localOptions.locator("#posts-token").fill("a".repeat(32));
    await localOptions.locator("#posts-disconnect").click();
    assert.equal(await localOptions.locator("#posts-base-url").inputValue(), "http://127.0.0.1:12345");
    assert.equal(await localOptions.locator("#posts-token").inputValue(), "");
    assert.deepEqual(errors, []);
    console.log("✓ 数据侧栏：自动刷新、上传失败提示、主页配置、返回主页自动采集、排序、账号隔离、导出与320px布局");
    console.log("✓ 本地服务默认配置、空 Token 保存、无鉴权头请求与恢复本地默认");
  } finally { await browser.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
