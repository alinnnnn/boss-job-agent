const DEFAULT_STATE = {
  running: false,
  target: 10,
  applied: 0,
  skipped: 0,
  failed: 0,
  scanned: 0,
  index: 0,
  jobs: [],
  seenIds: [],
  page: 1,
  onlyRecentActive: true,
  mode: "apply",
  matches: [],
  exportTarget: 80,
  currentTitle: "",
  stopReason: "",
  logs: [],
  listTabId: null,
  detailTabId: null,
  applySource: "list",
};

const KEEP_ALIVE_ALARM = "boss-apply-keepalive";
const NEXT_JOB_ALARM = "boss-apply-next";

let loopBusy = false;

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.set({ ...DEFAULT_STATE });
});

chrome.webNavigation.onHistoryStateUpdated.addListener((details) => {
  if (details.frameId === 0 && isListUrl(details.url)) injectListScript(details.tabId);
});
chrome.webNavigation.onCompleted.addListener((details) => {
  if (details.frameId === 0 && isListUrl(details.url)) injectListScript(details.tabId);
});

chrome.runtime.onStartup.addListener(async () => {
  const state = await chrome.storage.local.get(["running"]);
  if (state.running) queueMicrotask(() => processQueue());
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender)
    .then(sendResponse)
    .catch((error) => sendResponse({ ok: false, error: String(error?.message || error) }));
  return true;
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === KEEP_ALIVE_ALARM || alarm.name === NEXT_JOB_ALARM) {
    chrome.storage.local.get(["running"]).then((state) => {
      if (state.running) processQueue();
    });
  }
});

async function handleMessage(message, sender) {
  if (message?.type === "START") return startRun(message.target, sender, message.onlyRecentActive);
  if (message?.type === "START_FROM_EXPORT") return startApplyFromExport(message.target, sender, message.onlyRecentActive);
  if (message?.type === "EXPORT") return startExport(message.count, sender);
  if (message?.type === "SAVE_EXPORT_ROWS") return saveExportRows(message.rows, message.done);
  if (message?.type === "REMEMBER_APPLIED") {
    await rememberApplied(message.url);
    return { ok: true };
  }
  if (message?.type === "STOP") return stopRun(message.reason || "已手动停止");
  if (message?.type === "GET_STATE") return chrome.storage.local.get(null);
  return { ok: false, error: "unknown message" };
}

async function startRun(target, sender, onlyRecentActive) {
  const current = await chrome.storage.local.get(["running"]);
  if (current.running && loopBusy) {
    return { ok: false, error: "任务已在运行中，请先点停止" };
  }
  if (current.running && !loopBusy) {
    await stopRun("上次任务已中断，正在重新开始");
  }

  const parsedTarget = Math.max(1, Math.min(100, Number(target) || 10));
  const recentOnly = onlyRecentActive !== false;
  const listTab = await resolveListTab(sender);
  if (!listTab) {
    return { ok: false, error: "请先打开 BOSS 直聘职位列表页，筛选好岗位后再点网页投递" };
  }

  await chrome.storage.local.set({
    ...DEFAULT_STATE,
    running: true,
    applySource: "list",
    target: parsedTarget,
    onlyRecentActive: recentOnly,
    listTabId: listTab.id,
  });
  await chrome.storage.local.set({ currentTitle: "正在读取当前网页岗位…" });
  await addLog(
    "info",
    recentOnly
      ? `开始网页投递，目标 ${parsedTarget} 份，只投 3 日内活跃的 BOSS。`
      : `开始网页投递，目标 ${parsedTarget} 份。`
  );

  try {
    const jobs = await collectJobsFromList(listTab.id);
    if (!jobs.length) {
      await finish("当前列表没有识别到岗位。请确认已筛选出职位，刷新页面后再试。");
      return { ok: false, error: "当前列表没有识别到岗位，请刷新 BOSS 页面后再点网页投递" };
    }
    await chrome.storage.local.set({ jobs, index: 0, page: 1, seenIds: [] });
    await addLog("info", `第 1 页识别到 ${jobs.length} 个岗位，投完会自动翻页`);
  } catch (error) {
    await finish(`读取岗位列表失败：${error?.message || error}`);
    return { ok: false, error: String(error?.message || error) };
  }

  chrome.alarms.create(KEEP_ALIVE_ALARM, { periodInMinutes: 0.5 });
  processQueue();
  return { ok: true };
}

