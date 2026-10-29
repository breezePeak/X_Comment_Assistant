(() => {
  const articleSelector = '[data-testid="tweet"], article[role="article"]';
  let configuredOwner = "";
  function owner() { return configuredOwner; }
  function configure(result) {
    if (!contextAlive()) return;
    if (!result?.ok || !/^[a-z0-9_]{1,15}$/.test(result.owner)) return;
    configuredOwner = result.owner;
    scanAfterNavigationOrScroll();
  }

  function text(element) {
    if (!element) return "";
    const copy = element.cloneNode(true);
    copy.querySelectorAll("img[alt]").forEach(image => image.replaceWith(image.alt));
    copy.querySelectorAll("br").forEach(br => br.replaceWith("\n"));
    return copy.textContent.trim();
  }

  function count(element) {
    const label = element?.getAttribute("aria-label") || "";
    const raw = (/\d/.test(label) ? label : element?.textContent || label).trim();
    const match = raw.match(/(?:^|[^\d.,])((?:\d{1,3}(?:[,\s\u202f]\d{3})+|\d+)(?:\.\d+)?)\s*([KMB](?![A-Za-z])|[万亿千])?/i);
    if (!match) return { value: null, raw };
    const multiplier = { k: 1e3, m: 1e6, b: 1e9, 千: 1e3, 万: 1e4, 亿: 1e8 }[match[2]?.toLowerCase()] || 1;
    const value = Math.round(Number(match[1].replace(/[,\s\u202f]/g, "")) * multiplier);
    return { value: Number.isSafeInteger(value) ? value : null, raw };
  }

  function collect(handle) {
    if (!new RegExp(`^/${handle}(?:/with_replies)?/?$`, "i").test(location.pathname)) {
      throw new Error("请打开配置的个人主页（帖子或回复页），等待帖子加载后采集。");
    }
    const main = document.querySelector('[data-testid="primaryColumn"]');
    if (!main) throw new Error("主页尚未加载，请稍后重试。");
    const posts = new Map();
    // shortcut: 仅采集已加载的 DOM；长文需在 X 展开，X 改版时更新选择器。
    for (const article of main.querySelectorAll(articleSelector)) {
      if (article.parentElement.closest(articleSelector)) continue;
      const quoteCard = article.querySelector('[data-testid="quoteTweet"]') ||
        [...article.querySelectorAll('[role="link"]')].find(node => node.querySelector('[data-testid="User-Name"]'));
      const name = article.querySelector('[data-testid="User-Name"]');
      const time = name?.querySelector("time") || [...article.querySelectorAll("time")].find(node => node.closest(articleSelector) === article && !quoteCard?.contains(node));
      const link = time?.closest('a[href*="/status/"]');
      if (!link) continue;
      const url = new URL(link.href, location.href);
      const match = url.pathname.match(/^\/([A-Za-z0-9_]{1,15})\/status\/(\d+)\/?$/);
      if (url.origin !== location.origin || !match || match[1].toLowerCase() !== handle.toLowerCase()) continue;
      const publishedAt = time.getAttribute("datetime");
      if (!publishedAt || !Number.isFinite(Date.parse(publishedAt))) continue;
      const texts = [...article.querySelectorAll('[data-testid="tweetText"]')].filter(node => node.closest(articleSelector) === article);
      const ownTexts = texts.filter(node => !quoteCard?.contains(node));
      const quotedTexts = [...quoteCard?.querySelectorAll('[data-testid="tweetText"]') || []];
      const find = selector => [...article.querySelectorAll(selector)].find(node => node.closest(articleSelector) === article && !quoteCard?.contains(node));
      const metrics = {};
      const metricLabels = {};
      for (const [key, selector] of Object.entries({
        replies: '[data-testid="reply"]', reposts: '[data-testid="retweet"], [data-testid="unretweet"]',
        likes: '[data-testid="like"], [data-testid="unlike"]', bookmarks: '[data-testid="bookmark"], [data-testid="removeBookmark"]',
        views: 'a[href$="/analytics"], [data-testid="app-text-transition-container"] a[href*="/analytics"]'
      })) {
        const result = count(find(selector));
        metrics[key] = result.value;
        metricLabels[key] = result.raw;
      }
      posts.set(match[2], {
        id: match[2], owner: handle.toLowerCase(), url: `https://x.com/${handle.toLowerCase()}/status/${match[2]}`,
        text: ownTexts.map(text).join("\n\n"), quote: quotedTexts.map(text).join("\n\n"),
        isQuote: Boolean(quoteCard), hasImage: Boolean(find('[data-testid="tweetPhoto"]')),
        hasVideo: Boolean(find('[data-testid="videoPlayer"]')), publishedAt: new Date(publishedAt).toISOString(),
        collectedAt: new Date().toISOString(), metrics, metricLabels,
        textMayBeTruncated: Boolean(find('[data-testid="tweet-text-show-more-link"]'))
      });
    }
    return [...posts.values()];
  }

  const seen = new Map();
  let lastImpression = "";
  let savingImpression = false;
  async function scanImpressions() {
    if (!contextAlive() || !configuredOwner || savingImpression || !/^\/i\//.test(location.pathname)) return;
    const profile = document.querySelector('a[data-testid="AppTabBar_Profile_Link"]');
    if (!profile || new URL(profile.href, location.href).pathname.toLowerCase().replace(/\/$/, "") !== `/${configuredOwner}`) return;
    const main = document.querySelector('[data-testid="primaryColumn"]') || document.querySelector('main[role="main"]');
    if (!main) return;
    // shortcut: 依据奖励页中英文指标文案和可见数值定位，X 改版或新增语言时更新匹配。
    const matchesLabel = node => /Verified Home Timeline impressions|已认证.*(?:主页|首页).*曝光|认证.*(?:主页|首页).*展示/i.test(node.textContent);
    const label = [...main.querySelectorAll('span, div, p')].find(node => matchesLabel(node) && ![...node.children].some(matchesLabel));
    if (!label) return;
    let container = label.parentElement;
    let metric;
    for (let depth = 0; container && container !== main && depth < 6; depth++, container = container.parentElement) {
      const values = [...container.querySelectorAll('span, div, p')].filter(node =>
        !node.children.length && node.getClientRects().length && /^\s*\d[\d,.\s\u202f]*\s*(?:[KMB万亿千])?\s*$/i.test(node.textContent));
      if (values.length === 1) { metric = count(values[0]); break; }
      if (values.length > 1) return;
    }
    if (metric?.value === null || !metric) return;
    const collectedAt = new Date().toISOString();
    const date = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Shanghai" }).format(new Date(Date.parse(collectedAt) - 10 * 60 * 60 * 1000));
    const fingerprint = JSON.stringify([configuredOwner, date, metric.value]);
    if (fingerprint === lastImpression) return;
    savingImpression = true;
    try {
      const result = await chrome.runtime.sendMessage({ type: "SAVE_ORIGINAL_IMPRESSIONS", data: {
        owner: configuredOwner, value: metric.value, raw: metric.raw, collectedAt
      } });
      if (!result?.ok) throw new Error(result?.error || "原创曝光保存失败。");
      lastImpression = fingerprint;
    } catch (error) { if (contextAlive(error)) console.warn("原创曝光自动采集：", error.message); }
    finally { savingImpression = false; }
  }
  const pending = new Map();
  let timer;
  let sending = false;
  let stopped = false;
  let navigationTimer;

  function contextAlive(error) {
    if (stopped) return false;
    // 扩展更新后旧页面的脚本仍存活，失效时停止采集，刷新页面后由新脚本接管。
    if (chrome.runtime?.id && !/Extension context invalidated/i.test(error?.message || "")) return true;
    stopped = true;
    clearTimeout(timer);
    clearTimeout(settleTimer);
    clearInterval(navigationTimer);
    return false;
  }

  async function flush() {
    timer = null;
    if (!contextAlive() || sending || !pending.size) return;
    sending = true;
    try {
      for (const [handle, entries] of pending) {
        const batch = [...entries.values()];
        if (!batch.length) continue;
        const result = await chrome.runtime.sendMessage({ type: "SAVE_OWN_POSTS", data: { owner: handle, posts: batch.map(entry => entry.post) } });
        if (!result?.ok) throw new Error(result?.error || "自动采集未能保存，请刷新 X 后重试。");
        for (const entry of batch) {
          seen.set(`${handle}:${entry.post.id}`, entry.fingerprint);
          if (entries.get(entry.post.id) === entry) entries.delete(entry.post.id);
        }
        if (!entries.size) pending.delete(handle);
      }
    } catch (error) { if (contextAlive(error)) console.warn("本人帖子自动采集：", error.message); }
    finally {
      sending = false;
      if (contextAlive() && pending.size) timer = setTimeout(flush, 5000);
    }
  }

  function scan() {
    if (!contextAlive()) return;
    const handle = owner();
    if (!handle || !new RegExp(`^/${handle}(?:/with_replies)?/?$`, "i").test(location.pathname)) return;
    try {
      const account = handle.toLowerCase();
      for (const post of collect(handle)) {
        const fingerprint = JSON.stringify({ ...post, collectedAt: undefined });
        const entries = pending.get(account) || new Map();
        if (fingerprint === seen.get(`${account}:${post.id}`) && !entries.has(post.id)) continue;
        if (entries.get(post.id)?.fingerprint === fingerprint) continue;
        entries.set(post.id, { post, fingerprint });
        pending.set(account, entries);
      }
      // 固定间隔写入，连续滚动也不会一直推迟保存；先缓存在内存以保留虚拟列表移走的帖子。
      if (pending.size && !timer && !sending) timer = setTimeout(flush, 400);
    } catch { /* 主页加载中，下一次滚动或页面变化时重试。 */ }
  }

  let settleTimer;
  function scanAfterNavigationOrScroll() {
    if (!contextAlive()) return;
    void scanImpressions();
    scan();
    clearTimeout(settleTimer);
    if (!configuredOwner || !new RegExp(`^/${configuredOwner}(?:/with_replies)?/?$`, "i").test(location.pathname)) return;
    // 滚动事件先于 X 异步渲染，稍后补读新加载的帖子。
    settleTimer = setTimeout(scan, 800);
  }
  window.addEventListener("wheel", scanAfterNavigationOrScroll, { passive: true, capture: true });
  window.addEventListener("scroll", scanAfterNavigationOrScroll, { passive: true, capture: true });
  window.addEventListener("popstate", scanAfterNavigationOrScroll);
  window.addEventListener("online", () => { if (!sending) { clearTimeout(timer); void flush(); } });
  window.addEventListener("pagehide", () => { clearTimeout(timer); void flush(); });
  // X 使用 pushState 切页，URL 变化时可能没有 DOM 或 popstate 事件。
  let lastPath = location.pathname;
  navigationTimer = setInterval(() => {
    if (!contextAlive()) return;
    void scanImpressions();
    if (lastPath === location.pathname) return;
    lastPath = location.pathname;
    scanAfterNavigationOrScroll();
  }, 500);
  async function loadProfile() {
    if (!contextAlive()) return;
    try { configure(await chrome.runtime.sendMessage({ type: "GET_ANALYTICS_PROFILE" })); }
    catch (error) { if (contextAlive(error)) console.warn(error); }
  }
  void loadProfile();

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!contextAlive() || sender.id !== chrome.runtime.id) return;
    if (message?.type === "ANALYTICS_PROFILE") { configure(message); return; }
    if (!["OPEN_OWN_POSTS", "COLLECT_OWN_POSTS", "GET_OWN_POSTS_OWNER"].includes(message?.type)) return;
    try {
      const handle = owner();
      if (!handle) throw new Error("主页配置尚未加载，请稍后重试。");
      if (message.type === "GET_OWN_POSTS_OWNER") sendResponse({ ok: true, owner: handle.toLowerCase() });
      else if (message.type === "OPEN_OWN_POSTS") {
        sendResponse({ ok: true });
        location.assign(`/${handle}`);
      } else {
        const posts = collect(handle);
        scan();
        sendResponse({ ok: true, owner: handle.toLowerCase(), posts });
      }
    } catch (error) { sendResponse({ ok: false, error: error.message }); }
  });
})();
