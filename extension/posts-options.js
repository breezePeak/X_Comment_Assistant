import { LOCAL_POST_SERVICE, postServiceRequest, validatePostService } from "./posts-api.js";

const $ = id => document.getElementById(id);
function status(message, error = false) {
  $("posts-config-status").textContent = message;
  $("posts-config-status").classList.toggle("error", error);
}

$("posts-config-form").addEventListener("submit", async event => {
  event.preventDefault();
  $("posts-save").disabled = true;
  $("posts-disconnect").disabled = true;
  try {
    const config = validatePostService({ baseUrl: $("posts-base-url").value, token: $("posts-token").value });
    const serviceUrl = new URL(config.baseUrl);
    const allowed = await chrome.permissions.request({ origins: [`${serviceUrl.protocol}//${serviceUrl.hostname}/*`] });
    if (!allowed) throw new Error("未获得热点服务域名授权，配置尚未保存。");
    status("正在验证连接…");
    const data = await postServiceRequest(config, "/api/posts?limit=1");
    if (!Array.isArray(data.posts)) throw new Error("服务响应格式不正确，请填写本项目的热点服务地址。");
    await chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
    await chrome.storage.local.set({ postService: config });
    status("连接验证成功，热点服务配置已保存。");
  } catch (error) { status(error.message, true); }
  finally { $("posts-save").disabled = false; $("posts-disconnect").disabled = false; }
});

$("posts-disconnect").addEventListener("click", async () => {
  try {
    await chrome.storage.local.set({ postService: { ...LOCAL_POST_SERVICE } });
    $("posts-base-url").value = LOCAL_POST_SERVICE.baseUrl;
    $("posts-token").value = "";
    status("已切回本地服务，双击「启动本地服务.cmd」即可连接，无需 Token。");
  } catch { status("清除配置失败，请重试。", true); }
});

chrome.storage.local.get("postService").then(({ postService }) => {
  $("posts-base-url").value = postService?.baseUrl || LOCAL_POST_SERVICE.baseUrl;
  $("posts-token").value = postService?.token || "";
}).catch(() => status("读取热点服务配置失败。", true));
