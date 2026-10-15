const { chromium } = require("playwright");
const assert = require("assert").strict;
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "../extension");
const artifacts = path.resolve(__dirname, "../artifacts");
const post = { url: "https://x.com/alice/status/123", author: "Alice @alice", text: "先把一件小事做好，比同时开始十件事更难。", quote: "少做一点，但要完整。", hasMedia: false };
const replies = { replies: [
  { text: "完整做完一次，才能发现真正的阻力在哪；取舍本身也是一种能力。" },
  { text: "最难的常常是忍住再加一个功能的冲动。" },
  { text: "你会如何判断一件小事已经做到足够好，可以开始下一件了？" }
] };
const bilingual = { replies: [
  { text: "Doing one small thing well gives the next step a firmer foundation. Progress can be quiet and still be meaningful.", translation: "认真做好一件小事，能让下一步走得更稳。进步可以安静，却依然有分量。" },
  { text: "The hardest part is often resisting one more feature. Keeping a clear boundary leaves room to finish what matters.", translation: "最难的常常是忍住再加一个功能。守住清晰的边界，才有余力把重要的事做完。" },
  { text: "What would tell you this version is useful enough to move forward? One concrete signal may help more than a longer feature list.", translation: '什么信号能让你判断，这个版本已经足够有用，可以继续向前？一个具体反馈，或许比更长的功能清单更有帮助。<img src=x onerror="alert(1)">' }
] };

