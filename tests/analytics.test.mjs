import { analyticsProfile } from "../extension/analytics-profile.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { validateCollection, mergePosts, interactionRate, summarize, exportCsv, validateImpression, mergeImpressions, impressionDate } from "../extension/analytics-data.js";

const sample = {
  id: "1234567890123456789", owner: "me", url: "https://x.com/me/status/1234567890123456789", text: "自己的正文", quote: "他人的引用内容",
  publishedAt: "2026-10-24T01:00:00.000Z", collectedAt: "2026-10-25T01:00:00.000Z",
  isQuote: true, hasImage: false, hasVideo: true, textMayBeTruncated: false,
  metrics: { views: 100, likes: 5, replies: 2, reposts: 3, bookmarks: null },
  metricLabels: { views: "100 Views", likes: "5 Likes", replies: "2 Replies", reposts: "3 Reposts", bookmarks: "" }
};
const collection = posts => ({ owner: "me", posts });

test("采集边界拒绝其他账号、危险链接、无效指标和日期，白名单保存", () => {
  const result = validateCollection(collection([{ ...sample, apiKey: "should-not-save" }]));
  assert.deepEqual(result.posts, [sample]);
  for (const change of [
    { owner: "someone" }, { url: "javascript:alert(1)" }, { id: 123 }, { publishedAt: "bad" },
    { isQuote: "true" }, { metrics: { ...sample.metrics, likes: -1 } }, { metrics: { ...sample.metrics, views: undefined } },
    { metricLabels: { ...sample.metricLabels, likes: {} } }
  ]) assert.throws(() => validateCollection(collection([{ ...sample, ...change }])));
  assert.throws(() => validateCollection({ owner: "../other", posts: [] }));
});

test("按帖子ID累计和刷新快照，保留已展开正文，缺失指标不冒充旧值", () => {
  const unchanged = { ...sample, collectedAt: "2026-10-25T02:00:00.000Z" };
  assert.equal(mergePosts([sample], [unchanged])[0], sample, "数据一致保留本地原记录和采集时间");
  const next = { ...sample, collectedAt: "2026-10-25T02:00:00.000Z", metrics: { ...sample.metrics, views: null, likes: 7 }, text: "缩略", textMayBeTruncated: true };
  const another = { ...sample, id: "2", publishedAt: "2026-10-25T01:00:00.000Z" };
  const result = mergePosts([sample], [next, another]);
  assert.equal(result.length, 2);
  assert.equal(result[0].id, "2");
  assert.equal(result[1].text, sample.text);
  assert.equal(result[1].metrics.likes, 7);
  assert.equal(result[1].metrics.views, null);
  assert.deepEqual(mergePosts([next], [sample]), [next], "迟到的旧快照不能覆盖新数据");
});

