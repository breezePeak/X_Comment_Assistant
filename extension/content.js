(() => {
  if (globalThis.__xCommentAssistantLoaded) return;
  globalThis.__xCommentAssistantLoaded = true;
  const articleSelector = '[data-testid="tweet"], article[role="article"]';
  const editorSelector = '[contenteditable="true"][data-testid^="tweetTextarea_"]';
  let lastClicked;
  let lastSent = "";
  let threadPath = "";
  let threadRoot = null;
  let enabled = false;
  let stateReceived = false;
  let hasSelection = false;

  function statusPath(value) {
    if (!value) return "";
    try { return new URL(value, location.origin).pathname.match(/^\/[A-Za-z0-9_]+\/status\/\d+/)?.[0] || ""; }
    catch { return ""; }
  }

  function text(element) {
    if (!element) return "";
    const copy = element.cloneNode(true);
    copy.querySelectorAll("img[alt]").forEach(image => image.replaceWith(image.alt));
    copy.querySelectorAll("br").forEach(br => br.replaceWith("\n"));
    copy.querySelectorAll("time").forEach(time => time.remove());
    return copy.textContent.trim();
  }

  function extractPost(article) {
    const texts = [...article.querySelectorAll('[data-testid="tweetText"]')]
      .filter(node => node.closest(articleSelector) === article);
    const time = [...article.querySelectorAll("time")]
      .find(node => node.closest(articleSelector) === article);
    const link = time?.closest('a[href*="/status/"]');
    return {
      url: link ? new URL(link.getAttribute("href"), location.origin).href.split("?")[0].split("#")[0] : "",
      author: text(article.querySelector('[data-testid="User-Name"]')).replace(/[\s·]+$/, ""),
      text: text(texts[0]),
      quote: texts.slice(1).map(text).join("\n\n"),
      hasMedia: Boolean(article.querySelector('[data-testid="tweetPhoto"], [data-testid="videoPlayer"]'))
    };
  }

  function samePost(first, second) {
    const author = post => post.author.match(/@[A-Za-z0-9_]+/)?.[0] || post.author;
    return first.text === second.text && first.quote === second.quote && author(first) === author(second);
  }

  function readThreadRoot() {
    const path = statusPath(location.pathname);
    if (!path) {
      if (location.pathname !== "/compose/post") {
        if (threadPath) lastClicked = null;
        threadPath = ""; threadRoot = null;
      }
      return threadRoot;
    }
    if (path !== threadPath) { threadPath = path; threadRoot = null; lastClicked = null; }
    const scope = document.querySelector('[data-testid="primaryColumn"]') || document;
    const articles = [...scope.querySelectorAll(articleSelector)].filter(article =>
      !article.closest('[role="dialog"]') && !article.parentElement.closest(articleSelector));
    const focused = articles.findIndex(article => statusPath(extractPost(article).url) === path ||
      [...article.querySelectorAll('a[href*="/status/"]')].some(link =>
        link.closest(articleSelector) === article && statusPath(link.getAttribute("href")) === path));
    if (focused < 0) return threadRoot;
    const ancestors = articles.slice(0, focused + 1).map(extractPost);
    if (!ancestors[focused].url) ancestors[focused].url = `${location.origin}${path}`;
    // 保留滚动前已读取的主帖；只在当前会话中更新，不从其他时间线猜上下文。
    if (!threadRoot || ancestors.some(post => post.url === threadRoot.url)) threadRoot = ancestors[0];
    return threadRoot;
  }

  function withContext(post, article) {
    const root = readThreadRoot();
    const selectedPath = statusPath(post.url);
    post.isReply = Boolean(post.rootPost || (threadPath && selectedPath && selectedPath !== threadPath));
    if (article) {
      const scope = article.closest('[data-testid="primaryColumn"]');
      const recommended = scope && [...scope.querySelectorAll('h2, [role="heading"]')].some(heading =>
        /^(Discover more|More posts|发现更多|更多帖子|为你推荐)$/i.test(heading.textContent.trim()) &&
        (heading.compareDocumentPosition(article) & Node.DOCUMENT_POSITION_FOLLOWING));
      if (recommended) { post.isReply = false; return post; }
    }
    if (root && ((root.url && post.url) ? root.url !== post.url : !samePost(root, post))) {
      post.rootPost = { ...root };
      post.isReply = true;
    } else if (lastClicked?.rootPost && samePost(post, lastClicked)) {
      post.rootPost = { ...lastClicked.rootPost };
      post.isReply = true;
    }
    return post;
  }

  function currentPost() {
    if (!enabled) return null;
    readThreadRoot();
    const dialogs = [...document.querySelectorAll('[role="dialog"]')].reverse();
    const dialog = dialogs.find(node => node.getClientRects().length && node.querySelector(editorSelector));
    if (dialog) {
      const articles = [...dialog.querySelectorAll(articleSelector)].filter(node => !node.parentElement.closest(articleSelector));
      const article = articles[articles.length - 1];
      if (!article) return null;
      const post = extractPost(article);
      if (!post.url) {
        // 回复弹窗会移除原帖链接，只用同一作者和正文匹配时间线，不猜测帖子地址。
        if (lastClicked?.url && samePost(post, lastClicked)) post.url = lastClicked.url;
        else {
          const matches = [...document.querySelectorAll(articleSelector)]
            .filter(node => !node.closest('[role="dialog"]'))
            .map(extractPost).filter(item => item.url && samePost(post, item));
          const urls = [...new Set(matches.map(item => item.url))];
          if (urls.length === 1) post.url = urls[0];
        }
      }
      if (!threadRoot && articles.length > 1) {
        post.rootPost = extractPost(articles[0]);
        post.isReply = true;
      }
      return withContext(post, article);
    }
    const path = location.pathname.match(/^\/[A-Za-z0-9_]+\/status\/\d+/)?.[0];
    if (lastClicked && threadPath && lastClicked.isReply) return lastClicked;
    if (!path || !document.querySelector(editorSelector)) return null;
    const article = [...document.querySelectorAll(articleSelector)].find(node =>
      statusPath(extractPost(node).url) === path);
    return article ? withContext(extractPost(article), article) : null;
  }

  function notify(message) {
    const notice = document.createElement("div");
    notice.setAttribute("role", "status");
    notice.textContent = `X 评论助手：${message}`;
    Object.assign(notice.style, {
      position: "fixed", bottom: "24px", left: "50%", transform: "translateX(-50%)",
      zIndex: "2147483647", padding: "14px 20px", background: "#17212b", color: "#fff",
      borderRadius: "12px", font: "14px/1.6 system-ui", maxWidth: "80vw", boxShadow: "0 8px 40px #0004"
    });
    document.body.append(notice);
    setTimeout(() => notice.remove(), 5000);
  }

  function selectPost(post, openPanel = false) {
    if (!enabled || !post) return;
    const key = JSON.stringify(post);
    if (!openPanel && key === lastSent) return;
    lastSent = key;
    try {
      chrome.runtime.sendMessage({ type: "POST_SELECTED", post, openPanel }, response => {
        if (chrome.runtime.lastError) {
          notify("插件刚刚更新或连接已断开，请刷新 X 页面后重试。");
        } else if (!response?.ok) notify(response?.error || "未能读取帖子，请重试。");
      });
    } catch { notify("请刷新 X 页面后重试。"); }
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (sender.id !== chrome.runtime.id) return;
    if (message?.type === "ASSISTANT_STATE") {
      stateReceived = true;
      setEnabled(message.enabled === true);
      sendResponse({ ok: true });
    } else if (message?.type === "GET_CURRENT_POST") {
      const post = currentPost();
      hasSelection = Boolean(post);
      sendResponse({ ok: true, post, disabled: !enabled });
    }
  });

  function onClick(event) {
    if (!enabled || !event.isTrusted || !(event.target instanceof Element)) return;
    const reply = event.target.closest('[data-testid="reply"]');
    const inline = event.target.closest('[data-testid^="tweetTextarea_"]');
    if (!reply && !inline) return;
    hasSelection = true;
    if (inline) {
      if (!inline.closest('[role="dialog"]')) lastClicked = null;
      selectPost(currentPost(), true);
      return;
    }
    const article = reply.closest(articleSelector);
    if (article) {
      lastClicked = withContext(extractPost(article), article);
      selectPost(lastClicked, true);
    }
  }

  function onFocus(event) {
    if (enabled && hasSelection && event.isTrusted && event.target instanceof Element && event.target.matches(editorSelector)) {
      selectPost(currentPost());
    }
  }

  // shortcut: 仅识别 DOM 可见文字；X 调整回复弹窗结构时需更新选择器。
  let timer;
  function syncCurrent() {
    if (!enabled) return;
    readThreadRoot();
    if (!hasSelection) return;
    const post = currentPost();
    if (post) selectPost(post);
    else lastSent = "";
  }
  const observer = new MutationObserver(() => {
    clearTimeout(timer);
    timer = setTimeout(syncCurrent, 120);
  });

  function setEnabled(value) {
    if (enabled === value) return;
    enabled = value;
    clearTimeout(timer);
    lastClicked = null;
    lastSent = "";
    threadPath = "";
    threadRoot = null;
    hasSelection = false;
    if (enabled) {
      document.addEventListener("click", onClick, true);
      document.addEventListener("focusin", onFocus, true);
      observer.observe(document.body, { childList: true, subtree: true, characterData: true });
      readThreadRoot();
    } else {
      document.removeEventListener("click", onClick, true);
      document.removeEventListener("focusin", onFocus, true);
      observer.disconnect();
    }
  }

  chrome.runtime.sendMessage({ type: "GET_ASSISTANT_STATE" }, response => {
    if (!chrome.runtime.lastError && !stateReceived) setEnabled(response?.enabled === true);
  });
})();