async function startApplyFromExport(target, sender, onlyRecentActive) {
  const current = await chrome.storage.local.get(["running"]);
  if (current.running && loopBusy) {
    return { ok: false, error: "任务已在运行中，请先点停止" };
  }
  if (current.running && !loopBusy) {
    await stopRun("上次任务已中断，正在重新开始");
  }

  const parsedTarget = Math.max(1, Math.min(100, Number(target) || 10));
  const recentOnly = onlyRecentActive !== false;
  const healthy = await pingExportServer();
  if (!healthy) {
    return { ok: false, error: "导出服务未启动。请先在项目里运行：node export-server.js" };
  }

  const fetched = await fetchExportRows();
  if (!fetched?.ok) {
    return { ok: false, error: fetched?.error || "无法读取导出文件" };
  }
  const rows = Array.isArray(fetched.rows) ? fetched.rows : [];
  if (!rows.length) {
    return { ok: false, error: "导出文件是空的，请先扫描导出后再按文件投递" };
  }

  const { appliedJobIds = [] } = await chrome.storage.local.get(["appliedJobIds"]);
  const appliedSet = new Set(appliedJobIds);
  const seen = new Set();
  const jobs = [];
  let dupFile = 0;
  let dupHistory = 0;
  for (const row of rows) {
    const url = String(row?.url || "").trim();
    const id = jobIdFromUrl(url);
    if (!url || !id) continue;
    if (seen.has(id)) {
      dupFile += 1;
      continue;
    }
    seen.add(id);
    if (appliedSet.has(id)) {
      dupHistory += 1;
      continue;
    }
    jobs.push({
      title: row.title || "",
      company: row.company || "",
      activity: row.activity || "",
      url,
    });
  }

  if (!jobs.length) {
    return {
      ok: false,
      error: dupHistory ? "导出文件里的岗位都已投过，没有新的可投" : "导出文件里没有有效投递链接",
    };
  }

  const listTab = await resolveListTab(sender);
  await chrome.storage.local.set({
    ...DEFAULT_STATE,
    running: true,
    mode: "apply",
    applySource: "excel",
    target: parsedTarget,
    onlyRecentActive: recentOnly,
    jobs,
    index: 0,
    seenIds: [],
    listTabId: listTab?.id || sender?.tab?.id || null,
    currentTitle: `按导出文件投递，满 ${parsedTarget} 份即停`,
  });
  await addLog(
    "info",
    `从导出文件读取 ${rows.length} 条，去重后待投 ${jobs.length} 条（文件内重复 ${dupFile}，历史已投 ${dupHistory}）。目标 ${parsedTarget} 份。`
  );

  chrome.alarms.create(KEEP_ALIVE_ALARM, { periodInMinutes: 0.5 });
  processQueue();
  return { ok: true };
}

async function startExport(count, sender) {
  const current = await chrome.storage.local.get(["running"]);
  if (current.running && loopBusy) {
    return { ok: false, error: "任务已在运行中，请先点停止" };
  }
  if (current.running && !loopBusy) {
    await stopRun("上次任务已中断，正在重新开始");
  }

  const listTab = await resolveListTab(sender);
  if (!listTab) {
    return { ok: false, error: "请先打开 BOSS 直聘职位列表页，筛选好岗位后再导出" };
  }

  const healthy = await pingExportServer();
  if (!healthy) {
    return { ok: false, error: "导出服务未启动。请先在项目里运行：node export-server.js" };
  }

  const exportTarget = Math.max(1, Math.min(200, parseInt(count, 10) || 80));
  await chrome.storage.local.set({
    ...DEFAULT_STATE,
    running: true,
    mode: "export",
    onlyRecentActive: true,
    exportTarget,
    target: exportTarget,
    matches: [],
    applied: 0,
    listTabId: listTab.id,
    currentTitle: `已清空旧文件，正在扫描，满 ${exportTarget} 条即停（已投过的会排除）`,
  });
  const cleared = await clearExportFiles();
  if (!cleared?.ok) {
    await finish("无法清空上次导出文件，请确认已运行 node export-server.js");
    return { ok: false, error: "无法清空上次导出文件" };
  }
  await addLog("info", `已清空上次 Excel。本次固定导出 ${exportTarget} 条未投岗位（在线/刚刚活跃/今日活跃/昨日活跃/3日内活跃，已沟通的排除）。`);

  await chrome.scripting.executeScript({
    target: { tabId: listTab.id },
    files: ["content/activity.js", "content/list.js", "content/scan.js"],
  });

  chrome.tabs.sendMessage(listTab.id, { type: "SCAN_CURRENT_PAGE" }).catch(async (error) => {
    await finish(`扫描未能启动：${error?.message || error}`);
  });
  return { ok: true };
}

