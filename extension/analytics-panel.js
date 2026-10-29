import { analyticsProfile } from "./analytics-profile.js";
import { METRICS, validateCollection, interactionRate, summarize, exportCsv, impressionDate } from "./analytics-data.js";

const $ = id => document.getElementById(id);
let owner = "";
let posts = [];
let impressions = [];
let busy = false;
const names = { views: "浏览", likes: "赞", replies: "回复", reposts: "转帖", bookmarks: "收藏" };
const number = value => value === null ? "未显示" : value.toLocaleString();

function status(message, error = false) {
  $("analytics-status").textContent = message;
  $("analytics-status").classList.toggle("error", error);
}

function render() {
  $("analytics-impressions-save").disabled = busy || !owner;
  $("analytics-owner").textContent = owner ? `@${owner} · 已保存 ${posts.length} 条` : "尚未采集";
  for (const id of ["csv", "json", "clear"]) $("analytics-" + id).disabled = busy || (!posts.length && (id === "csv" || !impressions.length));
  $("analytics-impressions-empty").hidden = impressions.length > 0;
  const latestImpression = impressions.at(-1);
  $("analytics-impressions-card").hidden = !latestImpression;
  $("analytics-impressions-history").hidden = !latestImpression;
  $("analytics-impressions-value").textContent = latestImpression?.raw || "";
  $("analytics-impressions-date").textContent = latestImpression ? `约 ${number(latestImpression.value)} · ${latestImpression.date} 记录` : "";
  $("analytics-impressions").replaceChildren(...[...impressions].reverse().map(row => {
    const item = document.createElement("li");
    item.textContent = `${row.date} · ${row.raw}（约 ${number(row.value)}）${row.source === "manual" ? " · 手动" : ""}`;
    return item;
  }));
  const { totals, hours } = summarize(posts);
  $("analytics-summary").textContent = posts.length ? METRICS.map(key => `${names[key]} ${totals[key].samples ? number(totals[key].value) : "未显示"}（${totals[key].samples} 条有数据）`).join(" · ") : "进入自己的主页后自动采集；滚动加载更多帖子会持续累计并上传。";
  const cards = $("analytics-metrics");
  cards.replaceChildren();
  for (const key of METRICS) {
    const { value, samples } = totals[key];
    const card = document.createElement("article");
    card.className = "source-card";
    const label = document.createElement("h3");
    label.textContent = names[key];
    const total = document.createElement("strong");
    total.textContent = samples ? number(value) : "未显示";
    const average = document.createElement("p");
    average.textContent = `篇均 ${samples ? number(Math.round(value / samples * 100) / 100) : "未显示"} · ${samples} 条有数据`;
    card.append(label, total, average);
    cards.append(card);
  }
  $("analytics-hours-empty").hidden = hours.length > 0;
  const hoursList = $("analytics-hours");
  hoursList.replaceChildren();
  for (const row of hours) {
    const item = document.createElement("li");
    item.textContent = `${String(row.hour).padStart(2, "0")}:00—${String(row.hour).padStart(2, "0")}:59 · 平均浏览 ${Math.round(row.average).toLocaleString()} · ${row.samples} 条${row.samples < 3 ? "（样本少）" : ""}`;
    const bar = document.createElement("meter");
    bar.min = 0;
    bar.max = Math.max(1, ...hours.map(row => row.average));
    bar.value = row.average;
    bar.setAttribute("aria-label", `${row.hour} 时平均浏览`);
    item.append(bar);
    hoursList.append(item);
  }
  const sort = $("analytics-sort").value;
  const ordered = [...posts].sort((a, b) => {
    if (sort === "rate") return (interactionRate(b) ?? -1) - (interactionRate(a) ?? -1);
    if (sort === "views") return (b.metrics.views ?? -1) - (a.metrics.views ?? -1);
    return Date.parse(b.publishedAt) - Date.parse(a.publishedAt);
  });
  $("analytics-list").replaceChildren();
  for (const post of ordered) {
    const card = document.createElement("article");
    card.className = "source-card analytics-post";
    const link = document.createElement("a");
    link.href = post.url;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.textContent = `${new Date(post.publishedAt).toLocaleString()} ↗`;
    const tags = document.createElement("small");
    tags.textContent = [post.isQuote ? "引用帖" : "帖子", post.hasImage ? "含图片" : "", post.hasVideo ? "含视频" : "", post.textMayBeTruncated ? "正文未展开" : ""].filter(Boolean).join(" · ");
    const details = document.createElement("details");
    const preview = document.createElement("summary");
    preview.textContent = post.text.slice(0, 90) || "无正文（媒体或引用帖）";
    const body = document.createElement("p");
    body.textContent = post.text;
    details.append(preview, body);
    if (post.quote) {
      const quote = document.createElement("blockquote");
      quote.textContent = post.quote;
      details.append(quote);
    }
    const metrics = document.createElement("p");
    metrics.textContent = METRICS.map(key => `${names[key]} ${number(post.metrics[key])}`).join(" · ");
    const rate = document.createElement("small");
    const value = interactionRate(post);
    rate.textContent = `互动比 ${value === null ? "数据不足" : (value * 100).toFixed(2) + "%"} · 更新于 ${new Date(post.collectedAt).toLocaleString()}`;
    card.append(link, tags, details, metrics, rate);
    $("analytics-list").append(card);
  }
}