test("自动同步：本地比较去重、断网保留、定时重试、并发更新及本机读取", async () => {
  const { postFingerprint } = await import("../extension/analytics-data.js");
  const { validatePostService } = await import("../extension/posts-api.js");
  let listener;
  let alarm;
  let offline = true;
  let holdUpload;
  let requests = 0;
  const targets = [];
  const remote = new Map();
  const local = { postService: { baseUrl: "https://service.test", token: "a".repeat(32) } };
  const localWrites = [];
  const storageListeners = [];
  const context = {
    validateCollection, mergePosts, postFingerprint, validateImpression, mergeImpressions, URL, console,
    validatePostService,
    postServiceRequest: async (service, path, options = {}) => {
      requests++;
      targets.push(service.baseUrl);
      if (offline) throw new Error("网络离线");
      if (options.method === "POST") {
        const snapshot = structuredClone(options.body);
        if (holdUpload) await holdUpload;
        if (path === "/api/analytics/impressions") { remote.set(`impressions:${snapshot.owner}:${snapshot.date}`, snapshot); return { accepted: 1 }; }
        for (const post of snapshot.posts) remote.set(`${post.owner}:${post.id}`, post);
        return { accepted: snapshot.posts.length };
      }
      const owner = new URL(path, "https://service.test").searchParams.get("owner");
      return { owner, posts: [...remote.values()].filter(post => post.owner === owner), nextCursor: null };
    },
    chrome: {
      runtime: { id: "self", getURL: path => `chrome-extension://self/${path}` },
      permissions: { contains: async () => true },
      alarms: { create: async () => {}, onAlarm: { addListener(callback) { alarm = callback; } } },
      storage: {
        local: {
          get: async key => structuredClone(key === null ? local : { [key]: local[key] }),
          set: async values => {
            localWrites.push(structuredClone(values));
            const changes = Object.fromEntries(Object.entries(values).map(([key, value]) => [key, { oldValue: local[key], newValue: structuredClone(value) }]));
            Object.assign(local, structuredClone(values));
            storageListeners.forEach(callback => callback(changes, "local"));
          },
          remove: async key => { delete local[key]; }
        },
        onChanged: { addListener(callback) { storageListeners.push(callback); } }
      }
    }
  };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(new URL("../extension/analytics-sync.js", import.meta.url), "utf8").replace(/^import .*\r?\n/gm, "").replace(/^export /gm, ""), context);
  listener = context.handleAnalyticsMessage;
  const sender = { id: "self", tab: { id: 1 }, url: "https://x.com/me" };
  const panel = { id: "self", url: "chrome-extension://self/sidepanel.html" };
  const save = post => new Promise(resolve => listener({ type: "SAVE_OWN_POSTS", data: collection([post]) }, sender, resolve));
  const settle = async () => { await new Promise(resolve => setTimeout(resolve, 0)); await context.syncPendingPosts(); };
  assert.equal(listener({ type: "SAVE_OWN_POSTS", data: collection([sample]) }, panel, () => assert.fail()), undefined);
  assert.equal(listener({ type: "LOAD_OWN_POSTS", owner: "me" }, sender, () => assert.fail()), undefined);
  assert.equal(listener({ type: "SAVE_OWN_POSTS", data: collection([sample]) }, { ...sender, id: "other" }, () => assert.fail()), undefined);
  assert.equal((await save(sample)).ok, true);
  await settle();
  assert.deepEqual(local["analytics:me"].pending, [sample.id]);
  assert.match(local.analyticsSync.error, /离线/);
  offline = false;
  alarm({ name: "analytics-sync" });
  await settle();
  assert.deepEqual(local["analytics:me"].pending, []);
  assert.equal(remote.get(`me:${sample.id}`).metrics.likes, 5);
  const writesBefore = localWrites.length;
  const requestsBefore = requests;
  await save({ ...sample, collectedAt: "2026-10-25T02:00:00.000Z" });
  await settle();
  assert.equal(localWrites.length, writesBefore, "互动及内容相同不能重复写入");
  assert.equal(requests, requestsBefore, "相同数据不能重复上传");
  let release;
  holdUpload = new Promise(resolve => { release = resolve; });
  const next = { ...sample, collectedAt: "2026-10-25T03:00:00.000Z", metrics: { ...sample.metrics, likes: 8 } };
  await save(next);
  await new Promise(resolve => setTimeout(resolve, 0));
  const newer = { ...next, collectedAt: "2026-10-25T04:00:00.000Z", metrics: { ...next.metrics, likes: 9 } };
  await save(newer);
  holdUpload = null;
  release();
  await settle();
  assert.equal(remote.get(`me:${sample.id}`).metrics.likes, 9, "上传中产生新变化最终仍须同步");
  assert.deepEqual(local["analytics:me"].pending, []);
  const beforeLoad = requests;
  const cached = await new Promise(resolve => listener({ type: "LOAD_OWN_POSTS", owner: "me" }, panel, resolve));
  assert.equal(cached.posts[0].metrics.likes, 9);
  assert.equal(requests, beforeLoad, "查看数据只读本机，不请求服务端");
  delete local["analytics:me"];
  const restored = await new Promise(resolve => listener({ type: "LOAD_OWN_POSTS", owner: "me" }, panel, resolve));
  assert.equal(restored.posts.length, 0, "无缓存时等待页面重新采集，不从服务端恢复");
  assert.equal(requests, beforeLoad);
  delete local.postService;
  await save({ ...newer, collectedAt: "2026-10-25T05:00:00.000Z", metrics: { ...newer.metrics, likes: 11 } });
  await settle();
  assert.equal(targets.at(-1), "http://127.0.0.1:12345", "无配置时自动连接本机服务");
  assert.equal(remote.get(`me:${sample.id}`).metrics.likes, 11);
  offline = true;
  const exposure = { owner: "me", value: 23600, raw: "23.6K", collectedAt: "2026-10-29T02:00:00Z" };
  const saveExposure = data => new Promise(resolve => listener({ type: "SAVE_ORIGINAL_IMPRESSIONS", data }, sender, resolve));
  assert.equal((await saveExposure(exposure)).ok, true);
  await settle();
  assert.deepEqual(local["analytics:me"].pendingImpressions, ["2026-10-29"]);
  await saveExposure({ ...exposure, value: 24000, raw: "24K", collectedAt: "2026-10-29T03:00:00Z" });
  await saveExposure({ ...exposure, value: 24000, raw: "24K", collectedAt: "2026-10-30T02:00:00Z" });
  assert.equal(local["analytics:me"].impressions.length, 1);
  await save({ ...newer, collectedAt: "2026-10-25T06:00:00Z", metrics: { ...newer.metrics, likes: 12 } });
  assert.equal(local["analytics:me"].impressions.length, 1, "帖子更新保留原创曝光记录");
  offline = false;
  await settle();
  assert.deepEqual(local["analytics:me"].pendingImpressions, []);
  assert.equal(remote.get("impressions:me:2026-10-29").value, 24000);
  const withExposure = await new Promise(resolve => listener({ type: "LOAD_OWN_POSTS", owner: "me" }, panel, resolve));
  assert.equal(withExposure.impressions.length, 1);
  const manual = { ...exposure, date: "2026-10-28", value: 22000, raw: "22000", collectedAt: "2026-10-30T03:00:00Z" };
  assert.equal(listener({ type: "ADD_ORIGINAL_IMPRESSIONS", data: manual }, sender, () => assert.fail()), undefined, "网页不能伪造手动记录");
  const addManual = data => new Promise(resolve => listener({ type: "ADD_ORIGINAL_IMPRESSIONS", data }, panel, resolve));
  assert.equal((await addManual(manual)).ok, true);
  await settle();
  assert.equal(remote.get("impressions:me:2026-10-28").source, "manual");
  let releaseImpression;
  holdUpload = new Promise(resolve => { releaseImpression = resolve; });
  await addManual({ ...manual, value: 22500, raw: "22500", collectedAt: "2026-10-30T04:00:00Z" });
  await new Promise(resolve => setTimeout(resolve, 0));
  await addManual({ ...manual, value: 22600, raw: "22600", collectedAt: "2026-10-30T05:00:00Z" });
  holdUpload = null;
  releaseImpression();
  await settle();
  assert.equal(remote.get("impressions:me:2026-10-28").value, 22600, "上传中修正历史不能被旧确认清除");
  assert.deepEqual(local["analytics:me"].pendingImpressions, []);
  const legacy = { owner: "1nhkjltx", date: "2026-10-29", value: 23600, raw: "23.6K", collectedAt: "2026-10-29T01:16:52.887Z" };
  local["analytics:1nhkjltx"] = { owner: "1nhkjltx", posts: [], impressions: [legacy], pending: [], pendingImpressions: ["2026-10-29"] };
  const loadCorrected = () => new Promise(resolve => listener({ type: "LOAD_OWN_POSTS", owner: "1nhkjltx" }, panel, resolve));
  const corrected = await loadCorrected();
  assert.equal(corrected.impressions[0].date, "2026-10-28", "数据库更正同时迁移旧浏览器缓存");
  assert.equal(corrected.impressions[0].value, 23600);
  assert.deepEqual(local["analytics:1nhkjltx"].pendingImpressions, ["2026-10-28"]);
  const correctionWrites = localWrites.length;
  await loadCorrected();
  assert.equal(localWrites.length, correctionWrites, "迁移只执行一次");
  local["analytics:1nhkjltx"].impressions = [{ ...legacy, source: "manual" }];
  assert.equal((await loadCorrected()).impressions[0].date, "2026-10-29", "不改动手动填写的日期");
  local["analytics:1nhkjltx"].impressions = [legacy, { ...legacy, date: "2026-10-28", value: 22000 }];
  assert.equal((await loadCorrected()).impressions.length, 2, "目标日期有不同数据时保留原记录");
});

