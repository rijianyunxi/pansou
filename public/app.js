/* 网盘工具箱前端逻辑（原生 JS，无框架） */

const state = { provider: "" };

const $ = (id) => document.getElementById(id);
const resultEl = $("result");

/* ---------- 工具 ---------- */
function escapeHtml(text) {
  return String(text ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
}

function formatSize(bytes) {
  const size = Number(bytes);
  if (!Number.isFinite(size) || size < 0) return "-";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = size;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) { value /= 1024; index += 1; }
  return `${index === 0 ? value : value.toFixed(2)} ${units[index]}`;
}

let toastTimer;
function toast(message, isError = false) {
  const el = $("toast");
  el.textContent = message;
  el.className = `toast show${isError ? " err" : ""}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.className = "toast"; }, 2600);
}

async function api(path, body) {
  const startedAt = performance.now();
  const response = await fetch(path, {
    method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({ ok: false, error: `响应解析失败（HTTP ${response.status}）` }));
  // 记下真实往返耗时：上游各步耗时之和在并行步骤上会重复计算，不是用户体感的那个数
  const elapsedMs = Math.round(performance.now() - startedAt);
  if (!payload.ok) {
    // 失败时也把上游耗时带上，方便看出卡在哪一步
    const error = new Error(payload.error || "请求失败");
    error.timings = payload.timings || [];
    error.elapsedMs = elapsedMs;
    throw error;
  }
  return { ...payload.data, elapsedMs };
}

function loading(text = "处理中…") {
  resultEl.className = "result loading";
  resultEl.textContent = text;
}

function providerName(p) { return p === "quark" ? "夸克" : p === "baidu" ? "百度" : p; }

function renderFiles(files, { showHit = false } = {}) {
  if (!files?.length) return "";
  const items = files.map((file) => {
    const ico = file.isDir ? "📁" : "📄";
    const size = file.isDir ? "" : `<span class="sz">${formatSize(file.size)}</span>`;
    const hit = showHit && file.hit ? `<span class="hit">已有</span>` : "";
    return `<div class="list-item"><span class="ico">${ico}</span><span class="nm">${escapeHtml(file.name)}</span>${hit}${size}</div>`;
  });
  return `<div class="list">${items.join("")}</div>`;
}

/** 渲染"我自己的分享链接"结果块。 */
function renderShare(share) {
  if (!share?.url) return "";
  return (
    `<div class="share-box">分享链接：<code>${escapeHtml(share.url)}</code>` +
    (share.password ? `<br />提取码：<code>${escapeHtml(share.password)}</code>` : "") +
    `</div>`
  );
}

/** 渲染上游耗时分布，便于定位瓶颈。 */
function renderTimings(timings, elapsedMs = null) {
  if (!Array.isArray(timings) || !timings.length) return "";
  const byStep = new Map();
  let sum = 0;
  for (const item of timings) {
    byStep.set(item.step, (byStep.get(item.step) || 0) + item.ms);
    sum += item.ms;
  }
  const parts = [...byStep.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([step, ms]) => `${escapeHtml(step)} ${ms}ms`)
    .join(" · ");
  const wall = elapsedMs === null ? "" : `接口往返 <b>${elapsedMs} ms</b>（含本地开销）｜`;
  return `<p class="timings">${wall}上游请求 ${timings.length} 次，各步累计 ${sum} ms：${parts}</p>`;
}

/* ---------- Cookie 配置 ---------- */
const COOKIE_HINT = {
  quark: "从 pan.quark.cn 复制完整 Cookie",
  baidu: "从 pan.baidu.com/disk/main 复制完整 Cookie（需含 BDUSS / BAIDUID / STOKEN）",
};

/**
 * 徽标与提示语必须反映真实来源，避免出现"未配置却说已从 .env 读取"这种自相矛盾。
 * source：env = 来自 .env；memory = 界面本次填写；none = 未配置。
 */
function applyCookieState(provider, info) {
  const el = $(`${provider}Cookie`);
  const badge = $(`${provider}State`);
  badge.className = `badge${info.configured ? " on" : ""}`;
  if (!info.configured) {
    badge.textContent = "未配置";
    el.placeholder = COOKIE_HINT[provider];
    return;
  }
  badge.textContent = `已配置 ${info.length} 字符 · ${info.source === "env" ? "来自 .env" : "本次输入"}`;
  el.placeholder =
    info.source === "env"
      ? `已从 .env 读取（${info.length} 字符），留空表示不修改`
      : `已在界面设置（${info.length} 字符），重新填写可覆盖`;
}

async function refreshConfig() {
  try {
    const data = await api("/api/config");
    applyCookieState("quark", data.quark);
    applyCookieState("baidu", data.baidu);
  } catch (error) {
    toast(error.message, true);
  }
}

$("toggleCookie").addEventListener("click", () => $("cookiePanel").classList.toggle("open"));

// 深链：#cookie 直接展开登录态面板
if (location.hash === "#cookie") $("cookiePanel").classList.add("open");

$("saveCookie").addEventListener("click", async () => {
  const quark = $("quarkCookie").value.trim();
  const baidu = $("baiduCookie").value.trim();
  if (!quark && !baidu) return toast("两个输入框都是空的，没有可保存的内容", true);
  try {
    await api("/api/config", { quark, baidu });
    $("quarkCookie").value = "";
    $("baiduCookie").value = "";
    await refreshConfig();
    toast("登录态已更新");
  } catch (error) {
    toast(error.message, true);
  }
});

document.querySelectorAll("[data-clear]").forEach((button) => {
  button.addEventListener("click", async () => {
    const provider = button.dataset.clear;
    try {
      await api("/api/config/clear", { provider });
      $(`${provider}Cookie`).value = "";
      await refreshConfig();
      toast(`${providerName(provider)} 登录态已清除`);
    } catch (error) {
      toast(error.message, true);
    }
  });
});

/* ---------- 网盘选择 ---------- */
$("providerSwitch").addEventListener("click", (event) => {
  const button = event.target.closest("button");
  if (!button) return;
  state.provider = button.dataset.provider;
  [...$("providerSwitch").children].forEach((child) => child.classList.toggle("active", child === button));
});

/* ---------- 标签页 ---------- */
$("tabs").addEventListener("click", (event) => {
  const button = event.target.closest("button");
  if (!button) return;
  [...$("tabs").children].forEach((child) => child.classList.toggle("active", child === button));
  document.querySelectorAll(".panel").forEach((panel) => panel.classList.toggle("active", panel.dataset.panel === button.dataset.tab));
  resultEl.className = "result empty";
  resultEl.textContent = "结果会显示在这里";
});

/* ---------- 各操作 ---------- */
const actions = {
  async check() {
    const url = $("checkUrl").value.trim();
    if (!url) return toast("请填写分享链接", true);
    loading("正在校验链接…");
    const data = await api("/api/check", { url, password: $("checkPwd").value.trim(), provider: state.provider });
    if (!data.valid) {
      resultEl.className = "result";
      resultEl.innerHTML = `<span class="pill err">✗ 链接无效</span><p style="margin:12px 0 0;color:var(--muted)">${escapeHtml(data.reason)}</p>${renderTimings(data.timings, data.elapsedMs)}`;
      return;
    }
    resultEl.className = "result";
    resultEl.innerHTML =
      `<span class="pill ok">✓ 链接有效</span>` +
      `<div class="kv"><span>网盘 <b>${providerName(data.provider)}</b></span><span>文件数 <b>${data.fileCount}</b></span>${data.title ? `<span>标题 <b>${escapeHtml(data.title)}</b></span>` : ""}</div>` +
      renderFiles(data.files) +
      renderTimings(data.timings, data.elapsedMs);
  },

  async save() {
    const url = $("saveUrl").value.trim();
    if (!url) return toast("请填写分享链接", true);
    const dedup = $("saveDedup").checked;
    const autoShare = $("saveShare").checked;
    loading(dedup ? "正在检查是否已有该资源…" : "正在转存…");
    const data = await api("/api/save", {
      url,
      password: $("savePwd").value.trim(),
      toDir: $("saveTo").value.trim(),
      provider: state.provider,
      dedup,
      autoShare,
    });
    resultEl.className = "result";

    if (data.mode === "reused") {
      const files = data.matched.map((pair) => ({ ...pair.mine, hit: true }));
      const missing = data.missing || [];
      // 部分命中时不能说"已有该资源"——只有全部命中才是
      const allHit = missing.length === 0;
      const headline = allHit
        ? `<span class="pill ok">✓ 你的网盘已有该资源</span>`
        : `<span class="pill warn">部分命中：${data.matched.length} / ${data.matched.length + missing.length} 项已存在</span>`;
      const note = allHit
        ? "已跳过重复转存，直接为已有资源生成分享链接："
        : `已为这 ${data.matched.length} 项生成分享链接；另有 ${missing.length} 项不在你的网盘中，取消勾选「去重」可转存它们。`;
      resultEl.innerHTML =
        headline +
        `<p style="margin:12px 0 0;color:var(--muted)">${note}</p>` +
        renderFiles(files, { showHit: true }) +
        renderShare(data.share) +
        renderTimings(data.timings, data.elapsedMs);
      return;
    }

    resultEl.innerHTML =
      `<span class="pill ok">✓ 转存成功</span>` +
      `<div class="kv"><span>网盘 <b>${providerName(data.provider)}</b></span><span>文件数 <b>${data.count ?? "-"}</b></span><span>目标 <b>${escapeHtml(data.target || "/")}</b></span></div>` +
      (dedup ? `<p style="margin:8px 0 0;color:var(--muted)">去重检查：网盘中未发现同名资源</p>` : "") +
      renderShare(data.share) +
      (autoShare && !data.share ? `<p style="margin:8px 0 0;color:var(--warn)">转存成功，但未能在目标目录定位到刚保存的条目，因此没生成分享链接。</p>` : "") +
      renderTimings(data.timings, data.elapsedMs);
  },

  async del() {
    const url = $("delUrl").value.trim();
    const password = $("delPwd").value.trim();
    if (!url) return toast("请填写你的分享链接", true);

    // 先读出分享内容，把"要删什么"摆给用户确认，避免误删
    loading("正在读取分享内容…");
    const info = await api("/api/check", { url, password, provider: state.provider });
    if (!info.valid) {
      resultEl.className = "result";
      resultEl.innerHTML = `<span class="pill err">✗ 链接无效</span><p style="margin:12px 0 0;color:var(--muted)">${escapeHtml(info.reason)}</p>`;
      return;
    }
    const names = info.files.map((file) => file.name).filter(Boolean);
    const preview = names.slice(0, 10).map((name) => `· ${name}`).join("\n");
    const more = names.length > 10 ? `\n… 共 ${names.length} 项` : "";
    if (!window.confirm(`确认从你的网盘删除以下 ${info.fileCount} 项？\n\n${preview}${more}\n\n此操作不可撤销。`)) return;

    loading("正在删除…");
    const data = await api("/api/delete", { url, password, provider: state.provider });
    resultEl.className = "result";
    resultEl.innerHTML =
      `<span class="pill ok">✓ 已删除</span>` +
      `<div class="kv"><span>网盘 <b>${providerName(data.provider)}</b></span><span>删除数量 <b>${data.deleted}</b></span></div>` +
      renderFiles((data.names || []).map((name) => ({ name }))) +
      renderTimings(data.timings, data.elapsedMs);
  },

  async mine() {
    loading("正在读取目录…");
    const data = await api("/api/mine", { provider: state.provider || "quark", dir: $("mineDir").value.trim() });
    resultEl.className = "result";
    resultEl.innerHTML =
      `<span class="pill info">${providerName(data.provider)} · ${escapeHtml(data.dir)}</span>` +
      `<div class="kv"><span>共 <b>${data.files.length}</b> 项</span></div>` +
      renderFiles(data.files);
  },
};

document.querySelectorAll("[data-action]").forEach((button) => {
  button.addEventListener("click", async () => {
    const handler = actions[button.dataset.action];
    if (!handler) return;
    button.disabled = true;
    try {
      await handler();
    } catch (error) {
      resultEl.className = "result";
      resultEl.innerHTML =
        `<span class="pill err">✗ 失败</span>` +
        `<p style="margin:12px 0 0;color:var(--muted)">${escapeHtml(error.message)}</p>` +
        renderTimings(error.timings, error.elapsedMs);
      toast(error.message, true);
    } finally {
      button.disabled = false;
    }
  });
});

/* ---------- 登录态检测 ---------- */
$("pingBtn").addEventListener("click", async () => {
  const provider = state.provider || "quark";
  loading("正在检测…");
  try {
    const data = await api("/api/ping", { provider });
    resultEl.className = "result";
    resultEl.innerHTML = `<span class="pill ok">✓ ${providerName(provider)} 登录态可用</span><div class="kv"><span>根目录 <b>${data.count}</b> 项</span></div>`;
  } catch (error) {
    resultEl.className = "result";
    resultEl.innerHTML = `<span class="pill err">✗ ${providerName(provider)} 登录态不可用</span><p style="margin:12px 0 0;color:var(--muted)">${escapeHtml(error.message)}</p>`;
  }
});

refreshConfig();
