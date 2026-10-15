import { activeConfig, apiEndpoint, readSettings, requestCompletion, validateProfiles, validateSettings } from "./core.js";

const $ = id => document.getElementById(id);
let state = readSettings();
let testController;

function status(message, error = false) {
  $("config-status").textContent = message;
  $("config-status").classList.toggle("error", error);
}

function currentProvider() {
  return state.providers.find(provider => provider.id === state.providerId);
}

function providerOptions() {
  $("provider").replaceChildren(...state.providers.map(provider => new Option(provider.name, provider.id)));
  $("provider").value = state.providerId;
  $("delete-provider").disabled = state.providers.length === 1;
}

function modelOptions() {
  const provider = currentProvider();
  $("model").replaceChildren(...[...new Set(provider.models.filter(Boolean))].map(model => new Option(model, model)));
  $("model").value = provider.model;
}

function renderModels() {
  const provider = currentProvider();
  $("models").replaceChildren();
  provider.models.forEach((model, index) => {
    const row = document.createElement("div");
    row.className = "model-row";
    const input = document.createElement("input");
    input.value = model;
    input.required = true;
    input.maxLength = 200;
    input.spellcheck = false;
    input.placeholder = "例如：sensenova-6.8-flash-lite";
    input.setAttribute("aria-label", `模型 ID ${index + 1}`);
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "text-button";
    remove.textContent = "删除";
    remove.setAttribute("aria-label", `删除模型 ${index + 1}`);
    remove.addEventListener("click", () => {
      testController?.abort();
      stashForm();
      provider.models.splice(index, 1);
      if (!provider.models.includes(provider.model)) provider.model = provider.models.find(Boolean) || "";
      renderModels();
      status("已移除该模型，保存后生效。");
    });
    row.append(input, remove);
    $("models").append(row);
  });
  modelOptions();
}

function renderProvider() {
  const provider = currentProvider();
  providerOptions();
  $("provider-name").value = provider.name;
  $("baseUrl").value = provider.baseUrl;
  $("apiKey").value = provider.apiKey;
  $("apiKey").type = "password";
  $("reveal").textContent = "显示";
  $("reveal").setAttribute("aria-pressed", "false");
  $("reveal").setAttribute("aria-label", "显示 API Key");
  renderModels();
}

function stashForm() {
  const provider = currentProvider();
  provider.name = $("provider-name").value;
  provider.baseUrl = $("baseUrl").value;
  provider.apiKey = $("apiKey").value;
  const selectedIndex = provider.models.indexOf(provider.model);
  provider.models = [...$("models").querySelectorAll("input")].map(input => input.value.trim());
  provider.model = provider.models.includes($("model").value) && $("model").value ? $("model").value : provider.models[selectedIndex] || provider.models.find(Boolean) || "";
  state.language = $("language").value;
  state.preferences = $("preferences").value;
}

async function load() {
  const { settings } = await chrome.storage.local.get("settings");
  state = readSettings(settings);
  $("language").value = state.language;
  $("preferences").value = state.preferences;
  renderProvider();
}

$("provider").addEventListener("change", () => {
  stashForm();
  state.providerId = $("provider").value;
  renderProvider();
  status("已切换编辑的厂家，保存后用于评论；其他厂家的未保存编辑仍保留在本页。");
});

$("add-provider").addEventListener("click", () => {
  testController?.abort();
  stashForm();
  const provider = { id: crypto.randomUUID(), name: `厂家 ${state.providers.length + 1}`, baseUrl: "", apiKey: "", models: [], model: "" };
  state.providers.push(provider);
  state.providerId = provider.id;
  renderProvider();
  $("provider-name").focus();
  status("请填写新厂家的地址、Key 和模型列表，完成后保存全部配置。");
});

$("add-model").addEventListener("click", () => {
  testController?.abort();
  stashForm();
  currentProvider().models.push("");
  renderModels();
  $("models").lastElementChild.querySelector("input").focus();
  status("填写模型 ID 后保存；地址与 Key 使用所属厂家的配置。");
});

