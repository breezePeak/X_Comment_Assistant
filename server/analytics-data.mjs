export const METRICS = ["views", "likes", "replies", "reposts", "bookmarks"];

export function impressionDate(time) {
  return new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Shanghai" }).format(new Date(Date.parse(time) - 10 * 60 * 60 * 1000));
}

export function validateImpression(data) {
  if (!data || typeof data.owner !== "string" || !/^[a-z0-9_]{1,15}$/.test(data.owner) ||
      !Number.isSafeInteger(data.value) || data.value < 0 || typeof data.raw !== "string" || !data.raw.trim() || data.raw.length > 100 ||
      typeof data.collectedAt !== "string" || !Number.isFinite(Date.parse(data.collectedAt))) throw new Error("原创曝光采集数据无效。");
  const date = data.date ?? impressionDate(data.collectedAt);
  if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0, 10) !== date) throw new Error("曝光日期无效。");
  return { owner: data.owner, date, value: data.value, raw: data.raw, collectedAt: data.collectedAt, ...(data.source === "manual" ? { source: "manual" } : {}) };
}

export function mergeImpressions(previous, incoming) {
  const rows = [...previous].sort((a, b) => a.date.localeCompare(b.date));
  for (const row of [...incoming].sort((a, b) => Date.parse(a.collectedAt) - Date.parse(b.collectedAt))) {
    const latest = rows.at(-1);
    const index = rows.findIndex(old => old.date === row.date);
    const old = rows[index];
    if (old && (Date.parse(row.collectedAt) < Date.parse(old.collectedAt) ||
        (row.source !== "manual" && old.source === "manual") ||
        (old.value === row.value && old.source === row.source))) continue;
    // 同日更新一条记录；手动补录允许修正历史，自动采集只更新最新日期。
    if (row.source !== "manual" && latest && (row.date < latest.date || (!old && row.value === latest.value))) continue;
    if (index >= 0) rows[index] = row;
    else rows.push(row);
    rows.sort((a, b) => a.date.localeCompare(b.date));
  }
  return rows;
}

export function validateCollection(data) {
  if (!data || typeof data.owner !== "string" || !/^[a-z0-9_]{1,15}$/.test(data.owner) || !Array.isArray(data.posts)) throw new Error("采集结果格式无效，请刷新 X 后重试。");
  return { owner: data.owner, posts: data.posts.map(post => {
    if (!post || typeof post.id !== "string" || !/^\d{1,30}$/.test(post.id) || post.owner !== data.owner ||
        post.url !== `https://x.com/${data.owner}/status/${post.id}` ||
        ["text", "quote"].some(key => typeof post[key] !== "string" || post[key].length > 100000) ||
        ["publishedAt", "collectedAt"].some(key => typeof post[key] !== "string" || !Number.isFinite(Date.parse(post[key]))) ||
        ["isQuote", "hasImage", "hasVideo", "textMayBeTruncated"].some(key => typeof post[key] !== "boolean") ||
        METRICS.some(key => !(post.metrics?.[key] === null || (Number.isSafeInteger(post.metrics?.[key]) && post.metrics[key] >= 0)) || typeof post.metricLabels?.[key] !== "string" || post.metricLabels[key].length > 1000)) {
      throw new Error("采集结果包含无效帖子或其他账号的数据，未保存。");
    }
    return {
      id: post.id, owner: post.owner, url: post.url, text: post.text, quote: post.quote,
      publishedAt: post.publishedAt, collectedAt: post.collectedAt,
      isQuote: post.isQuote, hasImage: post.hasImage, hasVideo: post.hasVideo, textMayBeTruncated: post.textMayBeTruncated,
      metrics: Object.fromEntries(METRICS.map(key => [key, post.metrics[key]])),
      metricLabels: Object.fromEntries(METRICS.map(key => [key, post.metricLabels[key]]))
    };
  }) };
}

export function postFingerprint(post) {
  return JSON.stringify([post.text, post.quote, post.publishedAt, post.isQuote, post.hasImage, post.hasVideo,
    post.textMayBeTruncated, ...METRICS.map(key => post.metrics[key]), ...METRICS.map(key => post.metricLabels[key])]);
}

export function mergePosts(previous, incoming) {
  const posts = new Map(previous.map(post => [post.id, post]));
  for (const post of incoming) {
    const old = posts.get(post.id);
    if (old && Date.parse(old.collectedAt) > Date.parse(post.collectedAt)) continue;
    // 重新采集时保留已展开的长文，指标始终使用本次快照；不可见指标留空。
    const next = { ...post, ...(old && post.textMayBeTruncated && !old.textMayBeTruncated ? { text: old.text, textMayBeTruncated: false } : {}) };
    posts.set(post.id, old && postFingerprint(old) === postFingerprint(next) ? old : next);
  }
  return [...posts.values()].sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt));
}