async function saveExportRows(rows, done) {
  const { exportTarget } = await chrome.storage.local.get(["exportTarget"]);
  const limit = Math.max(1, Number(exportTarget) || 80);
  const list = (Array.isArray(rows) ? rows : []).slice(0, limit);
  await chrome.storage.local.set({
    matches: list,
    applied: list.length,
  });
  const saved = await postExportServer(list);
  if (done) {
    if (saved?.ok) {
      await finish(`扫描结束，已按 ${limit} 条上限导出 ${list.length} 条，已覆盖写入 导出/`);
    } else {
      await finish(`扫描结束，符合 ${list.length} 条，但写入项目失败：${saved?.error || "导出服务未启动"}`);
    }
  }
  return saved || { ok: false };
}

async function clearExportFiles() {
  try {
    const response = await fetch("http://127.0.0.1:37891/clear", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    return await response.json();
  } catch (error) {
    return { ok: false, error: String(error?.message || error) };
  }
}

async function pingExportServer() {
  try {
    const response = await fetch("http://127.0.0.1:37891/health");
    return response.ok;
  } catch (_error) {
    return false;
  }
}

async function fetchExportRows() {
  try {
    const response = await fetch("http://127.0.0.1:37891/rows");
    return await response.json();
  } catch (error) {
    return { ok: false, error: String(error?.message || error), rows: [] };
  }
}

async function postExportServer(rows) {
  try {
    const response = await fetch("http://127.0.0.1:37891/save", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rows }),
    });
    return await response.json();
  } catch (error) {
    return { ok: false, error: String(error?.message || error) };
  }
}

async function stopRun(reason) {
  const state = await chrome.storage.local.get(["detailTabId", "running", "mode", "matches", "listTabId"]);
  await chrome.storage.local.set({
    running: false,
    stopReason: reason,
    currentTitle: "",
  });
  chrome.alarms.clear(KEEP_ALIVE_ALARM);
  chrome.alarms.clear(NEXT_JOB_ALARM);
  if (state.detailTabId) {
    await closeTabQuiet(state.detailTabId);
    await chrome.storage.local.set({ detailTabId: null });
  }
  if (state.running && state.mode === "export" && state.matches?.length) {
    const saved = await postExportServer(state.matches);
    if (saved?.ok) await addLog("success", `已写入项目文件夹 导出/，共 ${state.matches.length} 条`);
  }
  if (state.running) await addLog("warn", reason);
  return { ok: true };
}

async function processQueue() {
  if (loopBusy) return;
  loopBusy = true;
  try {
    const boot = await chrome.storage.local.get(["mode", "running"]);
    if (!boot.running) return;
    if (boot.mode === "export") {
      return;
    }
    while (true) {
      const state = await chrome.storage.local.get(null);
      if (!state.running) return;
      const jobs = Array.isArray(state.jobs) ? state.jobs : [];
      const index = Number(state.index || 0);
      const applied = Number(state.applied || 0);
      const target = Number(state.target || 0);

      if (applied >= target) {
        await finish(`已完成目标：成功沟通 ${applied} 份`);
        return;
      }
      if (index >= jobs.length) {
        if (state.applySource === "excel") {
          await finish(
            `导出文件里的岗位已处理完。成功 ${applied}，跳过 ${state.skipped || 0}，失败 ${state.failed || 0}。`
          );
          return;
        }
        const nextJobs = await loadNextPageJobs(state.listTabId, jobs);
        if (!nextJobs.length) {
          await finish(
            `没有更多岗位了。成功 ${applied}，跳过 ${state.skipped || 0}，失败 ${state.failed || 0}。`
          );
          return;
        }
        continue;
      }

      const job = jobs[index];
      const jobId = jobIdFromUrl(job.url);
      const seenIds = Array.from(new Set([...(state.seenIds || []), jobId].filter(Boolean)));
      await chrome.storage.local.set({
        currentTitle: job.title || job.url,
        scanned: Number(state.scanned || 0) + 1,
        index: index + 1,
        seenIds,
      });

      if (jobId && (state.appliedJobIds || []).includes(jobId)) {
        await bump("skipped");
        await addLog("skip", `已投过，跳过：${job.title || job.url}`);
        await sleep(80);
        continue;
      }

      if (state.onlyRecentActive !== false) {
        const judged = judgeBossActivity(job.activity);
        if (judged.pass === false) {
          await bump("skipped");
          await addLog("skip", `活跃度不符（${judged.label}），跳过：${job.title || job.url}`);
          await sleep(800);
          continue;
        }
      }

      await processOneJob(state.listTabId, job, state.onlyRecentActive !== false);

      const after = await chrome.storage.local.get(["running", "applied"]);
      if (!after.running) return;
      const didApply = Number(after.applied || 0) > applied;
      await sleep(didApply ? randomBetween(8000, 15000) : randomBetween(1500, 3000));
    }
  } catch (error) {
    await finish(`任务异常中止：${error?.message || error}`);
  } finally {
    loopBusy = false;
  }
}

