const { google } = require("googleapis");
const { normalizeOdooBaseUrl, toNumber } = require("./utils");

function toBoolean(value) {
  const x = String(value || "").trim().toLowerCase();
  return x === "1" || x === "true" || x === "yes" || x === "y";
}

function rowToObject(headers, row) {
  const out = {};
  headers.forEach((h, idx) => {
    out[h] = row[idx] ?? "";
  });
  return out;
}

async function getSheetsClient() {
  const auth = new google.auth.GoogleAuth({
    scopes: ["https://www.googleapis.com/auth/spreadsheets"]
  });
  return google.sheets({ version: "v4", auth });
}

async function readSheetValues(spreadsheetId, range) {
  const sheets = await getSheetsClient();
  const res = await sheets.spreadsheets.values.get({ spreadsheetId, range });
  return res.data.values || [];
}

function toRoutingRowStrict(row) {
  const enabled = toBoolean(row.enabled);
  if (!enabled) return null;
  const targetBaseUrl = normalizeOdooBaseUrl(row.target_base_url);
  const targetDb = String(row.target_db || "").trim();
  const targetLogin = String(row.target_login || "").trim();
  const targetPassword = String(row.target_password || "").trim();
  const targetCompanyId = toNumber(row.target_company_id, 0);
  if (!targetBaseUrl || !targetDb || !targetLogin || !targetPassword || !targetCompanyId) return null;

  return {
    enabled,
    source_project_id: toNumber(row.source_project_id, 0),
    target_base_url: targetBaseUrl,
    target_db: targetDb,
    target_login: targetLogin,
    target_password: targetPassword,
    target_company_id: targetCompanyId,
    ap_folder_id: toNumber(row.ap_folder_id, 0),
    purchase_journal_id: toNumber(row.purchase_journal_id, 0),
    vat_purchase_tax_id_goods: toNumber(row.vat_purchase_tax_id_goods, 0),
    vat_purchase_tax_id_services: toNumber(row.vat_purchase_tax_id_services, 0),
    vat_purchase_tax_id_generic: toNumber(row.vat_purchase_tax_id_generic, 0)
  };
}

async function loadRoutingSheetData(config) {
  const range = `${config.routing.routingSheetName}!A:ZZ`;
  const values = await readSheetValues(config.routing.spreadsheetId, range);
  if (!values.length) return { headers: [], rows: [] };
  const [headerRow, ...dataRows] = values;
  const headers = headerRow.map((h) => String(h || "").trim().toLowerCase());
  const rows = dataRows.map((r) => rowToObject(headers, r));
  return { headers, rows };
}

function indexToColLetter(idx) {
  let result = "";
  let n = idx;
  do {
    result = String.fromCharCode(65 + (n % 26)) + result;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return result;
}

async function saveRoutingSheetData(config, headers, rows) {
  const vatCols = [
    "vat_purchase_tax_id_goods", "vat_purchase_tax_id_services", "vat_purchase_tax_id_generic",
    "purchase_journal_id", "ap_folder_id"
  ];
  const sheets = await getSheetsClient();
  const baseRange = config.routing.routingSheetName;
  for (const col of vatCols) {
    const idx = headers.indexOf(col);
    if (idx < 0) continue;
    const colLetter = indexToColLetter(idx);
    const range = `${baseRange}!${colLetter}1:${colLetter}${rows.length + 1}`;
    const values = [[col], ...rows.map((row) => [row[col] ?? ""])];
    await sheets.spreadsheets.values.update({
      spreadsheetId: config.routing.spreadsheetId,
      range,
      valueInputOption: "RAW",
      requestBody: { values }
    });
  }
}

async function loadRawRoutingRows(config) {
  const { rows } = await loadRoutingSheetData(config);
  return rows;
}

async function loadRoutingRows(config) {
  const raw = await loadRawRoutingRows(config);
  return raw.map(toRoutingRowStrict).filter(Boolean);
}

module.exports = {
  loadRoutingRows,
  loadRawRoutingRows,
  loadRoutingSheetData,
  saveRoutingSheetData,
  toRoutingRowStrict
};
