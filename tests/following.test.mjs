import test from "node:test";
import { strict as assert } from "node:assert";
import fs from "node:fs";
import vm from "node:vm";

await test("未回关读取与取消前校验：互关、去重、本人页面和登录账号隔离", () => {
  let listener;
  let mutation;
  let timer;
  const events = {};
  const flush = () => { const callback = timer; timer = null; callback?.(); };
  const notifications = [];
  let clicks = 0;
  let owner = "me";
  let dialog = false;
  const location = { href: "https://x.com/me/following", origin: "https://x.com", pathname: "/me/following", assign(path) { this.assigned = path; } };
  function cell(handle, followsYou = false, followed = true) {
    const entry = { handle, followsYou, followed, textContent: `Name @${handle}` };
    entry.querySelector = selector => selector.includes("-unfollow") ? (entry.followed ? { click() { clicks++; }, disabled: false } : null) : entry.followsYou ? {} : null;
    entry.querySelectorAll = () => [{ href: `https://x.com/${handle}` }];
    return entry;
  }
  const alice = cell("alice");
  let cells = [alice, cell("bob", true), cell("Alice"), cell("me"), cell("outsider", false, false)];
  const document = { querySelector(selector) {
    if (selector.includes("AppTabBar")) return owner ? { href: `https://x.com/${owner}` } : null;
    if (selector.includes("primaryColumn")) return { querySelectorAll: () => cells };
    return dialog ? {} : null;
  } };
  vm.runInNewContext(fs.readFileSync(new URL("../extension/following-content.js", import.meta.url), "utf8"), {
    document, location, URL, setTimeout: (callback, delay) => { assert.equal(delay, 200, "监听不设两分钟停止计时器"); timer = callback; return 1; },
    window: { addEventListener: (type, callback) => { events[type] = callback; } },
    MutationObserver: class { constructor(callback) { mutation = callback; } observe() {} disconnect() {} },
    chrome: { runtime: { id: "self", sendMessage: async message => { notifications.push(message); }, onMessage: { addListener(value) { listener = value; } } } }
  });
  function request(message, sender = { id: "self" }) {
    let response;
    listener(message, sender, value => { response = value; });
    return response;
  }
  const read = () => request({ type: "GET_NON_FOLLOWERS" });
  const cancel = (handle = "alice", account = "me") => request({ type: "UNFOLLOW_ACCOUNT", handle, owner: account });
  assert.equal(notifications.length, 1, "初次加载自动识别，无需手动读取或取消关注");
  notifications.length = 0;
  cells.push(cell("carol"));
  events.wheel();
  flush();
  assert.equal(notifications.length, 1, "滚轮触发自动识别");
  cells.pop();
  events.scroll();
  flush();
  assert.equal(notifications.length, 2, "滚动触发自动识别");
  cells.push(cell("delayed"));
  mutation();
  flush();
  assert.equal(notifications.length, 3, "滚动后异步渲染的账号自动识别");
  cells.pop();
  mutation();
  flush();
  notifications.length = 0;
  assert.equal(request({ type: "GET_NON_FOLLOWERS" }, { id: "external" }), undefined);
  assert.equal(read().checked, 2);
  assert.equal(JSON.stringify(read().accounts.map(account => account.handle.toLowerCase())), '["alice"]');
  assert.equal(cancel().ok, true);
  assert.equal(clicks, 1);
  mutation();
  flush();
  assert.equal(notifications.length, 0, "只打开或取消确认框不得刷新列表");
  alice.followed = false;
  mutation();
  flush();
  assert.equal(notifications[0]?.type, "FOLLOWING_LIST_CHANGED", "关注按钮变化后通知侧边栏刷新");
  mutation();
  flush();
  assert.equal(notifications.length, 1, "无列表变化不重复通知");
  alice.followed = true;
  assert.equal(cancel("bob").ok, false);
  assert.equal(cancel("unknown").ok, false);
  assert.equal(cancel("<script>").ok, false);
  assert.equal(cancel("alice", "other").ok, false);
  alice.followsYou = true;
  assert.equal(cancel().ok, false);
  alice.followsYou = false;
  dialog = true;
  assert.equal(cancel().ok, false);
  dialog = false;
  location.pathname = "/other/following";
  mutation();
  flush();
  assert.equal(notifications.length, 2, "离开本人页面通知侧栏清除旧结果");
  assert.equal(read().ok, false);
  assert.equal(cancel().ok, false);
  location.pathname = "/me/followers";
  assert.equal(read().ok, false);
  location.pathname = "/ME/following/";
  mutation();
  flush();
  assert.equal(notifications.length, 3, "返回本人关注列表恢复自动识别");
  assert.equal(read().ok, true);
  cells = [];
  assert.equal(read().checked, 0);
  assert.equal(request({ type: "OPEN_OWN_FOLLOWING" }).ok, true);
  assert.equal(location.assigned, "/me/following");
  owner = null;
  assert.equal(read().ok, false);
  assert.equal(request({ type: "OPEN_OWN_FOLLOWING" }).ok, false);
  assert.equal(clicks, 1, "失败校验不得点击取消关注");
});