async function request(type) {
  const { id: windowId } = await chrome.windows.getCurrent();
  const [tab] = await chrome.tabs.query({ active: true, windowId });
  if (!tab?.id || !/^https:\/\/(x|twitter)\.com\//.test(tab.url || "")) throw new Error("请切换到已登录的 X 标签页。");
  let result;
  try { result = await chrome.tabs.sendMessage(tab.id, { type }); }
  catch { throw new Error("无法连接 X 页面，请刷新 X 后重试。"); }
  if (!result?.ok) throw new Error(result?.error || "X 页面未返回有效结果，请刷新后重试。");
  return result;
}

async function action(run) {
  if (busy) return;
  busy = true;
  $("analytics-open").disabled = true;
  render();
  try { await run(); }
  catch (error) { status(error.message, true); }
  finally { busy = false; $("analytics-open").disabled = false; render(); }
}

$("analytics-open").addEventListener("click", () => { void action(async () => {
  await request("OPEN_OWN_POSTS");
  status("进入自己的主页后自动采集，滚动即可持续更新并上传，引用帖也会收录。");
}); });

$("analytics-impressions-manual").addEventListener("toggle", () => {
  if ($("analytics-impressions-manual").open && !$("analytics-impressions-input-date").value) $("analytics-impressions-input-date").value = impressionDate(new Date().toISOString());
});
$("analytics-impressions-form").addEventListener("submit", event => {
  event.preventDefault();
  const data = { owner, date: $("analytics-impressions-input-date").value, value: Number($("analytics-impressions-input-value").value),
    raw: $("analytics-impressions-input-value").value, collectedAt: new Date().toISOString() };
  void action(async () => {
    const result = await chrome.runtime.sendMessage({ type: "ADD_ORIGINAL_IMPRESSIONS", data });
    if (!result?.ok) throw new Error(result?.error || "手动曝光保存失败。");
    await load();
    status(`已保存 ${data.date} 原创曝光 ${number(data.value)}。`);
  });
});

$("analytics-clear").addEventListener("click", () => { void action(async () => {
  if (!confirm(`清除 @${owner} 的本机缓存（包括未上传数据）？服务端记录保留，本机数据需重新浏览主页采集。`)) return;
  const result = await chrome.runtime.sendMessage({ type: "CLEAR_OWN_POSTS", owner });
  if (!result?.ok) throw new Error(result?.error || "清除缓存失败。");
  posts = [];
  impressions = [];
  status("本机缓存已清除；已上传的服务端记录保留。");
}); });

function download(format) {
  const body = format === "csv" ? exportCsv(posts) : JSON.stringify({
    owner, exportedAt: new Date().toISOString(), timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    metricNote: "页面可见快照；null 为未显示；页面缩写可能为近似数；互动比=(赞+回复+转帖)/浏览；仅采集本人发布，含本人引用帖。原创曝光为近90天已认证用户首页时间线曝光，不含回复，按北京时间记录。", posts, impressions
  }, null, 2);
  const url = URL.createObjectURL(new Blob([body], { type: format === "csv" ? "text/csv;charset=utf-8" : "application/json;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `x-${owner}-${new Date().toISOString().slice(0, 10)}.${format}`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  status(`已导出 ${posts.length} 条 ${format.toUpperCase()} 数据。`);
}
for (const format of ["csv", "json"]) $("analytics-" + format).addEventListener("click", () => download(format));
$("analytics-sort").addEventListener("change", render);

async function load() {
  const { analyticsProfileUrl } = await chrome.storage.local.get("analyticsProfileUrl");
  const profile = analyticsProfile(analyticsProfileUrl);
  const result = await chrome.runtime.sendMessage({ type: "LOAD_OWN_POSTS", owner: profile.owner });
  if (!result?.ok) throw new Error(result?.error || "读取本机采集数据失败。");
  const data = validateCollection(result);
  owner = data.owner;
  posts = data.posts;
  impressions = result.impressions || [];
  status(`正在监听 @${owner} 的主页；返回主页并滚动即可自动采集。已保存 ${posts.length} 条。`);
  try {
    await request("COLLECT_OWN_POSTS");
    status(`已在 @${owner} 主页，正在自动采集；滚动会持续更新。`);
  } catch (error) {
    status(`正在等待返回 @${owner} 主页。${error.message}`);
  }
}
$("view-analytics").addEventListener("click", () => { void action(load); });
for (const page of ["posts", "analysis"]) {
  $("analytics-tab-" + page).addEventListener("click", () => {
    for (const name of ["posts", "analysis"]) {
      $("analytics-" + name + "-page").hidden = name !== page;
      $("analytics-tab-" + name).setAttribute("aria-pressed", String(name === page));
    }
    render();
  });
}
chrome.tabs.onActivated.addListener(() => { if (!$("analytics-view").hidden) void action(load); });
chrome.tabs.onUpdated.addListener((_tabId, change) => {
  if (!$("analytics-view").hidden && (change.url || change.status === "complete")) void action(load);
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "session" && changes.analyticsError?.newValue) status(`自动采集保存失败：${changes.analyticsError.newValue}。请导出或检查本机存储。`, true);
  if (area !== "local") return;
  if (changes.analyticsProfileUrl && !busy) { void action(load); return; }
  const changedOwner = owner;
  const saved = changes[`analytics:${changedOwner}`]?.newValue;
  if (saved) {
    try {
      const data = validateCollection(saved);
      owner = data.owner;
      posts = data.posts;
      impressions = saved.impressions || [];
      if (!$("analytics-view").hidden) render();
      status(`自动采集中 · 已保存 ${posts.length} 条 · ${saved.pending?.length || 0} 条待上传。`);
    } catch (error) { status(error.message, true); }
  }
  if (changes.analyticsSync?.newValue) {
    const sync = changes.analyticsSync.newValue;
    if (!sync.owner || sync.owner === owner) status(sync.error ? `上传未完成：${sync.error} 本机待上传数据保留，将自动重试。` : `已自动上传 · ${new Date(sync.syncedAt).toLocaleString()}`, Boolean(sync.error));
  }
});
render();