$("delete-provider").addEventListener("click", () => {
  if (state.providers.length === 1) return;
  testController?.abort();
  state.providers = state.providers.filter(provider => provider.id !== state.providerId);
  state.providerId = state.providers[0].id;
  renderProvider();
  status("已从编辑列表移除该厂家，保存后生效；关闭页面可放弃未保存的删除。");
});

$("config-form").addEventListener("submit", async event => {
  event.preventDefault();
  $("save").disabled = true;
  $("test-api").disabled = true;
  status("");
  try {
    stashForm();
    const settings = validateProfiles(state);
    const origins = [...new Set(settings.providers.map(provider => `${apiEndpoint(provider.baseUrl).origin}/*`))];
    const allowed = await chrome.permissions.request({ origins });
    if (!allowed) throw new Error("未获得 API 域名授权，配置尚未保存。");
    await chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
    await chrome.storage.local.set({ settings });
    state = settings;
    renderProvider();
    status("全部配置已保存，当前厂家与模型已应用。回到 X 点击重新生成；首次安装请先刷新 X 页面。");
  } catch (error) { status(error.message, true); }
  finally { $("save").disabled = false; $("test-api").disabled = false; }
});

$("test-api").addEventListener("click", async () => {
  const controller = new AbortController();
  testController = controller;
  $("test-api").disabled = true;
  $("save").disabled = true;
  $("test-api").textContent = "正在测试…";
  status("");
  let timeout;
  let timedOut = false;
  try {
    stashForm();
    const settings = validateSettings(activeConfig(state));
    const endpoint = apiEndpoint(settings.baseUrl);
    const allowed = await chrome.permissions.request({ origins: [`${endpoint.origin}/*`] });
    if (controller.signal.aborted) return;
    if (!allowed) throw new Error("未获得 API 域名授权，无法测试接口。");
    status(`正在测试 ${currentProvider().name} / ${settings.model}：1+1=？`);
    const started = performance.now();
    timeout = setTimeout(() => { timedOut = true; controller.abort(); }, 60000);
    const answer = await requestCompletion(settings, [{ role: "user", content: "1+1=？" }], controller.signal);
    if (!controller.signal.aborted) {
      status(`接口调用成功（${((performance.now() - started) / 1000).toFixed(1)} 秒）。\n模型：${settings.model}\n发送：1+1=？\n模型回答：${answer}`);
    }
  } catch (error) {
    if (timedOut) status("接口测试超过 60 秒，请检查网络或选择更快的模型。", true);
    else if (!controller.signal.aborted) status(`接口测试失败：${error.message}`, true);
  } finally {
    clearTimeout(timeout);
    testController = null;
    $("test-api").disabled = false;
    $("save").disabled = false;
    $("test-api").textContent = "测试当前模型：1+1=？";
  }
});

$("config-form").addEventListener("input", event => {
  testController?.abort();
  stashForm();
  if (event.target.closest("#models")) modelOptions();
  if (event.target.id === "provider-name") providerOptions();
  status("");
});
window.addEventListener("pagehide", () => testController?.abort());

$("reveal").addEventListener("click", () => {
  const visible = $("apiKey").type === "password";
  $("apiKey").type = visible ? "text" : "password";
  $("reveal").textContent = visible ? "隐藏" : "显示";
  $("reveal").setAttribute("aria-pressed", String(visible));
  $("reveal").setAttribute("aria-label", visible ? "隐藏 API Key" : "显示 API Key");
});

$("clear-key").addEventListener("click", async () => {
  testController?.abort();
  const selectedId = state.providerId;
  try {
    const { settings } = await chrome.storage.local.get("settings");
    const saved = readSettings(settings);
    const provider = saved.providers.find(item => item.id === selectedId);
    if (provider) {
      provider.apiKey = "";
      await chrome.storage.local.set({ settings: saved });
    }
    const draft = state.providers.find(item => item.id === selectedId);
    if (draft) draft.apiKey = "";
    if (state.providerId === selectedId) $("apiKey").value = "";
    status("当前厂家 Key 已清除，其他厂家的配置不受影响。重新填写并保存后可继续使用。");
  } catch { status("清除失败，请重试。", true); }
});

load().catch(() => status("读取配置失败，请关闭页面后重新打开。", true));
