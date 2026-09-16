function bossApplyNormalizeText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function bossApplyReadActivity(root) {
  const scope = root || document;
  const onlineEl = scope.querySelector(".boss-online-tag, .online-tag, .boss-online, .boss-status-online");
  if (onlineEl) {
    const onlineText = bossApplyNormalizeText(onlineEl.innerText || onlineEl.textContent);
    if (!onlineText || /在线/.test(onlineText)) return onlineText || "在线";
  }

  const selectors = [
    ".boss-active-time",
    ".boss-online-tag",
    ".online-tag",
    ".boss-online",
    ".active-time",
    ".boss-status",
    ".job-boss-info .time",
    ".boss-info .time",
    ".boss-info .gray",
  ];
  for (const selector of selectors) {
    const el = scope.querySelector(selector);
    const text = bossApplyNormalizeText(el?.innerText || el?.textContent);
    if (text) return text;
  }

  const blob = bossApplyNormalizeText(scope.innerText || scope.textContent);
  const match = blob.match(bossApplyActivityPattern());
  return match ? match[0] : "";
}

function bossApplyActivityPattern() {
  return /当前在线|刚刚活跃|刚刚在线|今日活跃|今日在线|昨日活跃|昨天活跃|[0-9]+日内活跃|[一二三四五六七八九十两]日内活跃|本周活跃|一周内活跃|[0-9]+周内活跃|本月活跃|[0-9]+月内活跃|半年[内前]?活跃|[0-9]+小时前|[0-9]+分钟前|[一二三四五六七八九十两]小时前|(?:^|[^\u4e00-\u9fa5])在线(?:[^\u4e00-\u9fa5]|$)/;
}

function bossApplyJudgeActivity(text) {
  const raw = bossApplyNormalizeText(text);
  if (!raw) return { pass: null, label: "" };

  const match = raw.match(bossApplyActivityPattern());
  let label = match ? match[0].replace(/^[^\u4e00-\u9fa5]+|[^\u4e00-\u9fa5]+$/g, "") : raw.slice(0, 24);
  if (!label) label = raw.slice(0, 24);

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

  if (recent && !stale) return { pass: true, label: label || "在线" };
  if (stale) return { pass: false, label };
  if (label === "在线") return { pass: true, label: "在线" };
  return { pass: null, label };
}