async function runExportLoop() {
  while (true) {
    const state = await chrome.storage.local.get(null);
    if (!state.running) return;
    const jobs = Array.isArray(state.jobs) ? state.jobs : [];
    const index = Number(state.index || 0);
    const matches = Array.isArray(state.matches) ? state.matches : [];
    const exportTarget = Number(state.exportTarget || state.target || 80);

    if (matches.length >= exportTarget) {
      await exportMatchesAndFinish(state.listTabId, matches, `已凑满 ${matches.length} 条，正在下载 Excel`);
      return;
    }
    if (index >= jobs.length) {
      const nextJobs = await loadNextPageJobs(state.listTabId, jobs);
      if (!nextJobs.length) {
        await exportMatchesAndFinish(
          state.listTabId,
          matches,
          `列表已扫完，符合条件 ${matches.length} 条（目标 ${exportTarget}）。正在下载 Excel`
        );
        return;
      }
      continue;
    }

    const job = jobs[index];
    const seenIds = Array.from(new Set([...(state.seenIds || []), jobIdFromUrl(job.url)].filter(Boolean)));
    await chrome.storage.local.set({
      currentTitle: `扫描 ${matches.length}/${exportTarget}：${job.title || "岗位"}`,
      scanned: Number(state.scanned || 0) + 1,
      index: index + 1,
      seenIds,
    });

    const listJudged = judgeBossActivity(job.activity);
    if (listJudged.pass === false) {
      await bump("skipped");
      await addLog("skip", `列表活跃度不符（${listJudged.label}），排除：${job.title || job.url}`);
      await sleep(80);
      continue;
    }

    let activity = listJudged.label || job.activity || "";
    let pass = listJudged.pass;
    let title = job.title;
    let company = job.company;
    let url = job.url;

    if (pass !== true) {
      const inspected = await inspectJobOnList(state.listTabId, job.url);
      if (inspected?.blocked) {
        await exportMatchesAndFinish(
          state.listTabId,
          matches,
          "扫描被安全验证打断，已导出当前已找到的岗位"
        );
        return;
      }
      const judged = judgeBossActivity(inspected?.activity || "");
      activity = judged.label || inspected?.activity || activity;
      pass = judged.pass;
      if (inspected?.title) title = inspected.title;
      if (inspected?.company) company = inspected.company;
      if (inspected?.url) url = inspected.url;
    }

    if (pass === true) {
      const row = { title, company, activity, url };
      const nextMatches = [...matches, row];
      await chrome.storage.local.set({
        matches: nextMatches,
        applied: nextMatches.length,
      });
      await addLog("success", `符合：${title || url}（${activity}）`);
      await sleep(randomBetween(250, 500));
    } else {
      await bump("skipped");
      await addLog("skip", `详情活跃度不符（${activity || "未识别"}），排除：${title || url}`);
      await sleep(randomBetween(180, 360));
    }
  }
}

async function inspectJobOnList(listTabId, url) {
  await ensureListScript(listTabId);
  try {
    const result = await chrome.tabs.sendMessage(listTabId, { type: "INSPECT_JOB", url });
    if (result) return result;
  } catch (_error) {
    // ignore and fallback
  }
  try {
    const [{ result } = {}] = await chrome.scripting.executeScript({
      target: { tabId: listTabId },
      func: inspectJobFallback,
      args: [url],
    });
    return result || {};
  } catch (error) {
    return { ok: false, activity: "", error: String(error?.message || error) };
  }
}

async function exportMatchesAndFinish(listTabId, matches, reason) {
  if (matches?.length) {
    try {
      await ensureListScript(listTabId);
      await chrome.tabs.sendMessage(listTabId, { type: "DOWNLOAD_EXCEL", rows: matches });
      await addLog("success", `Excel 已开始下载，共 ${matches.length} 条`);
    } catch (error) {
      await addLog("error", `下载失败：${error?.message || error}，将尝试备用方式`);
      await downloadExcelFallback(matches);
    }
  }
  await finish(reason);
}

