const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = 37891;
const OUT_DIR = path.join(__dirname, "导出");

function send(res, status, data) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS, GET",
    "Access-Control-Allow-Headers": "Content-Type",
  });
  res.end(typeof data === "string" ? data : JSON.stringify(data));
}

function toCsv(rows) {
  const esc = (value) => `"${String(value ?? "").replace(/"/g, '""')}"`;
  const lines = [["序号", "岗位名称", "公司", "活跃度", "投递地址"].join(",")];
  rows.forEach((row, index) => {
    lines.push([index + 1, row.title, row.company, row.activity, row.url].map(esc).join(","));
  });
  return `\uFEFF${lines.join("\n")}`;
}

function toXls(rows) {
  const esc = (value) => String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  const body = rows.map((row, index) => `
    <tr>
      <td>${index + 1}</td>
      <td>${esc(row.title)}</td>
      <td>${esc(row.company)}</td>
      <td>${esc(row.activity)}</td>
      <td>${esc(row.url)}</td>
    </tr>`).join("");
  return `\uFEFF<html><head><meta charset="UTF-8"></head><body><table>
    <tr><th>序号</th><th>岗位名称</th><th>公司</th><th>活跃度</th><th>投递地址</th></tr>
    ${body}
  </table></body></html>`;
}

function jsonPath() {
  return path.join(OUT_DIR, "BOSS直聘-3日内活跃.json");
}

function csvPath() {
  return path.join(OUT_DIR, "BOSS直聘-3日内活跃.csv");
}

function xlsPath() {
  return path.join(OUT_DIR, "BOSS直聘-3日内活跃.xls");
}

function saveRows(rows) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const csv = csvPath();
  const xls = xlsPath();
  const json = jsonPath();
  fs.writeFileSync(csv, toCsv(rows), "utf8");
  fs.writeFileSync(xls, toXls(rows), "utf8");
  fs.writeFileSync(json, JSON.stringify({ count: rows.length, savedAt: new Date().toISOString(), rows }, null, 2), "utf8");
  return { csvPath: csv, xlsPath: xls, jsonPath: json, count: rows.length };
}

function parseCsv(text) {
  const raw = String(text || "").replace(/^\uFEFF/, "");
  const lines = raw.split(/\r?\n/).filter(Boolean).slice(1);
  const rows = [];
  for (const line of lines) {
    const cols = [];
    let cur = "";
    let inQ = false;
    for (let i = 0; i < line.length; i += 1) {
      const ch = line[i];
      if (inQ) {
        if (ch === "\"" && line[i + 1] === "\"") {
          cur += "\"";
          i += 1;
        } else if (ch === "\"") {
          inQ = false;
        } else {
          cur += ch;
        }
      } else if (ch === "\"") {
        inQ = true;
      } else if (ch === ",") {
        cols.push(cur);
        cur = "";
      } else {
        cur += ch;
      }
    }
    cols.push(cur);
    if (cols.length >= 5 && cols[4]) {
      rows.push({
        title: cols[1] || "",
        company: cols[2] || "",
        activity: cols[3] || "",
        url: cols[4] || "",
      });
    }
  }
  return rows;
}

function readRows() {
  try {
    if (fs.existsSync(jsonPath())) {
      const data = JSON.parse(fs.readFileSync(jsonPath(), "utf8"));
      if (Array.isArray(data.rows)) {
        return { ok: true, count: data.rows.length, savedAt: data.savedAt || "", rows: data.rows };
      }
    }
  } catch (_error) {
    // fall through to csv
  }
  try {
    if (fs.existsSync(csvPath())) {
      const rows = parseCsv(fs.readFileSync(csvPath(), "utf8"));
      return { ok: true, count: rows.length, rows };
    }
  } catch (error) {
    return { ok: false, error: String(error.message || error), rows: [] };
  }
  return { ok: true, count: 0, rows: [] };
}

const server = http.createServer((req, res) => {
  if (req.method === "OPTIONS") {
    send(res, 204, "");
    return;
  }
  if (req.method === "GET" && req.url === "/health") {
    send(res, 200, { ok: true, outDir: OUT_DIR });
    return;
  }
  if (req.method === "GET" && req.url === "/rows") {
    send(res, 200, readRows());
    return;
  }
  if (req.method === "POST" && (req.url === "/save" || req.url === "/clear")) {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      try {
        const payload = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
        const rows = req.url === "/clear" ? [] : (Array.isArray(payload.rows) ? payload.rows : []);
        const saved = saveRows(rows);
        console.log(`[export] ${req.url === "/clear" ? "cleared" : "saved"} ${saved.count} rows -> ${saved.csvPath}`);
        send(res, 200, { ok: true, ...saved });
      } catch (error) {
        send(res, 400, { ok: false, error: String(error.message || error) });
      }
    });
    return;
  }
  send(res, 404, { ok: false, error: "not found" });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[export] listening on http://127.0.0.1:${PORT}`);
  console.log(`[export] writing to ${OUT_DIR}`);
});
