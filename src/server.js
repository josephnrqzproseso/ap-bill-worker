const express = require("express");
const { config, validateConfig } = require("./config");
const { createLogger } = require("./logger");
const { runWorker, runOne } = require("./worker");

const logger = createLogger(config.server.logLevel);
const app = express();
app.use(express.json({ limit: "1mb" }));

let isRunning = false;

function isAuthorized(req) {
  if (!config.server.sharedSecret) return true;
  const token = req.header("x-worker-secret") || "";
  return token && token === config.server.sharedSecret;
}

app.get("/healthz", (_req, res) => {
  res.status(200).json({ ok: true, service: "ap-bill-ocr-worker" });
});

app.get("/health", (_req, res) => {
  res.status(200).json({ ok: true, service: "ap-bill-ocr-worker" });
});

app.get("/", (_req, res) => {
  res.status(200).json({ ok: true, service: "ap-bill-ocr-worker", routes: ["/health", "/healthz", "/run", "/run-one", "/debug"] });
});

app.post("/debug", async (req, res) => {
  if (!isAuthorized(req)) return res.status(401).json({ ok: false, error: "unauthorized" });
  const { OdooClient, kwWithCompany } = require("./odoo");
  const { loadRoutingRows } = require("./sheets");
  try {
    const rows = await loadRoutingRows(config);
    if (!rows.length) return res.json({ ok: false, error: "no routing rows" });
    const row = rows[0];
    const odoo = new OdooClient({
      baseUrl: row.target_base_url,
      db: row.target_db,
      login: row.target_login,
      password: row.target_password
    });
    const companyId = row.target_company_id;
    const results = {};

    results.auth = { uid: await odoo.authenticate() };

    const partners = await odoo.searchRead("res.partner", [], ["id", "name"],
      kwWithCompany(companyId, { limit: 1 }));
    results.res_partner = { count: partners.length, sample: partners[0]?.name || null };

    try {
      const modules = await odoo.searchRead("ir.module.module",
        [["name", "=", "documents"], ["state", "=", "installed"]],
        ["id", "name", "state", "shortdesc"],
        { limit: 5 });
      results.documents_module = modules;
    } catch (e) { results.documents_module_error = e.message; }

    try {
      const folders = await odoo.searchRead("documents.folder", [], ["id", "name"],
        kwWithCompany(companyId, { limit: 5 }));
      results.documents_folder = folders;
    } catch (e) { results.documents_folder_error = e.message; }

    try {
      const docs = await odoo.searchRead("documents.document", [], ["id", "name"],
        kwWithCompany(companyId, { limit: 1 }));
      results.documents_document = { count: docs.length };
    } catch (e) { results.documents_document_error = e.message; }

    try {
      const fields = await odoo.executeKw("documents.document", "fields_get", [], { attributes: ["string", "type", "relation"] });
      const folderFields = {};
      for (const [k, v] of Object.entries(fields)) {
        if (k.includes("folder") || k.includes("workspace") || k.includes("tag") || k.includes("facet") || k.includes("categ") || v.relation) {
          folderFields[k] = { string: v.string, type: v.type, relation: v.relation || null };
        }
      }
      results.document_fields = folderFields;
    } catch (e) { results.document_fields_error = e.message; }

    for (const model of ["documents.facet", "documents.tag", "documents.workspace", "documents.share"]) {
      try {
        const rows2 = await odoo.searchRead(model, [], ["id", "name"], kwWithCompany(companyId, { limit: 5 }));
        results[model.replace(/\./g, "_")] = rows2;
      } catch (e) { results[model.replace(/\./g, "_") + "_error"] = e.message; }
    }

    return res.json({ ok: true, target: row.target_base_url, db: row.target_db, companyId, results });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err?.message || String(err) });
  }
});

app.post("/run", async (req, res) => {
  if (!isAuthorized(req)) return res.status(401).json({ ok: false, error: "unauthorized" });
  if (isRunning) return res.status(409).json({ ok: false, error: "already_running" });
  isRunning = true;
  try {
    logger.info("Worker run started.", { trigger: "http_post" });
    const result = await runWorker({ logger, payload: req.body || {} });
    logger.info("Worker run finished.", { elapsedMs: result.elapsedMs, totals: result.totals });
    return res.status(200).json(result);
  } catch (err) {
    logger.error("Worker run failed.", { error: err?.message || String(err) });
    return res.status(500).json({ ok: false, error: err?.message || String(err) });
  } finally {
    isRunning = false;
  }
});

app.get("/run", async (req, res) => {
  if (!isAuthorized(req)) return res.status(401).json({ ok: false, error: "unauthorized" });
  if (isRunning) return res.status(409).json({ ok: false, error: "already_running" });
  isRunning = true;
  try {
    logger.info("Worker run started.", { trigger: "http_get" });
    const result = await runWorker({ logger });
    logger.info("Worker run finished.", { elapsedMs: result.elapsedMs, totals: result.totals });
    return res.status(200).json(result);
  } catch (err) {
    logger.error("Worker run failed.", { error: err?.message || String(err) });
    return res.status(500).json({ ok: false, error: err?.message || String(err) });
  } finally {
    isRunning = false;
  }
});

app.post("/run-one", async (req, res) => {
  if (!isAuthorized(req)) return res.status(401).json({ ok: false, error: "unauthorized" });
  if (isRunning) return res.status(409).json({ ok: false, error: "already_running" });
  isRunning = true;
  try {
    logger.info("Worker run-one started.", { trigger: "http_post", payload: req.body || {} });
    const result = await runOne({ logger, payload: req.body || {} });
    logger.info("Worker run-one finished.", { targetKey: result.targetKey, docId: result.doc?.id, status: result.result?.status });
    return res.status(200).json(result);
  } catch (err) {
    logger.error("Worker run-one failed.", { error: err?.message || String(err) });
    return res.status(500).json({ ok: false, error: err?.message || String(err) });
  } finally {
    isRunning = false;
  }
});

function start() {
  validateConfig();
  app.listen(config.server.port, () => {
    logger.info("Server started.", { port: config.server.port });
  });
}

start();