async function downloadExcelFallback(rows) {
  const html = buildExcelHtml(rows);
  const dataUrl = "data:application/vnd.ms-excel;charset=utf-8," + encodeURIComponent(html);
  const date = new Date().toISOString().slice(0, 10);
  try {
    const [{ result } = {}] = await chrome.scripting.executeScript({
      target: { tabId: (await chrome.storage.local.get(["listTabId"])).listTabId },
      func: (content, filename) => {
        const blob = new Blob([content], { type: "application/vnd.ms-excel" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = filename;
        a.click();
        URL.revokeObjectURL(url);
        return true;
      },
      args: [html, `BOSS直聘-3日内活跃-${rows.length}-${date}.xls`],
    });
    if (!result) throw new Error("content download failed");
  } catch (_error) {
    await chrome.storage.local.set({ exportHtml: html });
    await addLog("warn", "无法自动下载，请从插件弹窗再次点击导出");
  }
}

function buildExcelHtml(rows) {
  const escape = (value) => String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
  const body = (rows || []).map((row, index) => `
    <tr>
      <td>${index + 1}</td>
      <td>${escape(row.title)}</td>
      <td>${escape(row.company)}</td>
      <td>${escape(row.activity)}</td>
      <td>${escape(row.url)}</td>
    </tr>`).join("");
  return `\uFEFF<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel">
<head><meta charset="UTF-8"></head>
<body>
<table>
<tr><th>序号</th><th>岗位名称</th><th>公司</th><th>活跃度</th><th>投递地址</th></tr>
${body}
</table>
</body></html>`;
}

function inspectJobFallback(url) {
  return fetch(url, { credentials: "include" })
    .then((res) => res.text().then((html) => ({ html, finalUrl: res.url })))
    .then(({ html, finalUrl }) => {
      if (/security-check|滑块验证/.test(html) && !/boss-active-time|btn-startchat/.test(html)) {
        return { ok: false, blocked: true, activity: "" };
      }
      const match = String(html).match(/boss-active-time[^>]*>([^<]+)/) ||
        String(html).match(/>(刚刚活跃|今日活跃|昨日活跃|当前在线|[0-9]+日内活跃|本周活跃|本月活跃|半年[内前]?活跃)</);
      const activity = match ? String(match[1] || match[0]).replace(/<[^>]+>/g, "").trim() : "";
      return { ok: true, blocked: false, activity, url: finalUrl || url };
    })
    .catch((error) => ({ ok: false, blocked: false, activity: "", error: String(error) }));
}

async function collectJobsFromList(listTabId) {
  await ensureListScript(listTabId);
  try {
    const response = await chrome.tabs.sendMessage(listTabId, { type: "COLLECT_JOBS" });
    if (response?.jobs?.length) return response.jobs;
  } catch (_error) {
    // 回退到直接注入采集
  }

  const [{ result } = {}] = await chrome.scripting.executeScript({
    target: { tabId: listTabId },
    func: collectJobsInPage,
  });
  return Array.isArray(result) ? result : [];
}

async function loadNextPageJobs(listTabId, currentJobs) {
  const state = await chrome.storage.local.get(["seenIds", "page", "running", "mode"]);
  if (!state.running) return [];

  const page = Number(state.page || 1);
  const maxPages = state.mode === "export" ? 80 : 30;
  if (page >= maxPages) {
    await addLog("warn", `已达到 ${maxPages} 页上限，停止翻页`);
    return [];
  }

  const seen = new Set([
    ...(state.seenIds || []),
    ...currentJobs.map((job) => jobIdFromUrl(job.url)).filter(Boolean),
  ]);

  await chrome.storage.local.set({
    currentTitle: "正在翻到下一页…",
    seenIds: Array.from(seen),
  });
  await addLog("info", `第 ${page} 页已处理完，尝试加载更多岗位`);
  await focusTabQuiet(listTabId);
  await sleep(400);

  await ensureListScript(listTabId);
  await chrome.scripting.executeScript({
    target: { tabId: listTabId },
    files: ["content/list.js"],
  });
  let turned = null;
  try {
    turned = await chrome.tabs.sendMessage(listTabId, { type: "GO_NEXT_PAGE" });
  } catch (_error) {
    const [{ result } = {}] = await chrome.scripting.executeScript({
      target: { tabId: listTabId },
      func: clickNextPageFallback,
    });
    turned = result;
  }

  if (!turned?.ok) {
    await addLog("info", "没有下一页或无法继续加载");
    return [];
  }

  await sleep(randomBetween(1200, 2200));
  const jobs = await collectJobsFromList(listTabId);
  const fresh = jobs.filter((job) => {
    const id = jobIdFromUrl(job.url);
    return id && !seen.has(id);
  });

  if (!fresh.length) {
    await addLog("info", "翻页后没有发现新岗位");
    return [];
  }

  const nextPage = page + 1;
  await chrome.storage.local.set({
    jobs: fresh,
    index: 0,
    page: nextPage,
    seenIds: Array.from(seen),
  });
  await addLog("info", `已到第 ${nextPage} 页，新增 ${fresh.length} 个岗位`);
  return fresh;
}

function jobIdFromUrl(url) {
  const match = String(url || "").match(/job_detail\/([^./?#]+)/);
  return match ? match[1] : "";
}

async function rememberApplied(url) {
  const id = jobIdFromUrl(url);
  if (!id) return;
  const { appliedJobIds = [] } = await chrome.storage.local.get(["appliedJobIds"]);
  if (appliedJobIds.includes(id)) return;
  await chrome.storage.local.set({ appliedJobIds: [...appliedJobIds, id].slice(-5000) });
}

function judgeBossActivity(text) {
  const raw = String(text || "").replace(/\s+/g, " ").trim();
  if (!raw) return { pass: null, label: "" };
  const match = raw.match(
    /当前在线|刚刚活跃|刚刚在线|今日活跃|今日在线|昨日活跃|昨天活跃|[0-9]+日内活跃|[一二三四五六七八九十两]日内活跃|本周活跃|一周内活跃|[0-9]+周内活跃|本月活跃|[0-9]+月内活跃|半年[内前]?活跃|[0-9]+小时前|[0-9]+分钟前|[一二三四五六七八九十两]小时前|在线/
  );
  const label = match ? match[0] : raw.slice(0, 24);
  const stale =
    /本周|一周|[4-9]日内|[4-9]天内|[四五六七八九十]日内|周内|本月|月内|半年|年内|很久未|未活跃|不在线/.test(label) ||
    /(?:^|[^0-9])(?:[4-9]|[1-9][0-9]+)日内/.test(label);
  const recent =
    /当前在线|刚刚活跃|刚刚在线|今日活跃|今日在线|昨日活跃|昨天活跃|分钟前|小时前|半小时/.test(label) ||
    /(?:^|[^0-9])[1-3]日内活跃/.test(label) ||
    /[一二三两]日内活跃/.test(label) ||
    /(?:^|[^0-9])[1-3]天内/.test(label) ||
    /^在线$/.test(label) ||
    (/(^|[^不])在线/.test(label) && !/不在线|未在线/.test(label) && !/月|周|半年/.test(label));
  if (recent && !stale) return { pass: true, label };
  if (stale) return { pass: false, label };
  if (label === "在线") return { pass: true, label: "在线" };
  return { pass: null, label };
}

async function detectRestrictedPage(tabId) {
  try {
    const [{ result } = {}] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const text = String(document.body?.innerText || "").replace(/\s+/g, " ");
        if (!/访问受限|账户存在异常|已暂时被限制|暂时无法访问此页面|请勿频繁提交刷新/.test(text)) {
          return "";
        }
        const until = text.match(/将于\s*([0-9]{4}-[0-9]{2}-[0-9]{2}\s*[0-9]{2}:[0-9]{2})\s*恢复/);
        return until ? `访问受限，约 ${until[1]} 恢复` : "访问受限";
      },
    });
    return result || "";
  } catch (_error) {
    return "";
  }
}

async function processOneJob(listTabId, job, onlyRecentActive) {
  const label = [job.title, job.company].filter(Boolean).join(" · ") || job.url;
  await addLog("info", `打开岗位：${label}${job.activity ? `（${job.activity}）` : ""}`);

  let detailTab;
  try {
    detailTab = await chrome.tabs.create({ url: job.url, active: true });
    await chrome.storage.local.set({ detailTabId: detailTab.id });
    await waitTabComplete(detailTab.id, 25000);
    await sleep(randomBetween(4000, 7000));

    const stillRunning = (await chrome.storage.local.get(["running"])).running;
    if (!stillRunning) return;

    const restricted = await detectRestrictedPage(detailTab.id);
    if (restricted) {
      await finish(`BOSS 已限制访问（${restricted}）。请等到页面提示的恢复时间后再用，期间不要反复刷新。`);
      return;
    }

    const result = await runDetailAction(detailTab.id, onlyRecentActive);
    await handleDetailResult(result, job);
  } catch (error) {
    await bump("failed");
    await addLog("error", `${label} 处理失败：${error?.message || error}`);
  } finally {
    if (detailTab?.id) await closeTabQuiet(detailTab.id);
    await chrome.storage.local.set({ detailTabId: null });
    await focusTabQuiet(listTabId);
  }
}

async function runDetailAction(tabId, onlyRecentActive) {
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ["content/activity.js", "content/detail.js"],
  });

  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      const result = await chrome.tabs.sendMessage(tabId, {
        type: "PROCESS_JOB",
        onlyRecentActive: Boolean(onlyRecentActive),
      });
      if (result) return result;
    } catch (_error) {
      await sleep(400);
    }
  }

  const [{ result } = {}] = await chrome.scripting.executeScript({
    target: { tabId },
    func: inspectAndClickFallback,
    args: [Boolean(onlyRecentActive)],
  });
  return result || { status: "not_found", text: "" };
}

