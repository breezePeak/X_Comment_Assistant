import { validateCollection, mergePosts, postFingerprint, validateImpression, mergeImpressions } from "./analytics-data.js";
import { postServiceRequest, validatePostService } from "./posts-api.js";

let writes = Promise.resolve();
let syncing;
const keyFor = owner => `analytics:${owner}`;
const storedPosts = (saved, owner) => {
  const data = validateCollection(saved || { owner, posts: [] });
  if (data.owner !== owner) throw new Error("本机记录账号不匹配，已停止操作。");
  return data.posts;
};
const pendingIds = saved => saved?.pending ?? saved?.posts.map(post => post.id) ?? [];

function write(run) {
  const next = writes.then(run);
  writes = next.catch(() => {});
  return next;
}

async function config() {
  const value = validatePostService((await chrome.storage.local.get("postService")).postService);
  const url = new URL(value.baseUrl);
  if (!await chrome.permissions.contains({ origins: [`${url.protocol}//${url.hostname}/*`] })) throw new Error("请在设置中保存并授权帖子服务域名。");
  return value;
}

async function save(data) {
  await write(async () => {
    const key = keyFor(data.owner);
    const saved = (await chrome.storage.local.get(key))[key];
    const previous = storedPosts(saved, data.owner);
    const posts = mergePosts(previous, data.posts);
    const old = new Map(previous.map(post => [post.id, post]));
    const changed = posts.filter(post => old.get(post.id) !== post);
    if (!changed.length && saved?.pending) return;
    const pending = [...new Set([...pendingIds(saved), ...changed.map(post => post.id)])];
    await chrome.storage.local.set({ [key]: { ...saved, owner: data.owner, posts, pending }, analyticsOwner: data.owner });
  });
  void syncPendingPosts();
}

async function saveImpression(data) {
  await write(async () => {
    const key = keyFor(data.owner);
    const saved = (await chrome.storage.local.get(key))[key];
    const posts = storedPosts(saved, data.owner);
    const previous = saved?.impressions || [];
    const impressions = mergeImpressions(previous, [data]);
    if (impressions.length === previous.length && impressions.every((row, index) => row === previous[index])) return;
    await chrome.storage.local.set({ [key]: { ...saved, owner: data.owner, posts, pending: pendingIds(saved), impressions,
      pendingImpressions: [...new Set([...(saved?.pendingImpressions || []), data.date])] } });
  });
  void syncPendingPosts();
}

export function syncPendingPosts() {
  if (syncing) return syncing;
  syncing = (async () => {
    let owner;
    try {
      const all = await chrome.storage.local.get(null);
      const entries = Object.entries(all).filter(([key, saved]) => /^analytics:[a-z0-9_]{1,15}$/.test(key) && (pendingIds(saved).length || saved.pendingImpressions?.length));
      if (!entries.length) return;
      const service = await config();
      for (const [key] of entries) {
        owner = key.slice("analytics:".length);
        while (true) {
          const saved = (await chrome.storage.local.get(key))[key];
          const pending = new Set(pendingIds(saved));
          const batch = storedPosts(saved, owner).filter(post => pending.has(post.id)).slice(0, 20);
          if (!batch.length) break;
          const result = await postServiceRequest(service, "/api/analytics/posts", { method: "POST", body: { owner, posts: batch } });
          if (result?.accepted !== batch.length) throw new Error("帖子服务未确认完整入库，数据保留待重试；请确认服务端已更新。");
          const acknowledged = await write(async () => {
            const currentService = validatePostService((await chrome.storage.local.get("postService")).postService);
            if (currentService?.baseUrl !== service.baseUrl || currentService?.token !== service.token) return false;
            const current = (await chrome.storage.local.get(key))[key];
            if (!current) return;
            const sent = new Map(batch.map(post => [post.id, post]));
            const remaining = new Set(pendingIds(current));
            for (const post of current.posts) {
              const uploaded = sent.get(post.id);
              if (uploaded && post.collectedAt === uploaded.collectedAt && postFingerprint(post) === postFingerprint(uploaded)) remaining.delete(post.id);
            }
            await chrome.storage.local.set({ [key]: { ...current, pending: [...remaining] }, analyticsSync: { owner, error: "", syncedAt: new Date().toISOString() } });
            return true;
          });
          if (acknowledged === false) return;
        }
        while (true) {
          const saved = (await chrome.storage.local.get(key))[key];
          const row = saved?.impressions?.find(row => saved.pendingImpressions?.includes(row.date));
          if (!row) break;
          const result = await postServiceRequest(service, "/api/analytics/impressions", { method: "POST", body: row });
          if (result?.accepted !== 1) throw new Error("原创曝光未确认入库，请更新帖子服务；本机数据保留待重试。");
          const acknowledged = await write(async () => {
            const currentService = validatePostService((await chrome.storage.local.get("postService")).postService);
            if (currentService.baseUrl !== service.baseUrl || currentService.token !== service.token) return false;
            const current = (await chrome.storage.local.get(key))[key];
            if (!current) return;
            const unchanged = JSON.stringify(current.impressions?.find(item => item.date === row.date)) === JSON.stringify(row);
            await chrome.storage.local.set({ [key]: { ...current, pendingImpressions: (current.pendingImpressions || []).filter(date => date !== row.date || !unchanged) },
              analyticsSync: { owner, error: "", syncedAt: new Date().toISOString() } });
            return true;
          });
          if (acknowledged === false) return;
        }
      }
    } catch (error) {
      await chrome.storage.local.set({ analyticsSync: { owner: owner || null, error: error.message, syncedAt: null } }).catch(console.error);
    }
  })().finally(() => { syncing = null; });
  return syncing;
}

