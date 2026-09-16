const targetInput = document.getElementById("target");
const exportCountInput = document.getElementById("export-count");
const recentInput = document.getElementById("recent");
const startBtn = document.getElementById("start");
const exportBtn = document.getElementById("export");
const fromExportBtn = document.getElementById("from-export");
const stopBtn = document.getElementById("stop");
const statusEl = document.getElementById("status");
const currentEl = document.getElementById("current");
const logsEl = document.getElementById("logs");

startBtn.addEventListener("click", async () => {
  const target = Number(targetInput.value || 10);
  currentEl.textContent = "正在读取当前网页岗位…";
  try {
    const response = await chrome.runtime.sendMessage({
      type: "START",
      target,
      onlyRecentActive: Boolean(recentInput.checked),
    });
    if (!response?.ok) currentEl.textContent = response?.error || "启动失败";
  } catch (error) {
    currentEl.textContent = `启动失败：${error?.message || error}`;
  }
});

recentInput.addEventListener("change", () => {
  chrome.storage.local.set({ onlyRecentActive: recentInput.checked });
});

targetInput.addEventListener("change", () => {
  chrome.storage.local.set({
    target: Math.max(1, Math.min(100, Number(targetInput.value) || 10)),
  });
});

exportCountInput.addEventListener("change", () => {
  chrome.storage.local.set({
    exportTarget: Math.max(1, Math.min(200, Number(exportCountInput.value) || 80)),
  });
});

stopBtn.addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "STOP", reason: "已手动停止" });
});

exportBtn.addEventListener("click", async () => {
  currentEl.textContent = "正在扫描 3 日内活跃岗位…";
  try {
    const response = await chrome.runtime.sendMessage({
      type: "EXPORT",
      count: Number(exportCountInput.value || 80),
    });
    if (!response?.ok) currentEl.textContent = response?.error || "导出失败";
  } catch (error) {
    currentEl.textContent = `导出失败：${error?.message || error}`;
  }
});

fromExportBtn.addEventListener("click", async () => {
  currentEl.textContent = "正在读取导出文件…";
  try {
    const response = await chrome.runtime.sendMessage({
      type: "START_FROM_EXPORT",
      target: Number(targetInput.value || 10),
      onlyRecentActive: Boolean(recentInput.checked),
    });
    if (!response?.ok) currentEl.textContent = response?.error || "启动失败";
  } catch (error) {
    currentEl.textContent = `启动失败：${error?.message || error}`;
  }
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local") render();
});

render();

async function render() {
  const state = await chrome.storage.local.get(null);
  const running = Boolean(state.running);
  statusEl.textContent = running ? "运行中" : "未运行";
  statusEl.classList.toggle("on", running);
  startBtn.disabled = running;
  exportBtn.disabled = running;
  fromExportBtn.disabled = running;
  stopBtn.disabled = !running;
  if (!running) {
    targetInput.value = state.target || 10;
    exportCountInput.value = state.exportTarget || 80;
    recentInput.checked = state.onlyRecentActive !== false;
  }
  document.getElementById("applied").textContent = running
    ? `${state.applied || 0}/${state.target || 10}`
    : String(state.applied || 0);
  document.getElementById("skipped").textContent = state.skipped || 0;
  document.getElementById("failed").textContent = state.failed || 0;
  currentEl.textContent = state.currentTitle
    ? `正在处理：${state.currentTitle}`
    : state.stopReason || "";

  const logs = Array.isArray(state.logs) ? state.logs.slice(0, 20) : [];
  logsEl.innerHTML = logs
    .map((item) => `<li class="${item.level}">${escapeHtml(item.message)}</li>`)
    .join("");
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
