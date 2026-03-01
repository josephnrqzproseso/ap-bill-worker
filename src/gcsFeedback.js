const { readJsonObject, writeJsonObject } = require("./gcs");
const { config } = require("./config");

const bucket = () => config.gcs.stateBucket;
const feedbackObjectName = () => `${config.gcs.feedbackPrefix}/feedback.json`;
const vendorMemoryObjectName = () => `${config.gcs.vendorMemoryPrefix}/vendor_memory.json`;

/**
 * Load feedback corrections from GCS, filter by target_key and industry (per-target so each DB is independent).
 * @param {string} targetKey - Unique target identifier (e.g. from routing); ensures feedback is per database.
 * @returns {Promise<Array<{ vendor_name, item_description, original_account_code, original_account_name, corrected_account_code, corrected_account_name, correction_type? }>>}
 */
async function loadFeedbackCorrections(targetKey, industry, limit = 20) {
  if (!bucket()) return [];
  const arr = await readJsonObject(bucket(), feedbackObjectName(), []);
  if (!Array.isArray(arr)) return [];
  const tk = String(targetKey || "").trim();
  const filtered = arr.filter(
    (r) => String(r.target_key || "").trim() === tk && String(r.industry || "").trim() === String(industry || "").trim()
  );
  filtered.sort((a, b) => (new Date(b.timestamp || 0) - new Date(a.timestamp || 0)));
  return filtered.slice(0, limit).map((r) => ({
    vendor_name: r.vendor_name,
    item_description: r.item_description,
    original_account_code: r.original_account_code,
    original_account_name: r.original_account_name,
    corrected_account_code: r.corrected_account_code,
    corrected_account_name: r.corrected_account_name,
    correction_type: r.correction_type
  }));
}

/**
 * Append correction rows to the Feedback JSON in GCS.
 * @param {Array<Object>} rows - Array of correction objects (timestamp, doc_id, bill_id, company_id, industry, vendor_name, ...).
 */
async function appendFeedbackCorrections(rows) {
  if (!bucket() || !rows.length) return;
  const arr = await readJsonObject(bucket(), feedbackObjectName(), []);
  const next = Array.isArray(arr) ? [...arr, ...rows] : rows;
  await writeJsonObject(bucket(), feedbackObjectName(), next);
}

/**
 * Load VendorAccountMemory from GCS, filter by target_key (per-target so each DB has its own memory).
 * @param {string} targetKey - Unique target identifier; ensures vendor memory is per database.
 * @returns {Promise<Array<{ vendor_name_pattern, target_key, account_code, account_name, confidence, correction_count }>>}
 */
async function loadVendorAccountMemory(targetKey) {
  if (!bucket()) return [];
  const arr = await readJsonObject(bucket(), vendorMemoryObjectName(), []);
  if (!Array.isArray(arr)) return [];
  const tk = String(targetKey || "").trim();
  return arr.filter((r) => String(r.target_key || "").trim() === tk);
}

/**
 * Save full VendorAccountMemory array to GCS (read-modify-write is done by caller).
 * @param {Array<Object>} rows - Full array of vendor memory entries.
 */
async function saveVendorAccountMemory(rows) {
  if (!bucket()) return;
  await writeJsonObject(bucket(), vendorMemoryObjectName(), Array.isArray(rows) ? rows : []);
}

/**
 * Group feedback by (target_key, vendor_name, corrected_account_*) and merge into vendor memory when count >= 3.
 * Each target database gets its own vendor memory entries (keyed by target_key).
 */
async function updateVendorMemoryFromFeedback(logger) {
  if (!bucket()) return;
  const arr = await readJsonObject(bucket(), feedbackObjectName(), []);
  if (!Array.isArray(arr) || !arr.length) return;
  const key = (r) => `${String(r.target_key || "").trim()}|${String(r.vendor_name || "").trim().toLowerCase()}|${String(r.corrected_account_code || "").trim()}`;
  const counts = new Map();
  const byKey = new Map();
  for (const r of arr) {
    const k = key(r);
    counts.set(k, (counts.get(k) || 0) + 1);
    if (!byKey.has(k)) byKey.set(k, r);
  }
  const toAdd = [];
  for (const [k, count] of counts) {
    if (count < 3) continue;
    const r = byKey.get(k);
    toAdd.push({
      vendor_name_pattern: String(r.vendor_name || "").trim(),
      target_key: String(r.target_key || "").trim(),
      account_code: String(r.corrected_account_code || "").trim(),
      account_name: String(r.corrected_account_name || "").trim(),
      confidence: 0.85,
      correction_count: count
    });
  }
  if (!toAdd.length) return;
  const existing = await readJsonObject(bucket(), vendorMemoryObjectName(), []);
  const list = Array.isArray(existing) ? [...existing] : [];
  const existingKey = (e) => `${String(e.target_key || "").trim()}|${String(e.vendor_name_pattern || "").trim().toLowerCase()}|${String(e.account_code || "").trim()}`;
  const existingSet = new Set(list.map(existingKey));
  let added = 0;
  for (const e of toAdd) {
    const ek = existingKey(e);
    if (existingSet.has(ek)) continue;
    list.push(e);
    existingSet.add(ek);
    added++;
  }
  if (added) {
    await saveVendorAccountMemory(list);
    if (logger) logger.info("updateVendorMemoryFromFeedback: merged entries.", { added, total: list.length });
  }
}

module.exports = {
  loadFeedbackCorrections,
  appendFeedbackCorrections,
  loadVendorAccountMemory,
  saveVendorAccountMemory,
  updateVendorMemoryFromFeedback
};
