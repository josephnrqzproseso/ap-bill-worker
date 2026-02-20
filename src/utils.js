function normalizeOdooBaseUrl(raw) {
  return String(raw || "")
    .trim()
    .replace(/\/+$/, "");
}

function deriveDbFromBaseUrl(baseUrl) {
  if (!baseUrl || String(baseUrl).trim() === "") return "";
  const s = String(baseUrl).trim();
  const m = s.match(/^https:\/\/([a-z0-9-]+)\.odoo\.com\b/i);
  if (!m) return "";
  const db = (m[1] || "").trim();
  if (!db || db.toLowerCase() === "false") return "";
  return db;
}

function isFalsyOdooValue(v) {
  if (v === undefined || v === null) return true;
  const s = String(v).trim();
  return s === "" || s === "false" || s === "0";
}

function m2oId(value) {
  if (Array.isArray(value)) return Number(value[0]) || 0;
  return Number(value) || 0;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function safeJsonParse(text, fallback = {}) {
  try {
    return JSON.parse(text);
  } catch (_err) {
    return fallback;
  }
}

function toNumber(value, fallback = 0) {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function asDateIsoToday() {
  return new Date().toISOString().slice(0, 10);
}

module.exports = {
  normalizeOdooBaseUrl,
  m2oId,
  sleep,
  safeJsonParse,
  toNumber,
  asDateIsoToday
};
