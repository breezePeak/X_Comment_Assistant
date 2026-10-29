export const LOCAL_POST_SERVICE = Object.freeze({ baseUrl: "http://127.0.0.1:12345", token: "" });

export function validatePostService(input = LOCAL_POST_SERVICE) {
  if (typeof input?.baseUrl !== "string" || (input.token !== undefined && typeof input.token !== "string")) throw new Error("帖子服务配置无效。");
  const baseUrl = input.baseUrl.trim().replace(/\/+$/, "");
  let url;
  try { url = new URL(baseUrl); } catch { throw new Error("请输入有效的热点服务地址。"); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error("服务地址须使用 HTTP 或 HTTPS，且不能包含账号、密码、查询参数或锚点。");
  }
  const token = input.token?.trim() || "";
  const local = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  if ((token || !local) && !/^[\x21-\x7e]{32,256}$/.test(token)) throw new Error("远程服务 Token 必须是 32—256 位非空格 ASCII 字符；本机服务可留空。");
  return { baseUrl, token };
}

export function imageSource(image, postId, index) {
  if (image.path === `/api/posts/${postId}/images/${index}`) return { path: image.path };
  const url = new URL(image.url);
  if (url.protocol !== "https:" || url.username || url.password) throw new Error("图片链接必须使用 HTTPS。");
  return { url: url.href };
}

export async function postServiceRequest(input, path, { method = "GET", body, signal, binary = false } = {}, fetcher = fetch) {
  const config = validatePostService(input);
  if (!/^\/api\/(?:posts|analytics\/(?:posts|impressions)|friendly\/(?:batch|consume|stats))(?:\?|\/|$)/.test(path) || path.includes("..") || path.includes("#")) throw new Error("帖子接口路径无效。");
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  const timeout = setTimeout(abort, 20000);
  try {
    const response = await fetcher(`${config.baseUrl}${path}`, {
      method, signal: controller.signal, credentials: "omit", redirect: "error", cache: "no-store",
      headers: { ...(config.token ? { Authorization: `Bearer ${config.token}` } : {}), ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    if (!response.ok) {
      if (response.status === 401) throw new Error("热点服务 Token 无效，请检查配置。");
      const data = await response.json().catch(() => ({}));
      throw new Error(typeof data.error === "string" ? data.error.slice(0, 300) : `热点服务请求失败（${response.status}）。`);
    }
    if (binary) {
      if (!["image/png", "image/jpeg", "image/webp"].includes(response.headers.get("content-type"))) throw new Error("服务器未返回支持的图片。");
      const blob = await response.blob();
      if (blob.size > 5 * 1024 * 1024) throw new Error("图片超过 5 MiB。");
      return blob;
    }
    return await response.json();
  } catch (error) {
    if (controller.signal.aborted && !signal?.aborted) throw new Error("热点服务请求超过 20 秒，请重试。");
    throw error;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", abort);
  }
}