async function main() {
  fs.mkdirSync(artifacts, { recursive: true });
  let browser;
  try {
    browser = await chromium.launch({
      headless: true,
      ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {})
    });
    const context = await browser.newContext({ viewport: { width: 380, height: 980 } });
    const origin = "https://extension.test";
    await context.route(origin + "/**", async route => {
      const file = path.resolve(root, "." + new URL(route.request().url()).pathname);
      if (!file.startsWith(root + path.sep) || !fs.existsSync(file)) {
        await route.fulfill({ status: 404, body: "Not found" }); return;
      }
      const contentType = { ".js": "text/javascript", ".css": "text/css", ".html": "text/html" }[path.extname(file)] || "text/plain";
      await route.fulfill({ contentType, body: fs.readFileSync(file) });
    });
    const errors = [];
    context.on("page", page => page.on("pageerror", error => errors.push(error.message)));
    await context.addInitScript(({ post }) => {
      const listeners = [];
      const local = {};
      const session = {};
      const activated = [];
      const messages = [];
      function area(data, name) {
        return {
          async get(keys) {
            if (!keys) return structuredClone(data);
            const names = typeof keys === "string" ? [keys] : keys;
            return structuredClone(Object.fromEntries(names.filter(key => key in data).map(key => [key, data[key]])));
          },
          async set(values) {
            const changes = {};
            Object.entries(values).forEach(([key, value]) => {
              changes[key] = { oldValue: data[key], newValue: structuredClone(value) }; data[key] = structuredClone(value);
            });
            listeners.forEach(listener => listener(changes, name));
          },
          async remove(keys) {
            const changes = {};
            for (const key of [].concat(keys)) { changes[key] = { oldValue: data[key] }; delete data[key]; }
            listeners.forEach(listener => listener(changes, name));
          },
          async setAccessLevel() {}
        };
      }
      window.__mock = { local, session, selected: 1, sent: [], post, clipboard: "", allowed: true,
        currentPost: location.search === "?recover" ? { ...post, url: "", text: "已经打开的回复弹窗" } : null };
      Object.defineProperty(navigator, "clipboard", { value: { writeText: async value => { window.__mock.clipboard = value; } }, configurable: true });
      window.chrome = {
        storage: { local: area(local, "local"), session: area(session, "session"), onChanged: { addListener: listener => listeners.push(listener) } },
        permissions: { contains: async () => window.__mock.allowed, request: async () => window.__mock.allowed },
        windows: { getCurrent: async () => ({ id: 1 }) },
        tabs: {
          query: async () => [{ id: window.__mock.selected, url: "https://x.com/home" }],
          sendMessage: async () => {
            if (window.__mock.disconnected) throw new Error("Could not establish connection. Receiving end does not exist.");
            return { ok: true, post: window.__mock.currentPost || null };
          },
          onActivated: { addListener: listener => activated.push(listener) }
        },
        runtime: {
          id: "test-extension",
          onMessage: { addListener: listener => messages.push(listener) },
          openOptionsPage: async () => { window.__mock.optionsOpened = true; },
          sendMessage: (message, callback) => { window.__mock.sent.push(message); callback({ ok: true }); }
        }
      };
      window.__activate = id => { window.__mock.selected = id; activated.forEach(listener => listener({ tabId: id, windowId: 1 })); };
      window.__readCurrent = () => {
        let response;
        messages.forEach(listener => listener({ type: "GET_CURRENT_POST" }, { id: "test-extension" }, value => { response = value; }));
        return response;
      };
    }, { post });

    const page = await context.newPage();
    await page.goto(origin + "/sidepanel.html");
    await page.waitForSelector("#setup:not([hidden])");
    assert(await page.locator("#empty").isVisible());
    await page.locator("#configure").click();
    assert(await page.evaluate(() => window.__mock.optionsOpened));
    await page.evaluate(async () => { await chrome.storage.session.set({ "post:1": window.__mock.post }); });
    await page.waitForSelector("#source:not([hidden])");
    assert(await page.locator("#generate").isDisabled());
    assert.equal(await page.locator("#post-text").innerText(), post.text);
    await page.screenshot({ path: path.join(artifacts, "panel-setup.png"), fullPage: true });

    let requests = 0;
    let mode = "normal";
    await context.route("https://api.deepseek.com/**", async route => {
      requests++;
      if (mode === "delayed") await new Promise(resolve => setTimeout(resolve, 400));
      if (mode === "401") { await route.fulfill({ status: 401, body: "unauthorized" }); return; }
      const content = mode === "wrapped" ? `以下是三条评论：\n\`\`\`json\n${JSON.stringify(replies)}\n\`\`\`` :
        mode === "numbered" ? replies.replies.map((item, index) => `${index + 1}. ${item.text}`).join("\n\n") :
        mode === "malformed" ? '这里只有一条评论。<img src=x onerror="alert(1)">' : JSON.stringify(mode === "bilingual" ? bilingual : replies);
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ choices: [{ message: { content } }] }) });
    });
    await page.evaluate(async () => {
      await chrome.storage.local.set({ settings: { baseUrl: "https://api.deepseek.com", model: "deepseek-flash", apiKey: "test-key", language: "auto", preferences: "简洁自然" } });
    });
    await page.waitForFunction(() => !document.getElementById("generate").disabled);
    await page.locator("#generate").click();
    await page.waitForSelector("#results:not([hidden])");
    assert.equal(await page.locator(".reply-card").count(), 3);
    await page.locator(".reply-text").first().fill("我自己修改过的评论。<script>alert('xss')</script>");
    await page.locator(".copy-button").first().click();
    assert.equal(await page.evaluate(() => window.__mock.clipboard), "我自己修改过的评论。<script>alert('xss')</script>");
    assert.equal(await page.locator("#reply-list script").count(), 0);
    await page.locator(".reply-text").first().fill(replies.replies[0].text);
    await page.screenshot({ path: path.join(artifacts, "panel-results.png"), fullPage: true });
    const before = requests;
    await page.evaluate(async () => { await chrome.storage.session.set({ "post:1": window.__mock.post }); });
    await page.waitForTimeout(100);
    assert.equal(requests, before, "重复选择同帖不能重复计费");

    mode = "delayed";
    await page.locator("#generate").click();
    await page.evaluate(async () => {
      await chrome.storage.session.set({ "post:2": { ...window.__mock.post, url: "https://x.com/bob/status/456", text: "另一条帖子" } });
      window.__activate(2);
    });
    await page.waitForFunction(() => document.getElementById("post-text").textContent === "另一条帖子");
    await page.waitForSelector("#results:not([hidden])");
    assert.equal(await page.evaluate(() => window.__mock.session["draft:2"].key.includes("另一条帖子")), true);
    await page.evaluate(() => window.__activate(1));
    await page.waitForFunction(text => document.getElementById("post-text").textContent === text, post.text);
    const cachedCount = requests;
    await page.waitForTimeout(100);
    assert.equal(requests, cachedCount, "切回有缓存的标签页不能重复计费");

    mode = "401";
    await page.locator("#generate").click();
    await page.waitForSelector("#status.error");
    assert.match(await page.locator("#status").innerText(), /Key/);
    assert(!(await page.locator("#generate").isDisabled()));
    for (const responseMode of ["wrapped", "numbered"]) {
      mode = responseMode;
      await page.locator("#generate").click();
      await page.waitForSelector("#results:not([hidden])");
      assert.equal(await page.locator(".reply-card").count(), 3);
    }
    mode = "malformed";
    await page.locator("#generate").click();
    await page.waitForSelector("#model-response:not([hidden])");
    await page.locator("#model-response summary").click();
    assert.match(await page.locator("#raw-response").innerText(), /这里只有一条/);
    assert.equal(await page.locator("#raw-response img").count(), 0);

    mode = "bilingual";
    await page.locator("#generate").click();
    await page.waitForSelector("#results:not([hidden])");
    assert.equal(await page.locator(".reply-translation:not([hidden])").count(), 3);
    assert.equal(await page.locator(".reply-translation p").first().textContent(), bilingual.replies[0].translation);
    assert.equal(await page.locator(".reply-translation img").count(), 0, "译文必须安全地作为文本显示");
    await page.locator(".copy-button").first().click();
    assert.equal(await page.evaluate(() => window.__mock.clipboard), bilingual.replies[0].text, "复制只包含外语原文");
    await page.locator(".reply-text").first().fill("Edited English reply.");
    assert.equal(await page.locator(".reply-translation span").first().innerText(), "中文参考（编辑前）");
    await page.locator(".reply-text").first().fill(bilingual.replies[0].text);
    await page.screenshot({ path: path.join(artifacts, "panel-bilingual.png"), fullPage: true });
    assert.equal(await page.locator("#panel-provider, #panel-model, .model-controls").count(), 0);
    assert.equal(await page.locator("main").innerText().then(text => text.includes("deepseek-flash")), false);

    const options = await context.newPage();
    await options.setViewportSize({ width: 1060, height: 1100 });
    await options.goto(origin + "/options.html");
    await options.locator("#apiKey").fill("my-private-test-key");
    await options.locator("#baseUrl").fill("https://example.test/v1");
    assert.equal(await options.locator("#models textarea").count(), 0);
    await options.locator("#models input").first().fill("my-model");
    const apiTests = [];
    let testMode = "success";
    await options.route("https://example.test/**", async route => {
      apiTests.push({ url: route.request().url(), body: route.request().postDataJSON() });
      if (testMode === "401") { await route.fulfill({ status: 401, body: "unauthorized" }); return; }
      if (testMode === "network") { await route.abort("failed"); return; }
      if (testMode === "delayed") await new Promise(resolve => setTimeout(resolve, 400));
      const content = testMode === "empty" ? "" : testMode === "html" ? '<img src=x onerror="alert(1)">2' : "2";
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ choices: [{ message: { content } }] }) });
    });
    await options.locator("#test-api").click();
    await options.waitForFunction(() => document.getElementById("config-status").textContent.includes("模型回答：2"));
    assert.equal(await options.evaluate(() => window.__mock.local.settings), undefined, "测试不得保存未保存的配置");
    assert.equal(apiTests[0].url, "https://example.test/v1/chat/completions");
    assert.deepEqual(apiTests[0].body.messages, [{ role: "user", content: "1+1=？" }]);
    assert.equal(apiTests[0].body.model, "my-model");
    await options.screenshot({ path: path.join(artifacts, "options-api-test.png"), fullPage: true });
    testMode = "401";
    await options.locator("#test-api").click();
    await options.waitForSelector("#config-status.error");
    assert.match(await options.locator("#config-status").innerText(), /Key/);
    testMode = "empty";
    await options.locator("#test-api").click();
    await options.waitForFunction(() => document.getElementById("config-status").textContent.includes("格式无效"));
    testMode = "network";
    await options.locator("#test-api").click();
    await options.waitForFunction(() => document.getElementById("config-status").textContent.includes("无法连接"));
    testMode = "html";
    await options.locator("#test-api").click();
    await options.waitForFunction(() => document.getElementById("config-status").textContent.includes("onerror"));
    assert.equal(await options.locator("#config-status img").count(), 0, "模型回答只能显示为文本");
    testMode = "delayed";
    await options.locator("#test-api").click();
    assert(await options.locator("#test-api").isDisabled());
    assert(await options.locator("#save").isDisabled());
    await options.locator("#models input").first().fill("changed-model");
    await options.waitForFunction(() => !document.getElementById("test-api").disabled);
    await options.waitForTimeout(450);
    assert.equal(await options.locator("#config-status").innerText(), "", "修改配置后不得显示旧测试成功");
    await options.locator("#models input").first().fill("my-model");
    testMode = "success";
    await options.locator("#save").click();
    await options.waitForFunction(() => document.getElementById("config-status").textContent.includes("配置已保存"));
    assert.equal(await options.evaluate(() => window.__mock.local.settings.providers[0].baseUrl), "https://example.test/v1");
    await options.locator("#add-provider").click();
    await options.locator("#provider-name").fill("商汤日日新");
    await options.locator("#baseUrl").fill("https://token.sensenova.cn/v1");
    await options.locator("#apiKey").fill("sense-test-key");
    assert.equal(await options.locator("#models input").count(), 0, "新厂家不能沿用其他厂家的模型");
    await options.locator("#add-model").click();
    await options.locator("#models input").nth(0).fill("sensenova-6.8-flash-lite");
    await options.locator("#add-model").click();
    await options.locator("#models input").nth(1).fill("second-sense-model");
    await options.locator("#model").selectOption("second-sense-model");
    await options.locator("#models input").nth(1).fill("renamed-sense-model");
    assert.equal(await options.locator("#model").inputValue(), "renamed-sense-model", "编辑当前模型时保留该行的选中状态");
    await options.locator("#models button").nth(1).click();
    assert.equal(await options.locator("#model").inputValue(), "sensenova-6.8-flash-lite", "删除当前模型后选择该厂家剩余模型");
    await options.locator("#add-model").click();
    await options.locator("#models input").nth(1).fill("second-sense-model");
    await options.locator("#model").selectOption("second-sense-model");
    const senseId = await options.locator("#provider").inputValue();
    await options.locator("#provider").selectOption("default");
    assert.equal(await options.locator("#apiKey").inputValue(), "my-private-test-key");
    assert.deepEqual(await options.locator("#models input").evaluateAll(inputs => inputs.map(input => input.value)), ["my-model"]);
    await options.locator("#provider").selectOption(senseId);
    assert.equal(await options.locator("#model").inputValue(), "second-sense-model");
    await options.locator("#save").click();
    await options.waitForFunction(() => window.__mock.local.settings.providers.length === 2);
    assert.equal(await options.evaluate(() => window.__mock.local.settings.providers[0].apiKey), "my-private-test-key");
    assert.equal(await options.evaluate(() => window.__mock.local.settings.providers[1].apiKey), "sense-test-key");
    await options.screenshot({ path: path.join(artifacts, "options-providers.png"), fullPage: true });
    await options.locator("#model").selectOption("sensenova-6.8-flash-lite");
    await options.locator("#save").click();
    await options.waitForFunction(() => window.__mock.local.settings.providers[1].model === "sensenova-6.8-flash-lite");
    const multiple = await options.evaluate(() => window.__mock.local.settings);
    await page.evaluate(async settings => { await chrome.storage.local.set({ settings }); }, multiple);
    await page.waitForFunction(() => document.getElementById("status").textContent.includes("AI 配置已更新"));
    const providerCalls = [];
    for (const endpoint of ["https://token.sensenova.cn/**", "https://example.test/**"]) {
      await page.route(endpoint, async route => {
        providerCalls.push({ url: route.request().url(), authorization: route.request().headers().authorization, body: route.request().postDataJSON() });
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ choices: [{ finish_reason: "stop", message: {
          content: replies.replies.map((item, index) => `${index + 1}. ${item.text}`).join("\n"), reasoning: "仅应读取 content"
        } }] }) });
      });
    }
    await page.locator("#generate").click();
    await page.waitForSelector("#results:not([hidden])");
    assert.equal(providerCalls[0].url, "https://token.sensenova.cn/v1/chat/completions");
    assert.equal(providerCalls[0].authorization, "Bearer sense-test-key");
    assert.equal(providerCalls[0].body.model, "sensenova-6.8-flash-lite");
    await page.screenshot({ path: path.join(artifacts, "panel-providers.png"), fullPage: true });
    await options.locator("#provider").selectOption("default");
    await options.locator("#save").click();
    await options.waitForFunction(() => window.__mock.local.settings.providerId === "default");
    await page.evaluate(async settings => { await chrome.storage.local.set({ settings }); }, await options.evaluate(() => window.__mock.local.settings));
    await page.waitForFunction(() => document.getElementById("status").textContent.includes("AI 配置已更新"));
    assert(!(await page.locator("#results").isVisible()), "切换厂家必须隐藏上一厂家的结果");
    await page.locator("#generate").click();
    await page.waitForSelector("#results:not([hidden])");
    assert.equal(providerCalls[1].url, "https://example.test/v1/chat/completions");
    assert.equal(providerCalls[1].authorization, "Bearer my-private-test-key");
    assert.equal(providerCalls[1].body.model, "my-model");
    assert.equal(await page.evaluate(() => window.__mock.local.settings.providers[1].apiKey), "sense-test-key");
    assert.equal(await page.locator("main").innerText().then(text => /sense-test-key|my-model|sensenova-6\.8-flash-lite/.test(text)), false, "主页面不显示厂家、模型或 Key 信息");

    const rootText = "想到1500！走过路过，给来一下吧！诚信，等你啊！\n".repeat(30);
    await page.setViewportSize({ width: 380, height: 900 });
    await page.evaluate(async ({ post, rootText }) => {
      await chrome.storage.session.set({ "post:1": {
        ...post, url: "https://x.com/commenter/status/222", author: "牛叔叔 @commenter", text: "来了", quote: "", isReply: true,
        rootPost: { ...post, author: "peak @peak", text: rootText, quote: "", hasMedia: true }
      } });
    }, { post, rootText });
    await page.waitForSelector("#results:not([hidden])");
    assert.equal(await page.locator("#post-text").innerText(), "来了");
    assert.equal(await page.locator("#root-text").textContent(), rootText);
    assert.equal(await page.locator("#source-title").innerText(), "回复评论");
    assert(!(await page.locator("#context-note").isVisible()));
    const payload = JSON.parse(providerCalls.at(-1).body.messages[1].content).post;
    assert.equal(payload.rootPost.text, rootText.trim(), "折叠预览不能截断传给 AI 的主帖正文");
    assert.equal(payload.text, "来了");
    assert.equal(payload.isReply, true);
    const previewHeight = await page.locator("#root-text").evaluate(node => node.getBoundingClientRect().height);
    assert(previewHeight <= 38, "默认主帖预览最多两行");
    assert.equal(await page.locator(".reply-heading strong").first().innerText(), "01 / 自然回应");
    assert(await page.locator("#reply-list").evaluate(node => node.getBoundingClientRect().bottom <= innerHeight), "常见窄侧边栏高度内可看完三条短回复");
    await page.screenshot({ path: path.join(artifacts, "panel-thread-compact.png"), fullPage: true });
    await page.locator("#expand-source").click();
    assert(await page.locator("#root-text").evaluate((node, height) => node.getBoundingClientRect().height > height, previewHeight));
    await page.locator("#expand-source").click();
    await page.locator(".reply-text").first().fill("编辑较长评论也应完整显示。".repeat(22));
    for (const width of [320, 480, 380]) {
      await page.setViewportSize({ width, height: 900 });
      await page.waitForFunction(() => [...document.querySelectorAll(".reply-text")].every(field => field.scrollHeight <= field.clientHeight + 1));
      assert(await page.locator(".reply-text").evaluateAll(fields => fields.every(field => getComputedStyle(field).overflowY === "hidden")));
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "窄侧边栏不能出现横向滚动");
    }
    await page.evaluate(async post => { await chrome.storage.session.set({ "post:1": { ...post, text: "没有主帖的评论", isReply: true } }); }, post);
    await page.waitForSelector("#context-note:not([hidden])");
    assert(!(await page.locator("#root-context").isVisible()));
    assert.equal(await page.locator("#expand-source").getAttribute("aria-expanded"), "false");
    await options.locator("#provider").selectOption("default");
    await options.screenshot({ path: path.join(artifacts, "options.png"), fullPage: true });
    await options.locator("#add-provider").click();
    assert.equal(await options.locator("#provider option").count(), 3);
    await options.locator("#delete-provider").click();
    assert.equal(await options.locator("#provider option").count(), 2);
    assert.equal(await options.evaluate(() => window.__mock.local.settings.providers.length), 2, "未保存的增删不得修改已有配置");
    await options.evaluate(() => { window.__mock.allowed = false; });
    await options.locator("#baseUrl").fill("https://denied.test/v1");
    await options.locator("#save").click();
    await options.waitForSelector("#config-status.error");
    assert.equal(await options.evaluate(() => window.__mock.local.settings.providers[0].baseUrl), "https://example.test/v1");
    const sentBeforeDenied = apiTests.length;
    await options.locator("#baseUrl").fill("https://example.test/v1");
    await options.locator("#test-api").click();
    await options.waitForFunction(() => document.getElementById("config-status").textContent.includes("未获得 API 域名授权"));
    assert.equal(apiTests.length, sentBeforeDenied, "拒绝域名授权后不得发出测试请求");
    await options.locator("#clear-key").click();
    await options.waitForFunction(() => window.__mock.local.settings.providers[0].apiKey === "");
    assert.equal(await options.evaluate(() => window.__mock.local.settings.providers[1].apiKey), "sense-test-key", "清除当前 Key 不得影响其他厂家");

    const fixture = await context.newPage();
    await fixture.goto(origin + "/sidepanel.html");
    await fixture.setContent(`<article data-testid="tweet"><div data-testid="User-Name">Alice @alice</div><a href="https://x.com/alice/status/123"><time>now</time></a><div data-testid="tweetText">第一行<br>第二行<img alt="😀"></div><div data-testid="tweetText">引用的内容</div><div data-testid="tweetPhoto"></div><button data-testid="reply"><span>回复</span></button></article>`);
    await fixture.addScriptTag({ path: path.join(root, "content.js") });
    await fixture.locator('[data-testid="reply"] span').click();
    const captured = await fixture.evaluate(() => window.__mock.sent.at(-1));
    assert.equal(captured.post.text, "第一行\n第二行😀");
    assert.equal(captured.post.quote, "引用的内容");
    assert.equal(captured.post.hasMedia, true);
    assert.equal(captured.post.url, "https://x.com/alice/status/123");
    await fixture.evaluate(() => document.querySelector('[data-testid="reply"]').click());
    assert.equal(await fixture.evaluate(() => window.__mock.sent.length), 1, "网页合成点击不得触发 AI 选择");
    await fixture.evaluate(() => document.body.insertAdjacentHTML("beforeend", '<article data-testid="tweet"><a href="https://x.com/new/status/999"><time>now</time></a><div data-testid="tweetText">动态加载</div><button data-testid="reply">回复新帖</button></article>'));
    await fixture.getByText("回复新帖", { exact: true }).click();
    assert.equal(await fixture.evaluate(() => window.__mock.sent.at(-1).post.text), "动态加载");

    const modal = await context.newPage();
    await modal.goto(origin + "/sidepanel.html");
    await modal.setContent('<div id="layers"><div role="dialog"><article data-testid="tweet" role="article"><div data-testid="User-Name">Edwin @Edwin_csh · <time>37m</time></div><div data-testid="tweetText">自从做了X之后！<br>回复里的原帖没有链接<img alt="😮‍💨"></div></article><div role="textbox" contenteditable="true" data-testid="tweetTextarea_0"></div></div></div>');
    await modal.addScriptTag({ path: path.join(root, "content.js") });
    await modal.waitForFunction(() => window.__mock.sent.some(message => message.type === "POST_SELECTED"), null, { timeout: 3000 });
    const modalPost = await modal.evaluate(() => window.__mock.sent.find(message => message.type === "POST_SELECTED").post);
    assert.equal(modalPost.url, "");
    assert.equal(modalPost.text, "自从做了X之后！\n回复里的原帖没有链接😮‍💨");
    assert.match(modalPost.author, /Edwin_csh/);
    assert(!modalPost.author.includes("37m"));
    assert.equal(await modal.evaluate(() => window.__readCurrent().post.text), modalPost.text);
    const captures = await modal.evaluate(() => window.__mock.sent.length);
    await modal.locator('[data-testid="tweetTextarea_0"]').fill("用户自己正在编辑的回复，不得读取");
    await modal.waitForTimeout(250);
    assert.equal(await modal.evaluate(() => window.__mock.sent.length), captures, "打字不得重复捕获或发送用户自己的草稿");
    await modal.evaluate(() => document.body.insertAdjacentHTML("beforeend", '<article data-testid="tweet"><div data-testid="User-Name">Edwin @Edwin_csh</div><a href="https://x.com/Edwin_csh/status/123456"><time>37m</time></a><div data-testid="tweetText">自从做了X之后！<br>回复里的原帖没有链接<img alt="😮‍💨"></div></article>'));
    assert.equal(await modal.evaluate(() => window.__readCurrent().post.url), "https://x.com/Edwin_csh/status/123456");
    await modal.evaluate(() => {
      const dialog = document.querySelector('[role="dialog"]');
      dialog.querySelector('[data-testid="tweetText"]').textContent = "用户又选择了另一条帖子";
      dialog.querySelector('[data-testid="User-Name"]').textContent = "Bob @bob";
    });
    await modal.waitForFunction(() => window.__mock.sent.at(-1).post.text === "用户又选择了另一条帖子");
    assert.equal(await modal.evaluate(() => window.__mock.sent.at(-1).post.url), "", "不得沿用上一条帖子的链接");
    await modal.evaluate(() => document.querySelector('[role="dialog"] article').remove());
    assert.equal(await modal.evaluate(() => window.__readCurrent().post), null, "新建帖子弹窗不得误读背景时间线");

    const thread = await context.newPage();
    await thread.goto(origin + "/sidepanel.html");
    await thread.evaluate(() => history.replaceState({}, "", "/peak/status/100"));
    await thread.setContent(`<main data-testid="primaryColumn">
      <article data-testid="tweet" id="root-post"><div data-testid="User-Name">peak @peak</div><a href="https://x.com/peak/status/100"><time>now</time></a><div data-testid="tweetText">想到1500！走过路过，给来一下吧！</div><button data-testid="reply">回复主帖</button></article>
      <article data-testid="tweet" id="comment-post"><div data-testid="User-Name">牛叔叔 @commenter</div><a href="https://x.com/commenter/status/200"><time>now</time></a><div data-testid="tweetText">来了</div><button data-testid="reply">回复评论</button></article>
      <h2>Discover more</h2><article data-testid="tweet" id="recommended-post"><a href="https://x.com/other/status/900"><time>now</time></a><div data-testid="tweetText">无关推荐帖子</div><button data-testid="reply">回复推荐</button></article>
    </main>`);
    await thread.addScriptTag({ path: path.join(root, "content.js") });
    await thread.getByText("回复评论", { exact: true }).click();
    const target = await thread.evaluate(() => window.__mock.sent.at(-1).post);
    assert.equal(target.text, "来了");
    assert.equal(target.isReply, true);
    assert.equal(target.rootPost.text, "想到1500！走过路过，给来一下吧！");
    assert.equal(target.rootPost.author, "peak @peak");
    await thread.getByText("回复推荐", { exact: true }).click();
    assert.equal(await thread.evaluate(() => window.__mock.sent.at(-1).post.rootPost), undefined, "推荐帖子不得附带无关主帖");
    await thread.getByText("回复评论", { exact: true }).click();
    await thread.evaluate(() => {
      document.getElementById("root-post").remove();
      history.pushState({}, "", "/compose/post");
      document.body.insertAdjacentHTML("beforeend", '<div role="dialog"><article data-testid="tweet"><div data-testid="User-Name">牛叔叔 @commenter</div><div data-testid="tweetText">来了</div></article><div contenteditable="true" data-testid="tweetTextarea_0"></div></div>');
    });
    const modalTarget = await thread.evaluate(() => window.__readCurrent().post);
    assert.equal(modalTarget.url, target.url);
    assert.equal(modalTarget.rootPost.text, target.rootPost.text, "主帖滚出 DOM、进入无链接弹窗后仍保留已读背景");
    await thread.evaluate(() => {
      document.querySelector('[role="dialog"]').remove();
      history.pushState({}, "", "/new/status/300");
      document.querySelector("main").insertAdjacentHTML("afterbegin", '<article data-testid="tweet"><div data-testid="tweetText">没有链接的无关帖子</div></article>');
    });
    await thread.getByText("回复评论", { exact: true }).click();
    const missingRoot = await thread.evaluate(() => window.__mock.sent.at(-1).post);
    assert.equal(missingRoot.rootPost, undefined, "换主帖后不得沿用旧背景，也不能把无链接帖子当主帖");
    assert.equal(missingRoot.isReply, true);
    await thread.evaluate(() => {
      history.pushState({}, "", "/home");
      document.body.innerHTML = '<div role="dialog"><article data-testid="tweet"><div data-testid="tweetText">弹窗中的主帖</div></article><article data-testid="tweet"><div data-testid="tweetText">弹窗中的目标评论</div></article><div contenteditable="true" data-testid="tweetTextarea_0"></div></div>';
    });
    const chain = await thread.evaluate(() => window.__readCurrent().post);
    assert.equal(chain.text, "弹窗中的目标评论");
    assert.equal(chain.rootPost.text, "弹窗中的主帖");
    assert.equal(chain.isReply, true);

    const recovery = await context.newPage();
    await recovery.goto(origin + "/sidepanel.html?recover");
    await recovery.waitForSelector("#source:not([hidden])");
    assert.equal(await recovery.locator("#post-text").innerText(), "已经打开的回复弹窗");
    assert(!(await recovery.locator("#post-link").isVisible()));
    await recovery.evaluate(() => { window.__mock.currentPost = { ...window.__mock.post, url: "", text: "手动重读的回复原帖" }; });
    await recovery.locator("#read-current").click();
    await recovery.waitForFunction(() => document.getElementById("post-text").textContent === "手动重读的回复原帖");
    await recovery.evaluate(async () => { await chrome.storage.session.remove("post:1"); });
    await recovery.waitForFunction(() => window.__mock.session["post:1"]?.text === "手动重读的回复原帖");
    await recovery.evaluate(() => { window.__mock.disconnected = true; });
    await recovery.locator("#read-current").click();
    await recovery.waitForSelector("#status.error");
    assert.match(await recovery.locator("#status").innerText(), /刷新 X/);
    assert(!(await recovery.locator("#read-current").isDisabled()));
    await recovery.evaluate(() => { window.__mock.disconnected = false; window.__mock.currentPost = null; });
    await recovery.locator("#read-current").click();
    assert.match(await recovery.locator("#status").innerText(), /先打开/);
    assert.deepEqual(errors, []);
    console.log("✓ 浏览器回归通过：模型逐行增删、设置切换与请求路由、主页面隐藏模型、双语显示与只复制原文、主帖上下文、API 测试及原有功能。");
    console.log(`截图：${artifacts}`);
  } finally {
    if (browser) await browser.close();
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
