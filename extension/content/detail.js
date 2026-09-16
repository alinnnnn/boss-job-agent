(() => {
  if (window.__bossApplyDetailInjected) return;
  window.__bossApplyDetailInjected = true;

  const READY_TEXTS = new Set(["立即沟通"]);
  const SKIP_TEXTS = new Set(["继续沟通", "已沟通"]);
  const RISK_PATTERN =
    /验证码|安全验证|滑块|操作频繁|操作过于频繁|登录失效|请先登录|重新登录|账号异常|账户存在异常|访问受限|暂时被限制|暂时无法访问|今日沟通人数已达|沟通人数.*上限|已达.*上限/;
  const STAY_TEXTS = ["留在此页", "留在主页", "留在当前页", "留在页面"];
  const CONFIRM_TEXTS = ["发送", "确定"];

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "PING") {
      sendResponse({ ok: true, page: "detail" });
      return;
    }
    if (message?.type === "PROCESS_JOB") {
      processJob(message)
        .then(sendResponse)
        .catch((error) => sendResponse({ status: "error", text: String(error?.message || error) }));
      return true;
    }
  });

  ensureDetailStop();
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local") renderDetailStop();
  });
  renderDetailStop();

  async function processJob(options = {}) {
    if (!(await stillRunning())) return { status: "stopped", text: "已停止" };
    if (isLoginPage()) return { status: "login", text: "需要登录" };

    const earlyRisk = detectRiskText();
    if (earlyRisk) return { status: "limit", text: earlyRisk };

    if (options.onlyRecentActive !== false) {
      const activity = await waitFor(() => {
        if (typeof bossApplyReadActivity === "function") return bossApplyReadActivity(document);
        return "";
      }, 4000, 200);
      const judged = typeof bossApplyJudgeActivity === "function"
        ? bossApplyJudgeActivity(activity)
        : { pass: null, label: activity || "" };
      if (judged.pass !== true) {
        return { status: "inactive", text: judged.label || "未识别到3日内活跃" };
      }
    }

    const button = await waitFor(() => findChatButton(), 12000, 250);
    if (!button) return { status: "not_found", text: "未找到沟通按钮" };

    const text = normalize(button.innerText || button.textContent);
    if (SKIP_TEXTS.has(text) || /继续沟通|已沟通/.test(text)) {
      return { status: "already", text };
    }
    if (!READY_TEXTS.has(text) && text !== "立即沟通") {
      if (/去App|打开App|下载/.test(text)) {
        return { status: "unknown", text };
      }
      return { status: "unknown", text };
    }

    realClick(button);
    await sleep(1000);
    if (!(await stillRunning())) return { status: "stopped", text: "已停止" };

    const risk = detectRiskText();
    if (risk) return { status: "limit", text: risk };

    clickInDialog(CONFIRM_TEXTS);
    await sleep(400);
    clickInDialog(STAY_TEXTS);
    await sleep(500);

    const laterRisk = detectRiskText();
    if (laterRisk) return { status: "limit", text: laterRisk };

    return { status: "applied", text: "立即沟通" };
  }

  function findChatButton() {
    const selectors = [
      ".btn-startchat",
      "a.btn-startchat",
      "button.btn-startchat",
      ".op-btn-chat",
      ".job-detail-op .op-btn-chat",
      ".job-op .btn-startchat",
      ".start-chat-btn",
      ".btn.btn-startchat",
    ];
    for (const selector of selectors) {
      const el = document.querySelector(selector);
      const text = normalize(el?.innerText || el?.textContent);
      if (el && text) return closestClickable(el);
    }

    const nodes = Array.from(document.querySelectorAll("a, button, span, div"));
    const hit = nodes.find((el) => {
      const text = normalize(el.innerText || el.textContent);
      return text === "立即沟通" || text === "继续沟通" || text === "已沟通";
    });
    return hit ? closestClickable(hit) : null;
  }

  function closestClickable(el) {
    return el.closest("a, button") || el;
  }

  function detectRiskText() {
    const sources = [
      document.body?.innerText || "",
      ...Array.from(document.querySelectorAll(".dialog-wrap, .dialog-con, [role='dialog'], .toast, .boss-popup"))
        .map((el) => el.innerText || ""),
    ];
    for (const source of sources) {
      const text = normalize(source);
      const match = text.match(RISK_PATTERN);
      if (match) return match[0];
    }
    return "";
  }

  function clickInDialog(texts) {
    const dialogs = document.querySelectorAll(
      ".dialog-wrap, .dialog-container, .dialog-con, .boss-popup, .boss-dialog, [role='dialog']"
    );
    if (!dialogs.length) return "";
    const roots = Array.from(dialogs);
    for (const root of roots) {
      const nodes = Array.from(root.querySelectorAll("a, button, span, div.btn, .boss-btn, .btn"));
      for (const el of nodes) {
        const text = normalize(el.innerText || el.textContent);
        if (texts.includes(text)) {
          realClick(closestClickable(el));
          return text;
        }
      }
    }
    return "";
  }

  function realClick(el) {
    if (!el) return;
    el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
    const rect = el.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    const opts = { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y };
    el.dispatchEvent(new MouseEvent("pointerover", opts));
    el.dispatchEvent(new MouseEvent("mouseover", opts));
    el.dispatchEvent(new MouseEvent("pointerdown", opts));
    el.dispatchEvent(new MouseEvent("mousedown", opts));
    el.dispatchEvent(new MouseEvent("pointerup", opts));
    el.dispatchEvent(new MouseEvent("mouseup", opts));
    el.dispatchEvent(new MouseEvent("click", opts));
    if (typeof el.click === "function") el.click();
  }

  function isLoginPage() {
    const href = location.href;
    const text = document.body?.innerText || "";
    return /\/web\/user\/login|scan\/login/.test(href) || (/请先登录|扫码登录/.test(text) && !findChatButton());
  }

  function normalize(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function stillRunning() {
    try {
      const state = await chrome.storage.local.get(["running"]);
      return Boolean(state.running);
    } catch (_error) {
      return false;
    }
  }

  async function waitFor(getter, timeoutMs, intervalMs) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const value = getter();
      if (value) return value;
      await sleep(intervalMs);
    }
    return getter();
  }

  function ensureDetailStop() {
    if (document.getElementById("boss-apply-detail-stop")) return;
    const style = document.createElement("style");
    style.id = "boss-apply-detail-stop-style";
    style.textContent = `
      #boss-apply-detail-stop {
        position: fixed; right: 16px; bottom: 16px; z-index: 2147483646;
        width: 220px; display: none;
        background: #111827; color: #f9fafb; border-radius: 14px;
        box-shadow: 0 12px 40px rgba(0,0,0,.28);
        font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Noto Sans SC", sans-serif;
        overflow: hidden;
      }
      #boss-apply-detail-stop .hd {
        display: flex; align-items: center; justify-content: space-between;
        padding: 10px 12px 6px; font-size: 12px; font-weight: 650;
      }
      #boss-apply-detail-stop .hint {
        padding: 0 12px 8px; font-size: 11px; color: #9ca3af; line-height: 1.4;
      }
      #boss-apply-detail-stop button {
        display: block; width: calc(100% - 24px); margin: 0 12px 12px; height: 32px;
        border: 0; border-radius: 8px; background: #ef4444; color: #fff; font-weight: 650; cursor: pointer;
      }
    `;
    document.documentElement.appendChild(style);

    const box = document.createElement("div");
    box.id = "boss-apply-detail-stop";
    box.innerHTML = `
      <div class="hd"><span>BOSS 投递助手</span><span id="boss-apply-detail-state">运行中</span></div>
      <div class="hint" id="boss-apply-detail-hint">网页投递 / 按导出投递都可以在这里停</div>
      <button id="boss-apply-detail-stop-btn" type="button">停止当前任务</button>
    `;
    document.documentElement.appendChild(box);
    box.addEventListener("click", async (event) => {
      if (!event.target.closest("#boss-apply-detail-stop-btn")) return;
      event.preventDefault();
      event.stopPropagation();
      const hint = document.getElementById("boss-apply-detail-hint");
      if (hint) hint.textContent = "正在停止…";
      try {
        await chrome.runtime.sendMessage({ type: "STOP", reason: "已手动停止" });
      } catch (_error) {
        if (hint) hint.textContent = "插件已更新，请刷新后再试";
      }
    }, true);
  }

  async function renderDetailStop() {
    ensureDetailStop();
    const box = document.getElementById("boss-apply-detail-stop");
    if (!box) return;
    try {
      const state = await chrome.storage.local.get(["running", "currentTitle", "applied", "target", "applySource"]);
      const running = Boolean(state.running);
      box.style.display = running ? "block" : "none";
      const stateEl = document.getElementById("boss-apply-detail-state");
      if (stateEl) stateEl.textContent = running ? "运行中" : "未运行";
      const hint = document.getElementById("boss-apply-detail-hint");
      if (hint && running) {
        const source = state.applySource === "excel" ? "按导出投递" : "网页投递";
        hint.textContent = state.currentTitle
          ? `${source} ${state.applied || 0}/${state.target || 10}：${state.currentTitle}`
          : `${source}进行中，点停止即可结束`;
      }
    } catch (_error) {
      // ignore
    }
  }
})();