async function handleDetailResult(result, job) {
  const status = result?.status || "unknown";
  const text = result?.text || "";
  const label = [job?.title, job?.company].filter(Boolean).join(" · ") || job?.url || "";

  if (status === "applied") {
    await rememberApplied(job?.url);
    await bump("applied");
    await addLog("success", `已沟通：${label}`);
    return;
  }
  if (status === "stopped") {
    return;
  }
  if (status === "already") {
    await rememberApplied(job?.url);
    await bump("skipped");
    await addLog("skip", `已投递过（${text || "继续沟通"}），跳过：${label}`);
    return;
  }
  if (status === "inactive") {
    await bump("skipped");
    await addLog("skip", `活跃度不符（${text || "未在3日内活跃"}），跳过：${label}`);
    return;
  }
  if (status === "limit") {
    await bump("failed");
    await finish(`触发上限或风控：${text || "访问受限"}。已停止，请等到恢复后再用，不要反复刷新。`);
    return;
  }
  if (status === "login") {
    await bump("failed");
    await finish("登录状态失效，请先登录 BOSS 直聘后再试。");
    return;
  }
  if (status === "not_found") {
    await bump("failed");
    await addLog("error", `未找到沟通按钮：${label}`);
    return;
  }

  await bump("failed");
  await addLog("warn", `未处理（${text || status}）：${label}`);
}