test("原创曝光以北京时间10点切日，同日更新、迟到保护、回落、零值及手动修正", () => {
  assert.equal(impressionDate("2026-10-28T15:59:59Z"), "2026-10-28");
  assert.equal(impressionDate("2026-10-29T01:59:59Z"), "2026-10-28");
  assert.equal(impressionDate("2026-10-29T02:00:00Z"), "2026-10-29");
  const first = validateImpression({ owner: "me", value: 23600, raw: "23.6K", collectedAt: "2026-10-28T16:00:00Z", secret: "drop" });
  assert.equal(first.date, "2026-10-28");
  assert.equal(first.secret, undefined);
  const row = (time, value) => validateImpression({ owner: "me", value, raw: String(value), collectedAt: time });
  const rows = mergeImpressions([first], [row("2026-10-29T01:00:00Z", 23600), row("2026-10-29T02:00:00Z", 23600), row("2026-10-29T03:00:00Z", 26000), row("2026-10-29T04:00:00Z", 27000), row("2026-10-30T16:00:00Z", 23000), row("2026-10-31T16:00:00Z", 0)]);
  assert.deepEqual(rows.map(row => [row.date, row.value]), [["2026-10-28", 23600], ["2026-10-29", 27000], ["2026-10-30", 23000], ["2026-10-31", 0]]);
  assert.deepEqual(mergeImpressions(rows, [first]), rows);
  const manual = validateImpression({ ...first, date: "2026-10-27", source: "manual", value: 20000, collectedAt: "2026-11-01T03:00:00Z" });
  assert.equal(mergeImpressions(rows, [manual])[0].date, "2026-10-27");
  const correction = { ...manual, date: "2026-10-31", value: 100 };
  assert.equal(mergeImpressions(rows, [correction]).at(-1).value, 100);
  assert.equal(mergeImpressions([correction], [row("2026-11-01T01:00:00Z", 500)]).at(-1).value, 100, "手动值不被自动覆盖");
  for (const change of [{ owner: "../me" }, { value: -1 }, { value: 1.5 }, { raw: "" }, { collectedAt: "bad" }, { date: "2026-02-30" }]) assert.throws(() => validateImpression({ ...first, ...change }));
});

