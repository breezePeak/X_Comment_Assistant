export const DEFAULT_ANALYTICS_PROFILE = "https://x.com/1nhkjltx";

export function analyticsProfile(value = DEFAULT_ANALYTICS_PROFILE) {
  const url = new URL(value.trim());
  const match = url.pathname.match(/^\/([a-z0-9_]{1,15})\/?$/i);
  if (url.protocol !== "https:" || !["x.com", "twitter.com"].includes(url.hostname) || url.port || url.username || url.password || url.search || url.hash || !match ||
      /^(home|explore|notifications|messages|settings|search|compose|login|logout|signup|i)$/i.test(match[1])) {
    throw new Error("请填写 X 个人主页地址，例如 https://x.com/1nhkjltx。");
  }
  const owner = match[1].toLowerCase();
  return { owner, url: `https://x.com/${owner}` };
}