async function finish(reason) {
  const state = await chrome.storage.local.get(["detailTabId", "listTabId"]);
  chrome.alarms.clear(KEEP_ALIVE_ALARM);
  chrome.alarms.clear(NEXT_JOB_ALARM);
  if (state.detailTabId) await closeTabQuiet(state.detailTabId);
  await chrome.storage.local.set({
    running: false,
    stopReason: reason,
    currentTitle: "",
    detailTabId: null,
  });
  await addLog("info", reason);
  if (state.listTabId) await focusTabQuiet(state.listTabId);
}

async function resolveListTab(sender) {
  const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
  const candidates = [sender?.tab, active].filter(Boolean);
  for (const tab of candidates) {
    if (tab?.id && isListUrl(tab.url)) return tab;
  }
  const listed = await chrome.tabs.query({
    url: [
      "https://www.zhipin.com/web/geek/job*",
      "https://www.zhipin.com/web/geek/jobs*",
      "https://www.zhipin.com/web/geek/recommend*",
    ],
  });
  return listed.find((tab) => isListUrl(tab.url)) || null;
}

function isListUrl(url = "") {
  if (!url) return false;
  if (/job_detail|\/web\/geek\/chat|\/web\/user\//.test(url)) return false;
  return /zhipin\.com\/web\/geek\//.test(url) || /zhipin\.com\/c\d+/.test(url);
}

async function injectListScript(tabId) {
  if (!tabId) return;
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["content/list.js"],
    });
  } catch (_error) {
    // 页面可能尚未允许注入
  }
}

async function ensureListScript(tabId) {
  await injectListScript(tabId);
}

function waitTabComplete(tabId, timeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      chrome.tabs.onUpdated.removeListener(onUpdated);
      reject(new Error("详情页加载超时"));
    }, timeoutMs);

    function done() {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      resolve();
    }

    function onUpdated(id, info) {
      if (id === tabId && info.status === "complete") done();
    }

    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.get(tabId).then((tab) => {
      if (tab?.status === "complete") done();
    }).catch((error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      reject(error);
    });
  });
}

async function bump(field) {
  const state = await chrome.storage.local.get([field]);
  await chrome.storage.local.set({ [field]: Number(state[field] || 0) + 1 });
}

async function addLog(level, message) {
  const { logs = [] } = await chrome.storage.local.get(["logs"]);
  const next = [{ time: Date.now(), level, message }, ...logs].slice(0, 80);
  await chrome.storage.local.set({ logs: next });
}

async function closeTabQuiet(tabId) {
  try {
    await chrome.tabs.remove(tabId);
  } catch (_error) {
    // 标签页可能已被用户关掉
  }
}