test("汇总只统计已知指标，互动比处理缺失和零浏览，按本地小时分组", () => {
  assert.equal(interactionRate(sample), 0.1);
  assert.equal(interactionRate({ ...sample, metrics: { ...sample.metrics, views: 0 } }), null);
  assert.equal(interactionRate({ ...sample, metrics: { ...sample.metrics, replies: null } }), null);
  const summary = summarize([sample, { ...sample, metrics: { ...sample.metrics, views: null } }]);
  assert.deepEqual(summary.totals.views, { value: 100, samples: 1 });
  assert.deepEqual(summary.totals.bookmarks, { value: 0, samples: 0 });
  assert.deepEqual(summary.hours, [{ hour: new Date(sample.publishedAt).getHours(), samples: 1, views: 100, average: 100 }]);
  assert.deepEqual(summarize([]).hours, []);
});

test("CSV保留中文、引号换行、空指标和原值，并防止公式注入", () => {
  const csv = exportCsv([{ ...sample, text: '=HYPERLINK("https://evil.test")\n正文', quote: "\t@SUM(1)" }]);
  assert(csv.startsWith("\uFEFF"));
  assert(csv.includes('"\'=HYPERLINK(""https://evil.test"")\n正文"'));
  assert(csv.includes('"\'\t@SUM(1)"'));
  assert(csv.includes('"100","5","2","3","","0.1"'));
  assert(csv.includes('"5 Likes"'));
  assert(csv.includes('"1234567890123456789"'));
});

test("主页配置默认值、规范化和地址边界", () => {
  assert.equal(analyticsProfile().url, "https://x.com/1nhkjltx");
  assert.deepEqual(analyticsProfile(" https://twitter.com/ME/ "), { owner: "me", url: "https://x.com/me" });
  for (const value of ["https://evil.test/me", "http://x.com/me", "https://x.com/home", "https://x.com/me/status/1", "https://x.com/me?q=1", "https://user@x.com/me", "invalid"]) {
    assert.throws(() => analyticsProfile(value));
  }
});
