(() => {
  if (/\/job_detail\/|\/web\/geek\/chat|\/web\/user\//.test(location.pathname + location.href)) {
    return;
  }

  const BIND_VERSION = 11;
  let overlay = null;

  window.__bossApplyCollectJobs = collectJobs;
  window.__bossApplyGoNextPage = goNextPage;

  if (window.__bossApplyBindVersion !== BIND_VERSION) {
    window.__bossApplyBindVersion = BIND_VERSION;
    document.addEventListener("click", onOverlayClick, true);
    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (message?.type === "PING") {
        sendResponse({ ok: true, page: "list", version: BIND_VERSION });
        return;
      }
      if (message?.type === "COLLECT_JOBS") {
        sendResponse({ ok: true, jobs: collectJobs() });
        return;
      }
      if (message?.type === "GO_NEXT_PAGE") {
        goNextPage()
          .then(sendResponse)
          .catch((error) => sendResponse({ ok: false, reason: String(error?.message || error) }));
        return true;
      }
      if (message?.type === "SCAN_CURRENT_PAGE") {
        const scan = window.__bossApplyScanCurrentPage;
        if (!scan) {
          sendResponse({ ok: false, error: "扫描脚本未加载，请刷新页面" });
          return;
        }
        scan()
          .then(sendResponse)
          .catch((error) => sendResponse({ ok: false, error: String(error?.message || error) }));
        return true;
      }
      if (message?.type === "INSPECT_JOB") {
        inspectJob(message.url)
          .then(sendResponse)
          .catch((error) => sendResponse({ ok: false, activity: "", error: String(error?.message || error) }));
        return true;
      }
      if (message?.type === "DOWNLOAD_EXCEL") {
        downloadExcel(message.rows || []);
        sendResponse({ ok: true });
      }
    });
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "local") return;
      renderOverlay();
    });
    document.addEventListener("change", (event) => {
      if (!chrome.runtime?.id) return;
      if (event.target?.id === "boss-apply-recent") {
        chrome.storage.local.set({ onlyRecentActive: event.target.checked });
      }
      if (event.target?.id === "boss-apply-export-count") {
        const n = Math.max(1, Math.min(200, parseInt(event.target.value, 10) || 80));
        chrome.storage.local.set({ exportTarget: n });
      }
      if (event.target?.id === "boss-apply-target") {
        const n = Math.max(1, Math.min(100, parseInt(event.target.value, 10) || 10));
        chrome.storage.local.set({ target: n });
      }
    }, true);
  }

  ensureOverlay();
  renderOverlay();
  watchForJobList();

  async function onOverlayClick(event) {
    const startBtn = event.target.closest("#boss-apply-start");
    const stopBtn = event.target.closest("#boss-apply-stop");
    const exportBtn = event.target.closest("#boss-apply-export");
    const excelBtn = event.target.closest("#boss-apply-from-export");
    if (!startBtn && !stopBtn && !exportBtn && !excelBtn) return;
    event.preventDefault();
    event.stopPropagation();

    if (!chrome.runtime?.id) {
      setHint("插件已更新，请刷新这个页面后再试");
      return;
    }

    if (stopBtn) {
      setHint("正在停止…");
      try {
        await chrome.runtime.sendMessage({ type: "STOP", reason: "已手动停止" });
      } catch (_error) {
        setHint("插件已更新，请刷新这个页面后再试");
      }
      return;
    }

    if (exportBtn) {
      const count = Number(document.querySelector("#boss-apply-export-count")?.value || 80);
      setHint(`已清空旧 Excel，开始扫描，满 ${count} 条即停…`);
      try {
        const response = await chrome.runtime.sendMessage({ type: "EXPORT", count });
        if (!response?.ok) setHint(response?.error || "导出失败");
      } catch (error) {
        setHint(error?.message?.includes("Extension context")
          ? "插件已更新，请刷新这个页面后再试"
          : `导出失败：${error?.message || error}`);
      }
      return;
    }

    if (excelBtn) {
      const target = Number(document.querySelector("#boss-apply-target")?.value || 10);
      const onlyRecentActive = Boolean(document.querySelector("#boss-apply-recent")?.checked);
      setHint(`按导出文件投递，满 ${target} 份即停，已投过的会跳过…`);
      try {
        const response = await chrome.runtime.sendMessage({
          type: "START_FROM_EXPORT",
          target,
          onlyRecentActive,
        });
        if (!response?.ok) setHint(response?.error || "启动失败");
      } catch (error) {
        setHint(error?.message?.includes("Extension context")
          ? "插件已更新，请刷新这个页面后再试"
          : `启动失败：${error?.message || error}`);
      }
      return;
    }

    const target = Number(document.querySelector("#boss-apply-target")?.value || 10);
    const onlyRecentActive = Boolean(document.querySelector("#boss-apply-recent")?.checked);
    setHint("已收到网页投递指令，正在读取当前列表…");
    try {
      const response = await chrome.runtime.sendMessage({ type: "START", target, onlyRecentActive });
      if (!response?.ok) setHint(response?.error || "启动失败");
    } catch (error) {
      setHint(error?.message?.includes("Extension context")
        ? "插件已更新，请刷新这个页面后再试"
        : `启动失败：${error?.message || error}`);
    }
  }

  function collectJobs() {
    const seen = new Set();
    const jobs = [];

    const add = (url, title, company, activity) => {
      if (!url || url.startsWith("javascript:")) return;
      let absolute = "";
      try {
        absolute = new URL(url, location.origin).href;
      } catch (_error) {
        return;
      }
      const id = jobIdFromUrl(absolute);
      if (!id || seen.has(id)) return;
      seen.add(id);
      jobs.push({
        url: absolute,
        title: normalize(title),
        company: normalize(company),
        activity: normalize(activity),
      });
    };

    const cards = document.querySelectorAll(
      ".job-card-wrap, .job-card-wrapper, .job-card-box, li.job-card-wrapper, .job-list-item, .job-card-left, .rec-job-list li"
    );
    cards.forEach((card) => {
      const link =
        card.querySelector('a[href*="job_detail"]') ||
        card.querySelector("a.job-name") ||
        card.querySelector("a.job-card-left") ||
        (card.matches("a") ? card : null);
      const href = link?.getAttribute("href") || link?.href || card.getAttribute("data-url") || "";
      add(
        href,
        (card.querySelector(".job-name, .job-title") || link || card).textContent,
        (card.querySelector(".boss-name, .company-name") || {}).textContent || "",
        typeof bossApplyReadActivity === "function" ? bossApplyReadActivity(card) : ""
      );
    });

    if (!jobs.length) {
      document.querySelectorAll('a[href*="job_detail"]').forEach((link) => {
        const card = link.closest("li, .job-card-wrap, .job-card-wrapper, .job-card-box") || link.parentElement;
        add(
          link.getAttribute("href") || link.href,
          link.textContent,
          (card?.querySelector(".boss-name, .company-name") || {}).textContent || "",
          typeof bossApplyReadActivity === "function" ? bossApplyReadActivity(card || link) : ""
        );
      });
    }

    return jobs;
  }

  function ensureOverlay() {
    document.getElementById("boss-apply-overlay")?.remove();
    document.getElementById("boss-apply-overlay-style")?.remove();

    const style = document.createElement("style");
    style.id = "boss-apply-overlay-style";
    style.textContent = `
      #boss-apply-overlay {
        position: fixed;
        left: 16px;
        bottom: 16px;
        z-index: 2147483646;
        width: 300px;
        background: #111827;
        color: #f9fafb;
        border-radius: 14px;
        box-shadow: 0 12px 40px rgba(0,0,0,.28);
        font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Noto Sans SC", sans-serif;
        overflow: hidden;
      }
      #boss-apply-overlay * { box-sizing: border-box; }
      #boss-apply-overlay .hd {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 12px 14px 8px;
        font-size: 13px;
        font-weight: 650;
      }
      #boss-apply-overlay .dot {
        width: 8px; height: 8px; border-radius: 50%;
        background: #6b7280; margin-right: 8px; display: inline-block;
      }
      #boss-apply-overlay .dot.on { background: #34d399; box-shadow: 0 0 0 4px rgba(52,211,153,.18); }
      #boss-apply-overlay .body { padding: 0 14px 12px; font-size: 12px; color: #d1d5db; line-height: 1.5; }
      #boss-apply-overlay .stats { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 6px; margin: 8px 0 10px; }
      #boss-apply-overlay .stat {
        background: #1f2937; border-radius: 8px; padding: 6px 0; text-align: center;
      }
      #boss-apply-overlay .stat b { display: block; color: #fff; font-size: 16px; }
      #boss-apply-overlay .check {
        display: flex;
        align-items: center;
        gap: 6px;
        margin: 0 0 10px;
        font-size: 12px;
        color: #e5e7eb;
        cursor: pointer;
      }
      #boss-apply-overlay .check input { width: 14px; height: 14px; accent-color: #00bebd; }
      #boss-apply-overlay .row { display: flex; gap: 8px; }
      #boss-apply-overlay input {
        flex: 1; height: 32px; border: 0; border-radius: 8px; padding: 0 10px;
        background: #1f2937; color: #fff; outline: none;
      }
      #boss-apply-overlay button {
        height: 32px; border: 0; border-radius: 8px; padding: 0 12px;
        font-weight: 650; cursor: pointer;
      }
      #boss-apply-overlay .start { background: #00bebd; color: #042f2e; }
      #boss-apply-overlay .export { background: #2563eb; color: #fff; flex: 1; }
      #boss-apply-overlay .from-excel { background: #d97706; color: #fff; flex: 1; }
      #boss-apply-overlay .stop { background: #ef4444; color: #fff; flex: 1; width: 100%; }
      #boss-apply-overlay .hint { margin-top: 8px; font-size: 11px; color: #9ca3af; }
      #boss-apply-overlay .row + .row { margin-top: 8px; }
    `;
    document.documentElement.appendChild(style);

    overlay = document.createElement("div");
    overlay.id = "boss-apply-overlay";
    overlay.innerHTML = `
      <div class="hd"><span><i class="dot"></i>BOSS 投递助手</span><span id="boss-apply-state">未运行</span></div>
      <div class="body">
        <div class="stats">
          <div class="stat"><b id="boss-apply-applied">0</b><span id="boss-apply-applied-label">已沟通</span></div>
          <div class="stat"><b id="boss-apply-skipped">0</b><span id="boss-apply-skipped-label">已跳过</span></div>
          <div class="stat"><b id="boss-apply-failed">0</b>失败</div>
        </div>
          <label class="check"><input id="boss-apply-recent" type="checkbox" checked />只投 3 日内活跃</label>
          <div class="row">
          <input id="boss-apply-target" type="number" min="1" max="100" value="10" title="要投递的数量" />
          <button class="start" id="boss-apply-start" type="button">网页投递</button>
        </div>
        <div class="row">
          <input id="boss-apply-export-count" type="number" min="1" max="200" value="80" title="导出条数" />
          <button class="export" id="boss-apply-export" type="button">扫描导出</button>
        </div>
        <div class="row">
          <button class="from-excel" id="boss-apply-from-export" type="button">按导出投递</button>
        </div>
        <div class="row">
          <button class="stop" id="boss-apply-stop" type="button">停止当前任务</button>
        </div>
        <div class="hint" id="boss-apply-hint">停止对网页投递、按导出投递、扫描导出都有效。</div>
      </div>
    `;
    document.documentElement.appendChild(overlay);
  }

  function setHint(text) {
    const hint = document.querySelector("#boss-apply-hint");
    if (hint) hint.textContent = text;
  }

  async function renderOverlay() {
    if (!overlay) overlay = document.getElementById("boss-apply-overlay");
    if (!overlay) return;
    try {
      const state = await chrome.storage.local.get(null);
      overlay.querySelector(".dot")?.classList.toggle("on", Boolean(state.running));
      const stateEl = overlay.querySelector("#boss-apply-state");
      if (stateEl) stateEl.textContent = state.running ? "运行中" : "未运行";
      const applied = overlay.querySelector("#boss-apply-applied");
      const skipped = overlay.querySelector("#boss-apply-skipped");
      const failed = overlay.querySelector("#boss-apply-failed");
      const exporting = state.mode === "export";
      const appliedLabel = overlay.querySelector("#boss-apply-applied-label");
      const skippedLabel = overlay.querySelector("#boss-apply-skipped-label");
      if (appliedLabel) appliedLabel.textContent = exporting ? "已符合" : "已沟通";
      if (skippedLabel) skippedLabel.textContent = exporting ? "已排除" : "已跳过";
      if (applied) {
        const current = state.applied || 0;
        const goal = exporting ? (state.exportTarget || 80) : (state.target || 10);
        applied.textContent = state.running ? `${current}/${goal}` : String(current);
      }
      if (skipped) skipped.textContent = state.skipped || 0;
      if (failed) failed.textContent = state.failed || 0;
      const targetInput = overlay.querySelector("#boss-apply-target");
      if (!state.running && targetInput && !exporting) targetInput.value = state.target || 10;
      const exportCount = overlay.querySelector("#boss-apply-export-count");
      if (!state.running && exportCount) exportCount.value = state.exportTarget || 80;
      const recent = overlay.querySelector("#boss-apply-recent");
      if (!state.running && recent) recent.checked = state.onlyRecentActive !== false;
      const startBtn = overlay.querySelector("#boss-apply-start");
      const stopBtn = overlay.querySelector("#boss-apply-stop");
      const exportBtn = overlay.querySelector("#boss-apply-export");
      const excelBtn = overlay.querySelector("#boss-apply-from-export");
      if (startBtn) startBtn.disabled = Boolean(state.running);
      if (exportBtn) exportBtn.disabled = Boolean(state.running);
      if (excelBtn) excelBtn.disabled = Boolean(state.running);
      if (stopBtn) stopBtn.disabled = !state.running;
      const currentHint = overlay.querySelector("#boss-apply-hint")?.textContent || "";
      if (state.currentTitle) setHint(state.currentTitle);
      else if (state.stopReason) setHint(state.stopReason);
      else if (!currentHint.includes("已收到") && !currentHint.includes("失败") && !currentHint.includes("刷新") && !currentHint.includes("扫描") && !currentHint.includes("按导出")) {
        setHint("停止对网页投递、按导出投递、扫描导出都有效。");
      }
    } catch (_error) {
      setHint("插件已更新，请刷新这个页面后再试");
    }
  }

  function watchForJobList() {
    if (window.__bossApplyJobWatcher) return;
    window.__bossApplyJobWatcher = true;
    const observer = new MutationObserver(() => {
      if (!document.getElementById("boss-apply-overlay")) ensureOverlay();
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
  }

  function jobIdFromUrl(url) {
    const match = String(url || "").match(/job_detail\/([^./?#]+)/);
    return match ? match[1] : "";
  }

  function normalize(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
  }

  async function goNextPage() {
    const beforeIds = collectJobs().map((job) => jobIdFromUrl(job.url)).filter(Boolean);
    const nextButton = findNextPageButton();

    if (nextButton) {
      try {
        nextButton.scrollIntoView({ block: "center" });
      } catch (_error) {
        // ignore
      }
      await sleep(200);
      realClick(nextButton);
      const changed = await waitForListChange(beforeIds, 12000);
      if (changed) return { ok: true, method: "click", change: changed };
      return { ok: false, reason: "next-unchanged" };
    }

    const scrolled = await scrollToLoadMore();
    if (!scrolled) return { ok: false, reason: "no-next" };

    const changed = await waitForListChange(beforeIds, 8000);
    if (changed) return { ok: true, method: "scroll", change: changed };
    return { ok: false, reason: "no-more" };
  }

  function findNextPageButton() {
    const selectors = [
      'a[ka="page-next"]',
      ".options-pages a.next",
      ".page a.next",
      ".pagination a.next",
      ".ui-icon-arrow-right",
    ];
    for (const selector of selectors) {
      const el = document.querySelector(selector);
      if (!el) continue;
      const clickable = el.closest("a, button") || el;
      if (!isDisabled(clickable, el)) return clickable;
    }

    const nodes = Array.from(document.querySelectorAll("a, button, span"));
    for (const el of nodes) {
      const text = normalize(el.textContent);
      if (text !== "下一页" && text !== "下页") continue;
      const clickable = el.closest("a, button") || el;
      if (!isDisabled(clickable, el)) return clickable;
    }
    return null;
  }

  function classText(node) {
    if (!node) return "";
    const cls = node.className;
    if (typeof cls === "string") return cls;
    if (cls && typeof cls.baseVal === "string") return cls.baseVal;
    return String(node.getAttribute?.("class") || "");
  }

  function isDisabled(...nodes) {
    return nodes.some((node) => {
      if (!node) return false;
      const cls = `${classText(node)} ${classText(node.parentElement)}`;
      return (
        /disabled|is-disabled|btn-disabled/.test(cls) ||
        node.getAttribute?.("aria-disabled") === "true" ||
        node.hasAttribute?.("disabled")
      );
    });
  }

  async function scrollToLoadMore() {
    const scroller = findJobScroller();
    if (scroller) {
      const before = scroller.scrollTop;
      const beforeHeight = scroller.scrollHeight;
      scroller.scrollTop = scroller.scrollHeight;
      await sleep(400);
      return scroller.scrollTop !== before || scroller.scrollHeight !== beforeHeight;
    }
    const before = window.scrollY;
    window.scrollTo(0, document.documentElement.scrollHeight);
    await sleep(400);
    return window.scrollY !== before;
  }

  function findJobScroller() {
    const card = document.querySelector(".job-card-wrap, .job-card-wrapper, .job-card-box");
    if (!card) return null;
    let el = card.parentElement;
    while (el && el !== document.body) {
      const style = window.getComputedStyle(el);
      if (/(auto|scroll)/.test(style.overflowY) && el.scrollHeight > el.clientHeight + 20) {
        return el;
      }
      el = el.parentElement;
    }
    return null;
  }

  async function waitForListChange(beforeIds, timeoutMs) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      await sleep(350);
      const nowIds = collectJobs().map((job) => jobIdFromUrl(job.url)).filter(Boolean);
      if (nowIds[0] && beforeIds[0] && nowIds[0] !== beforeIds[0]) return "replaced";
      if (nowIds.some((id) => id && !beforeIds.includes(id))) return "appended";
    }
    return "";
  }

  function realClick(el) {
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    const opts = { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y };
    el.dispatchEvent(new MouseEvent("mousedown", opts));
    el.dispatchEvent(new MouseEvent("mouseup", opts));
    el.dispatchEvent(new MouseEvent("click", opts));
    if (typeof el.click === "function") el.click();
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function inspectJob(url) {
    try {
      const response = await fetch(url, { credentials: "include" });
      const html = await response.text();
      if (/security-check|滑块验证|访问异常频繁/.test(html) && !/boss-active-time|btn-startchat/.test(html)) {
        return { ok: false, blocked: true, activity: "" };
      }
      const doc = new DOMParser().parseFromString(html, "text/html");
      const activity = typeof bossApplyReadActivity === "function" ? bossApplyReadActivity(doc) : "";
      const judged = typeof bossApplyJudgeActivity === "function" ? bossApplyJudgeActivity(activity) : { pass: null, label: activity };
      const title = normalize(doc.querySelector(".job-title .name, .job-name, h1")?.textContent || "");
      const company = normalize(doc.querySelector(".company-info .name, .boss-info .name, .company-name")?.textContent || "");
      return {
        ok: true,
        blocked: false,
        activity: judged.label || activity,
        pass: judged.pass,
        title,
        company,
        url: response.url || url,
      };
    } catch (error) {
      return { ok: false, blocked: false, activity: "", error: String(error?.message || error) };
    }
  }

  function downloadExcel(rows) {
    const escape = (value) => String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
    const body = (rows || []).map((row, index) => `
      <tr>
        <td>${index + 1}</td>
        <td>${escape(row.title)}</td>
        <td>${escape(row.company)}</td>
        <td>${escape(row.activity)}</td>
        <td>${escape(row.url)}</td>
      </tr>`).join("");
    const html = `\uFEFF<html><head><meta charset="UTF-8"></head><body><table>
      <tr><th>序号</th><th>岗位名称</th><th>公司</th><th>活跃度</th><th>投递地址</th></tr>
      ${body}
    </table></body></html>`;
    const blob = new Blob([html], { type: "application/vnd.ms-excel" });
    const objectUrl = URL.createObjectURL(blob);
    const link = document.createElement("a");
    const date = new Date().toISOString().slice(0, 10);
    link.href = objectUrl;
    link.download = `BOSS直聘-3日内活跃-${(rows || []).length}-${date}.xls`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(objectUrl), 2000);
  }

  window.__bossApplyCollectJobs = collectJobs;
  window.__bossApplyGoNextPage = goNextPage;
  window.__bossApplyInspectJob = inspectJob;
})();