async function focusTabQuiet(tabId) {
  if (!tabId) return;
  try {
    await chrome.tabs.update(tabId, { active: true });
  } catch (_error) {
    // 列表页可能已关闭
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomBetween(min, max) {
  return Math.floor(min + Math.random() * (max - min));
}

function collectJobsInPage() {
  const seen = new Set();
  const jobs = [];

  const jobId = (url) => {
    const match = String(url).match(/job_detail\/([^./?#]+)/);
    return match ? match[1] : "";
  };

  const add = (url, title, company, activity) => {
    if (!url || String(url).startsWith("javascript:")) return;
    let absolute = "";
    try {
      absolute = new URL(url, location.origin).href;
    } catch (_error) {
      return;
    }
    const id = jobId(absolute);
    if (!id || seen.has(id)) return;
    seen.add(id);
    jobs.push({
      url: absolute,
      title: (title || "").replace(/\s+/g, " ").trim(),
      company: (company || "").replace(/\s+/g, " ").trim(),
      activity: (activity || "").replace(/\s+/g, " ").trim(),
    });
  };

  const readActivity = (root) => {
    const el =
      root.querySelector(".boss-active-time, .boss-online-tag, .online-tag, .boss-online, .active-time") ||
      root.querySelector(".boss-status, .job-boss-info .time, .boss-info .time");
    const direct = (el?.innerText || "").replace(/\s+/g, " ").trim();
    if (direct) return direct;
    const blob = (root.innerText || "").replace(/\s+/g, " ");
    const match = blob.match(
      /当前在线|刚刚活跃|今日活跃|昨日活跃|昨天活跃|[0-9]+日内活跃|本周活跃|本月活跃|半年[内前]?活跃|在线/
    );
    return match ? match[0] : "";
  };

  const cards = document.querySelectorAll(
    ".job-card-wrap, .job-card-wrapper, .job-card-box, li.job-card-wrapper, .job-list-item, .job-card-left"
  );
  cards.forEach((card) => {
    const link =
      card.querySelector('a[href*="job_detail"], a.job-name, a.job-card-left') ||
      (card.matches("a") ? card : null);
    if (!link) return;
    add(
      link.getAttribute("href") || link.href,
      (card.querySelector(".job-name, .job-title") || link).textContent,
      (card.querySelector(".boss-name, .company-name, .company-info .name") || {}).textContent || "",
      readActivity(card)
    );
  });

  if (!jobs.length) {
    document.querySelectorAll('a[href*="/job_detail/"]').forEach((link) => {
      add(link.href, link.textContent, "", readActivity(link.closest("li, .job-card-wrap, .job-card-box") || link));
    });
  }
  return jobs;
}

function inspectAndClickFallback(onlyRecentActive) {
  const textOf = (el) => (el?.innerText || el?.textContent || "").replace(/\s+/g, " ").trim();
  const body = textOf(document.body);
  if (/请先登录|登录后查看|扫码登录/.test(body) && !/立即沟通|继续沟通/.test(body)) {
    return { status: "login", text: "需要登录" };
  }
  if (/今日沟通人数已达|沟通人数.*上限|操作过于频繁|验证码|安全验证|滑块|访问受限|账户存在异常|暂时被限制|暂时无法访问/.test(body)) {
    return { status: "limit", text: "页面提示上限、验证或访问受限" };
  }

  if (onlyRecentActive) {
    const activityEl = document.querySelector(".boss-active-time, .boss-online-tag, .online-tag, .boss-online");
    const activity = textOf(activityEl) || (body.match(/刚刚活跃|今日活跃|昨日活跃|[0-9]+日内活跃|本周活跃|本月活跃|半年[内前]?活跃|在线/) || [""])[0];
    const stale = /本周|一周|[4-9]日内|周内|本月|月内|半年|年内/.test(activity);
    const recent = /在线|刚刚活跃|今日活跃|昨日活跃|昨天活跃|[1-3]日内活跃|分钟前|小时前/.test(activity);
    if (activity && stale && !recent) return { status: "inactive", text: activity };
    if (!recent) return { status: "inactive", text: activity || "未识别到3日内活跃" };
  }

  const nodes = Array.from(document.querySelectorAll("a, button, span, div"));
  const chat = nodes.find((el) => /^(立即沟通|继续沟通|已沟通)$/.test(textOf(el)));
  const text = textOf(chat);
  if (/继续沟通|已沟通/.test(text)) return { status: "already", text };
  if (text === "立即沟通") {
    (chat.closest("a, button") || chat).click();
    return { status: "applied", text };
  }
  return { status: "not_found", text };
}

function clickNextPageFallback() {
  const disabled = (el) => {
    const node = el?.closest("a, button") || el;
    const cls = `${node?.className || ""} ${el?.className || ""}`;
    return /disabled|is-disabled/.test(cls);
  };
  const next =
    document.querySelector('a[ka="page-next"]') ||
    document.querySelector(".page a.next") ||
    Array.from(document.querySelectorAll("a, button")).find((el) =>
      /^(下一页|下页)$/.test((el.innerText || "").trim())
    );
  if (!next || disabled(next)) return { ok: false, reason: "no-next" };
  (next.closest("a, button") || next).click();
  return { ok: true, method: "click" };
}