async function load(owner) {
  return write(async () => {
    const key = keyFor(owner);
    let saved = (await chrome.storage.local.get(key))[key];
    const posts = storedPosts(saved, owner);
    // 与已更正的数据库一致，修复这条曾被旧版误记为29日的浏览器缓存。
    const wrong = owner === "1nhkjltx" && saved?.impressions?.find(row => row.date === "2026-10-29" &&
      row.value === 23600 && row.collectedAt === "2026-10-29T01:16:52.887Z" && row.source !== "manual");
    const target = saved?.impressions?.find(row => row.date === "2026-10-28");
    if (wrong && (!target || target.value === wrong.value)) {
      const impressions = saved.impressions.filter(row => row !== wrong);
      if (!target) impressions.push({ ...wrong, date: "2026-10-28" });
      impressions.sort((a, b) => a.date.localeCompare(b.date));
      saved = { ...saved, impressions, pendingImpressions: [...new Set([
        ...(saved.pendingImpressions || []).filter(date => date !== "2026-10-29"), "2026-10-28"
      ])] };
      await chrome.storage.local.set({ [key]: saved });
    }
    return { owner, posts, impressions: saved?.impressions || [], pending: pendingIds(saved).length };
  });
}

export function handleAnalyticsMessage(message, sender, respond) {
  if (sender.id !== chrome.runtime.id) return;
  const fromX = Number.isInteger(sender.tab?.id) && /^https:\/\/(x|twitter)\.com\//.test(sender.url || "");
  const fromPanel = sender.url === chrome.runtime.getURL("sidepanel.html");
  const fromCollection = ["SAVE_OWN_POSTS", "SAVE_ORIGINAL_IMPRESSIONS"].includes(message.type);
  if (fromCollection ? !fromX : !fromPanel) return;
  let task;
  try {
    if (["SAVE_ORIGINAL_IMPRESSIONS", "ADD_ORIGINAL_IMPRESSIONS"].includes(message.type)) {
      const data = message.type === "ADD_ORIGINAL_IMPRESSIONS" ? { ...message.data, source: "manual" } : { ...message.data, date: undefined, source: undefined };
      task = saveImpression(validateImpression(data)).then(() => ({ ok: true }));
    } else if (message.type === "SAVE_OWN_POSTS") {
      const data = validateCollection(message.data);
      task = save(data).then(() => ({ ok: true }));
    } else {
      if (typeof message.owner !== "string" || !/^[a-z0-9_]{1,15}$/.test(message.owner)) throw new Error("账号无效。");
      task = message.type === "LOAD_OWN_POSTS" ? load(message.owner).then(data => ({ ok: true, ...data })) :
        write(() => chrome.storage.local.remove(keyFor(message.owner))).then(() => ({ ok: true }));
    }
  } catch (error) { respond({ ok: false, error: error.message }); return; }
  task.then(respond).catch(error => {
    if (fromCollection) chrome.storage.session.set({ analyticsError: error.message }).catch(console.error);
    respond({ ok: false, error: error.message });
  });
  return true;
}

chrome.alarms.create("analytics-sync", { periodInMinutes: 1 }).catch(console.error);
chrome.alarms.onAlarm.addListener(alarm => { if (alarm.name === "analytics-sync") void syncPendingPosts(); });
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !changes.postService?.newValue) return;
  void write(async () => {
    if (changes.postService.oldValue?.baseUrl === changes.postService.newValue.baseUrl) return;
    const all = await chrome.storage.local.get(null);
    for (const [key, saved] of Object.entries(all)) {
      if (!/^analytics:[a-z0-9_]{1,15}$/.test(key)) continue;
      await chrome.storage.local.set({ [key]: { ...saved, pending: saved.posts.map(post => post.id), pendingImpressions: (saved.impressions || []).map(row => row.date) } });
    }
  }).then(syncPendingPosts).catch(console.error);
});
void syncPendingPosts();
