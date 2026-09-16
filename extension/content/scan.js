(() => {
  const SCAN_VERSION = 6;
  if (window.__bossApplyScanVersion === SCAN_VERSION) return;
  window.__bossApplyScanVersion = SCAN_VERSION;
  window.__bossApplyScanLoaded = true;

  window.__bossApplyScanCurrentPage = scanCurrentPage;

  async function scanCurrentPage() {
    const processed = new Set();
    const matches = [];
    let emptyScrolls = 0;
    const { exportTarget, appliedJobIds } = await chrome.storage.local.get(["exportTarget", "appliedJobIds"]);
    const target = Math.max(1, Number(exportTarget) || 80);
    const appliedSet = new Set(appliedJobIds || []);
    let reached = false;

    await report({ currentTitle: `正在扫描当前列表，满 ${target} 条未投岗位即停`, applied: 0, scanned: 0, skipped: 0, mode: "export" });

    while (await stillRunning()) {
      if (isAccessRestricted()) {
        await chrome.runtime.sendMessage({
          type: "STOP",
          reason: "BOSS 已限制访问。请等到页面提示的恢复时间后再用，期间不要反复刷新。",
        }).catch(() => {});
        break;
      }
      const cards = getCards();
      let handled = 0;

      for (const card of cards) {
        if (!(await stillRunning())) break;
        const id = cardId(card);
        if (!id || processed.has(id)) continue;
        processed.add(id);
        handled += 1;

        const info = readCard(card);
        const jobId = String(info.url || "").match(/job_detail\/([^./?#]+)/)?.[1] || id;
        await report({
          currentTitle: `扫描 ${processed.size}，符合 ${matches.length}/${target}：${info.title || "岗位"}`,
          applied: matches.length,
          scanned: processed.size,
          skipped: Math.max(0, processed.size - matches.length),
        });

        if (appliedSet.has(id) || appliedSet.has(jobId)) {
          continue;
        }

        card.scrollIntoView({ block: "center", inline: "nearest" });
        await sleep(randomBetween(1500, 2500));
        clickCard(card);
        const panel = await waitPanel(info.activity, 6000);
        if (panel.chat === "already") {
          appliedSet.add(id);
          appliedSet.add(jobId);
          await chrome.runtime.sendMessage({ type: "REMEMBER_APPLIED", url: info.url }).catch(() => {});
          await report({
            currentTitle: `已沟通，排除：${info.title || "岗位"}`,
            applied: matches.length,
            scanned: processed.size,
            skipped: Math.max(0, processed.size - matches.length),
          });
          continue;
        }

        const judged = typeof bossApplyJudgeActivity === "function"
          ? bossApplyJudgeActivity(panel.activity)
          : { pass: null, label: panel.activity };

        if (judged.pass === true) {
          const row = {
            title: info.title || readPanelTitle(),
            company: info.company || readPanelCompany(),
            activity: judged.label || panel.activity || "在线",
            url: info.url,
          };
          if (row.url && !matches.some((item) => item.url === row.url) && matches.length < target) {
            matches.push(row);
            await chrome.runtime.sendMessage({ type: "SAVE_EXPORT_ROWS", rows: matches.slice(0, target), done: false }).catch(() => {});
          }
        }

        if (matches.length >= target) {
          reached = true;
          break;
        }
        await sleep(randomBetween(2000, 3500));
      }

      if (reached || !(await stillRunning())) break;

      if (handled === 0) {
        const grew = await scrollListMore();
        if (!grew) {
          emptyScrolls += 1;
          if (emptyScrolls >= 3) break;
        } else {
          emptyScrolls = 0;
        }
      } else {
        emptyScrolls = 0;
        await scrollListMore();
      }
    }

    await chrome.runtime.sendMessage({
      type: "SAVE_EXPORT_ROWS",
      rows: matches.slice(0, target),
      done: true,
    }).catch(() => {});
    return { ok: true, matches: matches.slice(0, target), scanned: processed.size };
  }

  function getCards() {
    return Array.from(document.querySelectorAll(
      ".job-card-wrap, .job-card-wrapper, .job-card-box, li.job-card-wrapper, .job-list-item"
    ));
  }

  function cardId(card) {
    const href = card.querySelector('a[href*="job_detail"]')?.href ||
      card.querySelector("a.job-name, a.job-card-left")?.href ||
      "";
    const match = String(href).match(/job_detail\/([^./?#]+)/);
    return match ? match[1] : (card.innerText || "").slice(0, 40);
  }

  function readCard(card) {
    const link = card.querySelector('a[href*="job_detail"]') || card.querySelector("a.job-name, a.job-card-left");
    return {
      url: link?.href || "",
      title: normalize((card.querySelector(".job-name, .job-title") || link)?.textContent || ""),
      company: normalize(card.querySelector(".boss-name, .company-name")?.textContent || ""),
      activity: typeof bossApplyReadActivity === "function" ? bossApplyReadActivity(card) : "",
    };
  }

  function clickCard(card) {
    const target = card.querySelector(".job-name, .job-title, .job-card-left") || card;
    target.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, view: window }));
    target.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, view: window }));
    target.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
    if (typeof target.click === "function") target.click();
  }

  function panelRoot() {
    return document.querySelector(".job-detail-container, .job-detail-box, .job-detail, .job-detail-body") || document;
  }

  async function waitPanel(fallback, timeoutMs) {
    const started = Date.now();
    let activity = fallback || "";
    let chat = "";
    while (Date.now() - started < timeoutMs) {
      const panelText = typeof bossApplyReadActivity === "function" ? bossApplyReadActivity(panelRoot()) : "";
      if (panelText) activity = panelText;
      chat = readChatStatus(panelRoot()) || chat;
      if (chat === "already") return { activity, chat };
      const judged = typeof bossApplyJudgeActivity === "function"
        ? bossApplyJudgeActivity(activity)
        : { pass: null };
      if (judged.pass === true || judged.pass === false) {
        if (chat || Date.now() - started > 1800) return { activity, chat };
      }
      await sleep(250);
    }
    return {
      activity: activity || (typeof bossApplyReadActivity === "function" ? bossApplyReadActivity(panelRoot()) : ""),
      chat: chat || readChatStatus(panelRoot()),
    };
  }

  function readChatStatus(root) {
    const scope = root || document;
    const selectors = [
      ".btn-startchat",
      "a.btn-startchat",
      "button.btn-startchat",
      ".op-btn-chat",
      ".job-detail-op .op-btn-chat",
      ".start-chat-btn",
      ".btn.btn-startchat",
    ];
    for (const selector of selectors) {
      const el = scope.querySelector(selector);
      const text = normalize(el?.innerText || el?.textContent);
      if (/继续沟通|已沟通/.test(text)) return "already";
      if (text === "立即沟通") return "ready";
    }
    const op = scope.querySelector(".job-detail-op, .job-op, .op-btn-wrap, .job-detail-container")
      || (scope !== document ? scope : null);
    if (!op) return "";
    const nodes = Array.from(op.querySelectorAll("a, button"));
    for (const el of nodes) {
      const text = normalize(el.innerText || el.textContent);
      if (text === "继续沟通" || text === "已沟通") return "already";
      if (text === "立即沟通") return "ready";
    }
    return "";
  }

  function readPanelTitle() {
    return normalize(panelRoot().querySelector(".job-name, .name")?.textContent || "");
  }

  function readPanelCompany() {
    return normalize(panelRoot().querySelector(".company-info .name, .boss-name, .company-name")?.textContent || "");
  }

  async function scrollListMore() {
    const scroller = findScroller();
    if (scroller) {
      const beforeCount = getCards().length;
      const beforeHeight = scroller.scrollHeight;
      const beforeTop = scroller.scrollTop;
      scroller.scrollTop = scroller.scrollHeight;
      await sleep(1400);
      return getCards().length > beforeCount ||
        scroller.scrollHeight > beforeHeight + 10 ||
        scroller.scrollTop > beforeTop + 10;
    }
    const beforeY = window.scrollY;
    const beforeCount = getCards().length;
    window.scrollTo(0, document.documentElement.scrollHeight);
    await sleep(1400);
    return window.scrollY > beforeY + 10 || getCards().length > beforeCount;
  }

  function findScroller() {
    const card = getCards()[0];
    if (!card) return null;
    let el = card.parentElement;
    while (el && el !== document.body) {
      const style = window.getComputedStyle(el);
      if (/(auto|scroll)/.test(style.overflowY) && el.scrollHeight > el.clientHeight + 20) return el;
      el = el.parentElement;
    }
    return null;
  }

  async function stillRunning() {
    try {
      const state = await chrome.storage.local.get(["running"]);
      return Boolean(state.running);
    } catch (_error) {
      return false;
    }
  }

  async function report(patch) {
    try {
      await chrome.storage.local.set(patch);
    } catch (_error) {
      // ignore
    }
  }

  function normalize(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
  }

  function isAccessRestricted() {
    const text = normalize(document.body?.innerText || document.body?.textContent || "");
    return /访问受限|账户存在异常|已暂时被限制|暂时无法访问此页面|请勿频繁提交刷新/.test(text);
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function randomBetween(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }
})();
