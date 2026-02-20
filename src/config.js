const path = require("path");
const dotenv = require("dotenv");

dotenv.config({ path: path.resolve(process.cwd(), ".env") });

function toInt(value, fallback) {
  const n = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(n) ? n : fallback;
}

function toFloat(value, fallback) {
  const n = Number.parseFloat(String(value ?? ""));
  return Number.isFinite(n) ? n : fallback;
}

function toArrayCsv(value, fallback = []) {
  if (!value) return fallback;
  return String(value)
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
}

const config = {
  server: {
    port: toInt(process.env.PORT, 8080),
    logLevel: process.env.LOG_LEVEL || "info",
    sharedSecret: (process.env.WORKER_SHARED_SECRET || "").trim()
  },
  budget: {
    runBudgetMs: toInt(process.env.RUN_BUDGET_MS, 25 * 60 * 1000),
    reserveMs: toInt(process.env.TIME_RESERVE_MS, 25_000)
  },
  routing: {
    source: process.env.ROUTING_SOURCE || "sheets",
    spreadsheetId: process.env.SHEETS_SPREADSHEET_ID || "",
    routingSheetName: process.env.ROUTING_SHEET_NAME || "ProjectRouting",
    vendorRulesSheetName: process.env.VENDOR_RULES_SHEET_NAME || "VendorRules"
  },
  scan: {
    docsBatchLimit: toInt(process.env.DOCS_BATCH_LIMIT, 50),
    pass1UnrenamedLimit: toInt(process.env.PASS1_UNRENAMED_LIMIT, 50),
    pass2MarkedLimit: toInt(process.env.PASS2_MARKED_LIMIT, 50),
    renamePrefix: process.env.SCAN_UNRENAMED_PREFIX || "BILL",
    processedMarkerPrefix: process.env.PROCESSED_MARKER_PREFIX || "BILL_OCR_PROCESSED|V1|",
    ocrJobMarkerPrefix: process.env.OCR_JOB_MARKER_PREFIX || "BILL_OCR_JOB|V1|",
    pdfOcrMaxPages: toInt(process.env.PDF_OCR_MAX_PAGES, 80),
    ocrMinTextLen: toInt(process.env.OCR_MIN_TEXT_LEN, 40),
    visionLangHints: toArrayCsv(process.env.VISION_LANG_HINTS, ["en", "fil"])
  },
  thresholds: {
    critical: toFloat(process.env.THRESHOLD_CRITICAL, 0.8),
    vendorAutopick: toFloat(process.env.THRESHOLD_VENDOR_AUTOPICK, 0.9)
  },
  gemini: {
    apiKey: process.env.GEMINI_API_KEY || "",
    model: process.env.GEMINI_MODEL || "gemini-2.5-pro"
  },
  odooDefaults: {
    sourceBaseUrl: process.env.SOURCE_BASE_URL || "",
    sourceDb: process.env.SOURCE_DB || "",
    sourceLogin: process.env.SOURCE_LOGIN || "",
    sourcePassword: process.env.SOURCE_PASSWORD || "",
    defaultExpenseAccountId: toInt(process.env.DEFAULT_EXPENSE_ACCOUNT_ID, 0),
    sourceGeneralTaskDbField: process.env.SOURCE_GENERAL_TASK_DB_FIELD || "x_studio_accounting_database",
    routingStageName: process.env.ROUTING_STAGE_NAME || "Master",
    taxTaskNameFilter: process.env.TAX_TASK_NAME_FILTER || "Tax PH"
  },
  gcs: {
    bucket: process.env.GCS_BUCKET || "",
    inputPrefix: process.env.GCS_INPUT_PREFIX || "ap-ocr/input",
    outputPrefix: process.env.GCS_OUTPUT_PREFIX || "ap-ocr/output",
    stateBucket: process.env.STATE_BUCKET || "",
    statePrefix: process.env.STATE_PREFIX || "AP_BILL_STATE_V1"
  }
};

function validateConfig() {
  const missing = [];
  if (!config.gemini.apiKey) missing.push("GEMINI_API_KEY");
  if (!config.gcs.bucket) missing.push("GCS_BUCKET");
  if (config.routing.source === "sheets" && !config.routing.spreadsheetId) {
    missing.push("SHEETS_SPREADSHEET_ID");
  }
  if (missing.length) {
    throw new Error(`Missing required env vars: ${missing.join(", ")}`);
  }
}

module.exports = {
  config,
  validateConfig
};
