import { analyticsProfile } from "./analytics-profile.js";

const $ = id => document.getElementById(id);
function status(message, error = false) {
  $("analytics-profile-status").textContent = message;
  $("analytics-profile-status").classList.toggle("error", error);
}

$("analytics-profile-form").addEventListener("submit", async event => {
  event.preventDefault();
  $("analytics-profile-save").disabled = true;
  try {
    const profile = analyticsProfile($("analytics-profile-url").value);
    await chrome.storage.local.set({ analyticsProfileUrl: profile.url });
    $("analytics-profile-url").value = profile.url;
    status("主页已保存，返回该主页或滚动时自动采集。可在「我的数据 → 数据分析」查看汇总。");
  } catch (error) { status(error.message, true); }
  finally { $("analytics-profile-save").disabled = false; }
});

chrome.storage.local.get("analyticsProfileUrl").then(({ analyticsProfileUrl }) => {
  $("analytics-profile-url").value = analyticsProfile(analyticsProfileUrl).url;
}).catch(error => status(`读取主页配置失败：${error.message}`, true));
