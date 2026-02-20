// @ts-nocheck
const { config } = require("./config");
const { OdooClient, kwWithCompany } = require("./odoo");
const {
  loadRoutingSheetData,
  saveRoutingSheetData,
  toRoutingRowStrict,
  loadAccountMapping
} = require("./sheets");
const { ocrTextForAttachment } = require("./vision");
const { extractInvoiceWithGemini, assignAccountsWithGemini } = require("./gemini");
const { m2oId, normalizeOdooBaseUrl, deriveDbFromBaseUrl, isFalsyOdooValue, sleep } = require("./utils");
const { loadState, saveState } = require("./state");
const {
  makeProcessedMarker,
  isProcessed,
  getProcessedBillId,
  makeOcrJobMarker,
  appendMarker,
  parseOcrJobMarker
} = require("./markers");

function outOfTime(startMs) {
  return Date.now() - startMs > config.budget.runBudgetMs - config.budget.reserveMs;
}

function parseAcctDb(raw) {
  if (isFalsyOdooValue(raw)) return { target_base_url: "", target_db: "" };
  const s = String(raw).trim();
  if (!s) return { target_base_url: "", target_db: "" };
  if (s.startsWith("{") && s.endsWith("}")) {
    try {
      const o = JSON.parse(s);
      const bu = normalizeOdooBaseUrl(o.baseUrl || o.target_base_url || "");
      const db = bu ? deriveDbFromBaseUrl(bu) : String(o.db || o.target_db || "").trim();
      const bu2 = bu || normalizeOdooBaseUrl(db);
      return { target_base_url: bu2, target_db: deriveDbFromBaseUrl(bu2) || db };
    } catch (_) {
      return { target_base_url: "", target_db: "" };
    }
  }
  if (/^https?:\/\//i.test(s)) {
    const bu = normalizeOdooBaseUrl(s);
    return { target_base_url: bu, target_db: deriveDbFromBaseUrl(bu) };
  }
  const bu = normalizeOdooBaseUrl(s);
  return { target_base_url: bu, target_db: deriveDbFromBaseUrl(bu) };
}

async function getSourceOdooTargetMap(logger, rows = []) {
  const src = config.odooDefaults;
  if (!src.sourceBaseUrl || !src.sourceDb || !src.sourceLogin || !src.sourcePassword) {
    return null;
  }
  const projectIds = [
    ...new Set(
      rows
        .map((r) => Number(r.source_project_id || 0))
        .filter((n) => Number.isFinite(n) && n > 0)
    )
  ];
  if (!projectIds.length) return new Map();
  try {
    const odoo = new OdooClient({
      baseUrl: src.sourceBaseUrl,
      db: src.sourceDb,
      login: src.sourceLogin,
      password: src.sourcePassword
    });
    const generalStageName = src.sourceGeneralTaskStageName || "General";
    const industryField = config.odooDefaults.sourceGeneralTaskIndustryField || "x_studio_industry";
    const generalTaskDomain = [
      ["project_id", "in", projectIds],
      ["name", "=", "General"],
      ["stage_id.name", "=", generalStageName]
    ];
    let generalTasks = [];
    try {
      generalTasks =
        (await odoo.searchRead(
          "project.task",
          generalTaskDomain,
          ["id", "project_id", config.odooDefaults.sourceGeneralTaskDbField, industryField],
          { limit: projectIds.length * 5 }
        )) || [];
    } catch (fieldErr) {
      if (String(fieldErr?.message || fieldErr).includes("Invalid field")) {
        generalTasks =
          (await odoo.searchRead(
            "project.task",
            generalTaskDomain,
            ["id", "project_id", config.odooDefaults.sourceGeneralTaskDbField],
            { limit: projectIds.length * 5 }
          )) || [];
      } else throw fieldErr;
    }
    const rawDbByProject = new Map();
    const rawIndustryByProject = new Map();
    for (const t of generalTasks) {
      const pid = Array.isArray(t.project_id) ? Number(t.project_id[0]) : null;
      if (!pid) continue;
      if (!rawDbByProject.has(pid)) {
        rawDbByProject.set(pid, t[config.odooDefaults.sourceGeneralTaskDbField]);
      }
      if (industryField in t) {
        const iv = t[industryField];
        const industry = iv ? (Array.isArray(iv) ? String(iv[1] || iv[0] || "").trim() : String(iv || "").trim()) : "";
        if (industry && !rawIndustryByProject.has(pid)) rawIndustryByProject.set(pid, industry);
      }
    }
    const map = new Map();
    for (const pid of projectIds) {
      const parsed = parseAcctDb(rawDbByProject.get(pid));
      const industry = rawIndustryByProject.get(pid) || "";
      if (parsed.target_base_url || industry) {
        map.set(pid, { ...parsed, industry });
      }
    }
    logger.info("Refreshed target_base_url/target_db/industry from SOURCE General task.", { projects: map.size, projectIds });
    return map;
  } catch (err) {
    logger.warn("Source Odoo refresh failed (continuing with sheet values).", { error: err?.message || String(err) });
    return null;
  }
}

function isEnabledRow(row) {
  const x = String(row.enabled || "").trim().toLowerCase();
  return x === "true" || x === "1" || x === "yes" || x === "y";
}

function ensureAutoColumns(headers, rows) {
  const wanted = [
    "vat_purchase_tax_id_goods",
    "vat_purchase_tax_id_services",
    "vat_purchase_tax_id_generic",
    "purchase_journal_id",
    "ap_folder_id",
    "industry"
  ];
  let changed = false;
  for (const c of wanted) {
    if (!headers.includes(c)) {
      headers.push(c);
      changed = true;
    }
  }
  if (changed) {
    for (const r of rows) {
      for (const c of wanted) {
        if (r[c] == null) r[c] = "";
      }
    }
  }
  return changed;
}

function groupRowsByTarget(rows) {
  const groups = new Map();
  for (const row of rows) {
    if (!isEnabledRow(row)) continue;
    const baseUrl = normalizeOdooBaseUrl(row.target_base_url);
    const db = String(row.target_db || "").trim() || deriveDbFromBaseUrl(baseUrl);
    const login = String(row.target_login || "").trim();
    const password = String(row.target_password || "").trim();
    const companyId = Number(String(row.target_company_id || "").trim() || 0);
    if (!baseUrl || !db || !login || !password || !companyId) continue;
    const key = [baseUrl, db, login.toLowerCase(), String(companyId)].join("|");
    if (!groups.has(key)) {
      groups.set(key, {
        cfg: { baseUrl, db, login, password },
        companyId,
        rows: []
      });
    }
    groups.get(key).rows.push(row);
  }
  return groups;
}

function pickTopTaxByScore(arr, scorer) {
  let best = null;
  let bestScore = -1e9;
  for (const t of arr) {
    const s = scorer(t);
    if (s > bestScore) {
      best = t;
      bestScore = s;
    }
  }
  return best;
}

async function pickVatTaxesForCompany(odoo, companyId) {
  const taxes =
    (await odoo.searchRead(
      "account.tax",
      [
        ["company_id", "=", companyId],
        ["active", "=", true],
        ["type_tax_use", "in", ["purchase", "none"]]
      ],
      ["id", "name", "amount", "amount_type", "type_tax_use", "price_include", "description", "tax_group_id"],
      kwWithCompany(companyId, { limit: 2000, order: "name asc" })
    )) || [];

  const norm = (s) => String(s || "").toLowerCase();
  const has = (t, re) => re.test(`${norm(t.name)} ${norm(t.description)} ${Array.isArray(t.tax_group_id) ? norm(t.tax_group_id[1]) : ""}`);
  const isWithholding = (t) => has(t, /fwvat|ewvat|withhold|withholding|wht|designated|ds\b/);
  const isImport = (t) => has(t, /\bimport\b|\bimportation\b|\b12%\s*i\b/);
  const isNcr = (t) => has(t, /\bncr\b|non[-\s]?credit/);

  const vat12 = taxes.filter((t) => {
    const amount = Number(t.amount || 0);
    return (
      t.amount_type === "percent" &&
      Math.abs(amount - 12) < 0.0001 &&
      !isWithholding(t) &&
      !isImport(t) &&
      !isNcr(t)
    );
  });

  if (!vat12.length) {
    return { goodsId: null, servicesId: null, genericId: null };
  }

  const isCapitalGoods = (t) => has(t, /capital\s*goods|capital\s*asset|\bcapital\b.*\bgoods\b|\b12%\s*c\b|\b12%c\b/);
  const serviceLike = (t) => has(t, /service|consult|professional|repair|rent|labor|contract|freight/) && !isCapitalGoods(t);
  const goodsLike = (t) => has(t, /goods|supply|material|inventory|product|merch/) && !isCapitalGoods(t);

  const generic = pickTopTaxByScore(vat12, (t) => {
    let score = 0;
    if (isCapitalGoods(t)) return -100;
    if (norm(t.type_tax_use) === "purchase") score += 5;
    if (!t.price_include) score += 2;
    if (serviceLike(t) || goodsLike(t)) score += 1;
    return score;
  });
  const services = pickTopTaxByScore(vat12, (t) => {
    let score = 0;
    if (isCapitalGoods(t)) return -100;
    if (serviceLike(t)) score += 10;
    if (!goodsLike(t)) score += 2;
    if (!t.price_include) score += 1;
    return score;
  });
  const goods = pickTopTaxByScore(vat12, (t) => {
    let score = 0;
    if (isCapitalGoods(t)) return -100;
    if (goodsLike(t)) score += 10;
    if (!serviceLike(t)) score += 2;
    if (!t.price_include) score += 1;
    return score;
  });

  return {
    goodsId: Number(goods?.id || generic?.id || 0) || null,
    servicesId: Number(services?.id || generic?.id || 0) || null,
    genericId: Number(generic?.id || 0) || null
  };
}

async function resolveIndustry(odoo, companyId) {
  const fieldSets = [
    ["x_studio_industry"],
    ["industry_id"],
    ["partner_id"]
  ];
  for (const fields of fieldSets) {
    try {
      const companies = await odoo.searchRead(
        "res.company",
        [["id", "=", companyId]],
        ["id", ...fields],
        { limit: 1 }
      );
      const co = companies?.[0];
      if (!co) continue;

      if (fields.includes("x_studio_industry")) {
        const val = co.x_studio_industry;
        if (val) {
          const industry = Array.isArray(val) ? String(val[1] || val[0] || "") : String(val || "");
          if (industry.trim()) return industry.trim();
        }
      }
      if (fields.includes("industry_id")) {
        const val = co.industry_id;
        if (val) {
          const industry = Array.isArray(val) ? String(val[1] || val[0] || "") : String(val || "");
          if (industry.trim()) return industry.trim();
        }
      }
      if (fields.includes("partner_id")) {
        const partnerId = Array.isArray(co.partner_id) ? co.partner_id[0] : Number(co.partner_id || 0);
        if (partnerId) {
          try {
            const partners = await odoo.searchRead(
              "res.partner",
              [["id", "=", partnerId]],
              ["id", "industry_id"],
              { limit: 1 }
            );
            const pVal = partners?.[0]?.industry_id;
            if (pVal) {
              const industry = Array.isArray(pVal) ? String(pVal[1] || pVal[0] || "") : String(pVal || "");
              if (industry.trim()) return industry.trim();
            }
          } catch (_) {}
        }
      }
    } catch (_) {}
  }
  return "";
}

async function resolvePurchaseJournalId(odoo, companyId) {
  const journals = await odoo.searchRead(
    "account.journal",
    [["type", "=", "purchase"], ["company_id", "=", companyId]],
    ["id", "name", "code"],
    kwWithCompany(companyId, { limit: 20, order: "id asc" })
  );
  if (!journals.length) return 0;

  const billJournal = journals.find((j) => {
    const name = String(j.name || "").toLowerCase();
    const code = String(j.code || "").toLowerCase();
    return (
      name.includes("vendor bill") ||
      name.includes("vendor invoice") ||
      name.includes("bills") ||
      code === "bill" ||
      code === "vb"
    );
  });
  if (billJournal) return Number(billJournal.id);

  const notReceipt = journals.find((j) => {
    const name = String(j.name || "").toLowerCase();
    return !name.includes("receipt");
  });
  return Number((notReceipt || journals[0]).id);
}

async function refreshRoutingAutoFields(headers, rows, logger, sourceMap = null) {
  ensureAutoColumns(headers, rows);
  const groups = groupRowsByTarget(rows);
  let updated = 0;
  for (const [key, g] of groups.entries()) {
    try {
      const odoo = new OdooClient(g.cfg);
      const pick = await pickVatTaxesForCompany(odoo, g.companyId);

      let journalId = 0;
      try { journalId = await resolvePurchaseJournalId(odoo, g.companyId); } catch (_) {}

      let apFolderId = 0;
      try { apFolderId = await resolveApFolderId(odoo, g.companyId); } catch (_) {}

      let targetIndustryVal = "";
      try {
        targetIndustryVal = await resolveIndustry(odoo, g.companyId);
        logger.info("Industry resolved from TARGET.", { companyId: g.companyId, industry: targetIndustryVal || "(empty)" });
      } catch (err) {
        logger.warn("Industry resolve from TARGET failed.", { companyId: g.companyId, error: err?.message || String(err) });
      }

      for (const row of g.rows) {
        const pid = Number(row.source_project_id || 0);
        const generalTaskIndustry = sourceMap?.get(pid)?.industry;
        const industryVal = generalTaskIndustry || targetIndustryVal;
        if (generalTaskIndustry) {
          logger.info("Industry from General task.", { projectId: pid, industry: generalTaskIndustry });
        }
        const before = [
          String(row.vat_purchase_tax_id_goods || "").trim(),
          String(row.vat_purchase_tax_id_services || "").trim(),
          String(row.vat_purchase_tax_id_generic || "").trim(),
          String(row.purchase_journal_id || "").trim(),
          String(row.ap_folder_id || "").trim(),
          String(row.industry || "").trim()
        ].join("|");

        row.vat_purchase_tax_id_goods = pick.goodsId ? String(pick.goodsId) : "";
        row.vat_purchase_tax_id_services = pick.servicesId ? String(pick.servicesId) : "";
        row.vat_purchase_tax_id_generic = pick.genericId ? String(pick.genericId) : "";
        if (journalId) row.purchase_journal_id = String(journalId);
        if (apFolderId) row.ap_folder_id = String(apFolderId);
        if (industryVal) row.industry = industryVal;

        const after = [
          String(row.vat_purchase_tax_id_goods || "").trim(),
          String(row.vat_purchase_tax_id_services || "").trim(),
          String(row.vat_purchase_tax_id_generic || "").trim(),
          String(row.purchase_journal_id || "").trim(),
          String(row.ap_folder_id || "").trim(),
          String(row.industry || "").trim()
        ].join("|");
        if (after !== before) updated += 1;
      }
    } catch (err) {
      logger.warn("Auto-field refresh failed for routing group.", { key, error: err?.message || String(err) });
    }
  }
  return { updated, groupCount: groups.size };
}

async function getRoutingRows(logger) {
  const { headers, rows } = await loadRoutingSheetData(config);
    const sourceMap = await getSourceOdooTargetMap(logger, rows);
  if (sourceMap && sourceMap.size > 0) {
    for (const row of rows) {
      const pid = Number(row.source_project_id || 0);
      if (pid && sourceMap.has(pid)) {
        const r = sourceMap.get(pid);
        if (!normalizeOdooBaseUrl(row.target_base_url)) row.target_base_url = r.target_base_url || row.target_base_url;
        if (!String(row.target_db || "").trim()) row.target_db = r.target_db || row.target_db;
        if (r.industry && !String(row.industry || "").trim()) row.industry = r.industry;
      }
    }
  }

  const refreshRes = await refreshRoutingAutoFields(headers, rows, logger, sourceMap);
  await saveRoutingSheetData(config, headers, rows);
  logger.info("Refreshed auto-fields into ProjectRouting.", refreshRes);

  return rows.map(toRoutingRowStrict).filter(Boolean);
}

function buildTargetKey(row) {
  return [
    normalizeOdooBaseUrl(row.target_base_url),
    row.target_db,
    String(row.target_login).toLowerCase(),
    String(row.target_company_id)
  ].join("|");
}

function groupRoutingRows(rows) {
  const groups = new Map();
  for (const row of rows) {
    const key = buildTargetKey(row);
    if (!groups.has(key)) {
      groups.set(key, {
        targetKey: key,
        targetCfg: {
          baseUrl: row.target_base_url,
          db: row.target_db,
          login: row.target_login,
          password: row.target_password
        },
        companyId: row.target_company_id,
        apFolderId: row.ap_folder_id || 0,
        purchaseJournalId: row.purchase_journal_id || 0,
        vatIds: {
          goods: row.vat_purchase_tax_id_goods || 0,
          services: row.vat_purchase_tax_id_services || 0,
          generic: row.vat_purchase_tax_id_generic || 0
        },
        industry: String(row.industry || "").trim()
      });
    }
  }
  return [...groups.values()];
}

async function resolveApFolderId(odoo, companyId) {
  const names = ["Accounts Payable", "Account Payables", "AP", "Vendor Bills"];

  // Odoo 17+: folders are documents.document records with is_folder=true
  for (const name of names) {
    const folders = await odoo.searchRead(
      "documents.document",
      [["is_folder", "=", true], ["name", "=", name]],
      ["id", "name", "company_id"],
      kwWithCompany(companyId, { limit: 1 })
    );
    if (folders?.[0]?.id) return Number(folders[0].id);
  }

  // Fallback: try legacy documents.folder model (Odoo 16 and earlier)
  try {
    for (const name of names) {
      const docs = await odoo.searchRead(
        "documents.folder",
        [["name", "=", name]],
        ["id", "name", "company_id"],
        kwWithCompany(companyId, { limit: 1 })
      );
      if (docs?.[0]?.id) return Number(docs[0].id);
    }
  } catch (_err) {
    // documents.folder doesn't exist in this Odoo version
  }

  throw new Error("Could not resolve AP folder id from default candidates.");
}

async function listCandidateDocuments(odoo, companyId, apFolderId) {
  const baseFields = ["id", "name", "attachment_id", "folder_id", "company_id", "create_date"];

  const pass1Domain = [
    ["folder_id", "=", apFolderId],
    ["is_folder", "=", false],
    ["attachment_id", "!=", false],
    ["name", "not ilike", `${config.scan.renamePrefix}%`]
  ];
  const pass1 = await odoo.searchRead(
    "documents.document",
    pass1Domain,
    baseFields,
    kwWithCompany(companyId, {
      limit: config.scan.pass1UnrenamedLimit || config.scan.docsBatchLimit,
      order: "id asc"
    })
  );

  const pass2Domain = [
    ["folder_id", "=", apFolderId],
    ["is_folder", "=", false],
    ["attachment_id", "!=", false],
    ["name", "ilike", `${config.scan.renamePrefix}%`]
  ];
  const pass2 = await odoo.searchRead(
    "documents.document",
    pass2Domain,
    baseFields,
    kwWithCompany(companyId, {
      limit: config.scan.pass2MarkedLimit,
      order: "id desc"
    })
  );

  const seen = new Set();
  const merged = [];
  for (const d of [...pass1, ...pass2]) {
    if (seen.has(d.id)) continue;
    seen.add(d.id);
    merged.push(d);
  }
  return merged;
}

async function loadAttachment(odoo, companyId, attachmentId) {
  const rows = await odoo.searchRead(
    "ir.attachment",
    [["id", "=", attachmentId]],
    ["id", "name", "datas", "mimetype", "description", "res_model", "res_id"],
    kwWithCompany(companyId, { limit: 1 })
  );
  return rows?.[0] || null;
}

function looksLikeAtpPrinterVendor(name, ocrText) {
  const n = String(name || "").toLowerCase();
  if (!n) return false;
  const badTokens = [
    "printer",
    "printing",
    "press",
    "graphic",
    "publishing",
    "accreditation",
    "permit",
    "atp",
    "bir",
    "authority"
  ];
  if (badTokens.some((t) => n.includes(t))) return true;
  const text = String(ocrText || "").toLowerCase();
  const anchor = n.slice(0, Math.min(12, n.length));
  const idx = text.indexOf(anchor);
  if (idx >= 0) {
    const win = text.slice(Math.max(0, idx - 180), Math.min(text.length, idx + 180));
    const hints = ["atp", "bir permit", "printer", "accreditation", "date issued", "permit no"];
    if (hints.some((k) => win.includes(k))) return true;
  }
  return false;
}

function chooseBestNonAtpVendor(vendorCandidates, ocrText) {
  const arr = Array.isArray(vendorCandidates) ? vendorCandidates : [];
  const filtered = arr
    .filter((v) => v && v.name)
    .filter((v) => String(v.source || "") !== "atp_printer_box")
    .filter((v) => !looksLikeAtpPrinterVendor(v.name, ocrText))
    .sort((a, b) => (Number(b.confidence || 0) - Number(a.confidence || 0)));
  return filtered[0] || null;
}

function pickVendorFromExtraction(extracted, ocrText) {
  const v = extracted?.vendor || {};
  const primaryName = String(v.name || "").trim();
  const primaryBad = String(v.source || "") === "atp_printer_box" || looksLikeAtpPrinterVendor(primaryName, ocrText);
  if (primaryName && !primaryBad) return { name: primaryName, confidence: Number(v.confidence || 0), source: v.source || "unknown" };
  const alt = chooseBestNonAtpVendor(extracted?.vendor_candidates, ocrText);
  if (alt) return { name: String(alt.name || "").trim(), confidence: Number(alt.confidence || 0), source: alt.source || "unknown" };
  return { name: "", confidence: 0, source: "unknown" };
}

async function safeMessagePost(odoo, companyId, model, resId, body) {
  try {
    await odoo.executeKw(
      model,
      "message_post",
      [[Number(resId)]],
      kwWithCompany(companyId, {
        body: String(body || ""),
        message_type: "comment",
        subtype_xmlid: "mail.mt_note",
        body_is_html: true
      })
    );
  } catch (_err) {
    // best effort
  }
}

async function findVendor(odoo, companyId, extracted, ocrText) {
  const picked = pickVendorFromExtraction(extracted, ocrText);
  const vendorName = String(picked.name || "").trim();
  if (!vendorName) return { id: 0, name: "", confidence: 0, source: picked.source };

  const details = extracted?.vendor_details || {};
  const tradeName = String(details.trade_name || "").trim();
  const proprietorName = String(details.proprietor_name || "").trim();
  const searchNames = [vendorName];
  if (tradeName && tradeName.toLowerCase() !== vendorName.toLowerCase()) searchNames.push(tradeName);
  if (proprietorName && proprietorName.toLowerCase() !== vendorName.toLowerCase()) searchNames.push(proprietorName);

  for (const name of searchNames) {
    const vendors = await odoo.searchRead(
      "res.partner",
      [["name", "ilike", name], ["supplier_rank", ">", 0]],
      ["id", "name"],
      kwWithCompany(companyId, { limit: 5, order: "supplier_rank desc,id asc" })
    );
    if (vendors?.length) {
      return {
        id: Number(vendors[0].id),
        name: String(vendors[0].name),
        confidence: Number(picked.confidence || 0),
        source: picked.source,
        entityType: String(details.entity_type || "unknown"),
        tradeName,
        proprietorName
      };
    }
  }

  return {
    id: 0, name: vendorName, confidence: Number(picked.confidence || 0),
    source: picked.source, entityType: String(details.entity_type || "unknown"),
    tradeName, proprietorName
  };
}

async function createVendorIfMissing(odoo, companyId, extracted, ocrText) {
  const picked = pickVendorFromExtraction(extracted, ocrText);
  const rawName = String(picked.name || "").trim();
  const conf = Number(picked.confidence || 0);
  if (!rawName) return { status: "missing", partnerId: 0, created: false };
  if (looksLikeAtpPrinterVendor(rawName, ocrText) || String(picked.source || "") === "atp_printer_box") {
    return { status: "blocked_printer", partnerId: 0, created: false };
  }
  const AUTOCREATE_VENDOR_MIN = 0.9;
  if (conf < AUTOCREATE_VENDOR_MIN) {
    return { status: "needs_confirmation", partnerId: 0, created: false, confidence: conf, name: rawName };
  }

  const details = extracted?.vendor_details || {};
  const entityType = String(details.entity_type || "unknown").toLowerCase();
  const isSoleProp = entityType === "sole_proprietor" || entityType === "individual";
  const tradeName = String(details.trade_name || "").trim();
  const proprietorName = String(details.proprietor_name || "").trim();

  const name = isSoleProp && proprietorName ? proprietorName : rawName;

  const searchNames = [name];
  if (rawName.toLowerCase() !== name.toLowerCase()) searchNames.push(rawName);
  if (tradeName && tradeName.toLowerCase() !== name.toLowerCase()) searchNames.push(tradeName);

  for (const sn of searchNames) {
    const existing = await odoo.searchRead(
      "res.partner",
      [["name", "ilike", sn], ["supplier_rank", ">", 0]],
      ["id", "name"],
      kwWithCompany(companyId, { limit: 1 })
    );
    if (existing?.length) {
      return { status: "matched", partnerId: Number(existing[0].id), created: false, name: existing[0].name };
    }
  }

  const vals = {
    name,
    supplier_rank: 1
  };
  if (String(details.address || "").trim()) vals.street = String(details.address).trim().slice(0, 255);
  if (String(details.tin || "").trim()) vals.vat = String(details.tin).trim();
  const notes = [];
  if (isSoleProp && tradeName) notes.push(`Trade name: ${tradeName}`);
  if (isSoleProp && proprietorName && proprietorName.toLowerCase() !== name.toLowerCase()) {
    notes.push(`Proprietor: ${proprietorName}`);
  }
  if (tradeName && !isSoleProp && tradeName.toLowerCase() !== name.toLowerCase()) {
    notes.push(`DBA: ${tradeName}`);
  }
  if (notes.length) vals.comment = notes.join("\n");
  let newId;
  try {
    vals.company_type = isSoleProp ? "person" : "company";
    newId = await odoo.create("res.partner", vals);
  } catch (e) {
    if (String(e?.message || "").includes("company_type")) {
      delete vals.company_type;
      if (isSoleProp) vals.is_company = false;
      else vals.is_company = true;
      try {
        newId = await odoo.create("res.partner", vals);
      } catch (_) {
        delete vals.is_company;
        newId = await odoo.create("res.partner", vals);
      }
    } else {
      throw e;
    }
  }
  return {
    status: "created", partnerId: Number(newId), created: true, name,
    entityType, tradeName, proprietorName
  };
}

function pickTaxIds(vatIds, extracted) {
  const classification = String(extracted?.vat?.classification || "").toLowerCase();
  const lineItems = extracted?.line_items || [];
  const anyLineVatable = lineItems.some(
    (li) => String(li.vat_code || "").toLowerCase() === "vatable"
  );

  if (
    !anyLineVatable &&
    (classification === "exempt" || classification === "zero_rated" || classification === "unknown")
  ) {
    return [];
  }
  const gs = String(extracted?.vat?.goods_or_services || "").toLowerCase();
  if (gs === "services" && Number(vatIds.services)) return [Number(vatIds.services)];
  if (gs === "goods" && Number(vatIds.goods)) return [Number(vatIds.goods)];
  const generic = Number(vatIds.generic) || 0;
  return generic ? [generic] : [];
}

async function getTaxMeta(odoo, companyId, taxIds) {
  if (!taxIds.length) return null;
  const rows = await odoo.searchRead(
    "account.tax",
    [["id", "in", taxIds]],
    ["id", "amount", "price_include"],
    kwWithCompany(companyId, { limit: 10 })
  );
  if (!rows.length) return null;
  const tax = rows[0];
  return {
    priceInclude: !!tax.price_include,
    amount: Number(tax.amount || 0)
  };
}

async function findDuplicateBill(odoo, companyId, vendorId, extracted) {
  const invoiceNumber = String(extracted?.invoice?.number || "").trim();
  const amountTotal = Number(extracted?.totals?.grand_total || 0);
  const domain = [["move_type", "=", "in_invoice"]];
  if (vendorId) domain.push(["partner_id", "=", vendorId]);
  if (invoiceNumber) domain.push(["ref", "=", invoiceNumber]);
  const rows = await odoo.searchRead(
    "account.move",
    domain,
    ["id", "ref", "amount_total", "state"],
    kwWithCompany(companyId, { limit: 20, order: "id desc" })
  );
  return (
    rows.find((r) => {
      const dbAmount = Number(r.amount_total || 0);
      const delta = Math.abs(dbAmount - amountTotal);
      return delta <= 0.02;
    }) || null
  );
}

async function resolveCurrencyId(odoo, companyId, currencyCode) {
  if (!currencyCode) return null;
  const code = currencyCode.toUpperCase().trim();
  if (!code || code === "PHP") return null;
  const rows = await odoo.searchRead(
    "res.currency",
    [["name", "=", code], ["active", "=", true]],
    ["id"],
    kwWithCompany(companyId, { limit: 1 })
  );
  return rows?.[0]?.id ? Number(rows[0].id) : null;
}

// --- Expense Account Resolution ---

const expenseAccountsCache = new Map();

async function loadExpenseAccounts(odoo, companyId) {
  const key = `${companyId}`;
  if (expenseAccountsCache.has(key)) return expenseAccountsCache.get(key);

  let accounts = [];
  const errors = [];

  const attempts = [
    {
      label: "expense_types",
      domain: [["account_type", "in", ["expense", "expense_direct_cost", "expense_depreciation", "asset_current"]]]
    },
    {
      label: "expense_basic",
      domain: [["account_type", "in", ["expense", "expense_direct_cost"]]]
    },
    {
      label: "code_5_or_6",
      domain: ["|", ["code", "like", "5"], ["code", "like", "6"]]
    },
    {
      label: "all_accounts",
      domain: []
    }
  ];

  for (const attempt of attempts) {
    if (accounts.length) break;
    try {
      accounts = await odoo.searchRead(
        "account.account",
        attempt.domain,
        ["id", "code", "name"],
        kwWithCompany(companyId, { limit: 1000, order: "code asc" })
      );
      if (accounts.length) {
        errors.push(`OK: ${attempt.label} returned ${accounts.length} accounts`);
      }
    } catch (err) {
      errors.push(`FAIL: ${attempt.label}: ${String(err?.message || err).slice(0, 120)}`);
    }
  }

  if (!accounts.length) {
    errors.push("ALL QUERIES FAILED - 0 accounts loaded");
  }

  const result = accounts.map((a) => ({
    id: Number(a.id),
    code: String(a.code || ""),
    name: String(a.name || "")
  }));
  result._loadLog = errors;
  expenseAccountsCache.set(key, result);
  return result;
}

const vendorAccountCache = new Map();

async function getVendorDefaultAccountId(odoo, companyId, vendorId) {
  if (!vendorId) return 0;
  const key = `${companyId}:${vendorId}`;
  if (vendorAccountCache.has(key)) return vendorAccountCache.get(key);

  let accountId = 0;
  try {
    const rows = await odoo.searchRead(
      "res.partner",
      [["id", "=", vendorId]],
      ["id", "property_account_expense_id"],
      kwWithCompany(companyId, { limit: 1 })
    );
    const raw = rows?.[0]?.property_account_expense_id;
    accountId = raw ? (Array.isArray(raw) ? Number(raw[0]) : Number(raw)) : 0;
  } catch (_) {}
  vendorAccountCache.set(key, accountId);
  return accountId;
}

let accountMappingCache = null;

async function getAccountMapping() {
  if (accountMappingCache !== null) return accountMappingCache;
  try {
    accountMappingCache = await loadAccountMapping(config);
  } catch (_) {
    accountMappingCache = [];
  }
  return accountMappingCache;
}

function lookupAccountMapping(mapping, companyId, category, targetDb) {
  const cat = String(category || "").trim().toLowerCase();
  if (!cat) return 0;
  const db = String(targetDb || "").trim().toLowerCase();

  // Exact match: target_db + company_id + category
  let match = mapping.find((m) =>
    m.category === cat &&
    m.companyId === companyId &&
    m.targetDb && m.targetDb === db
  );
  if (match) return match.accountId;

  // Fallback: company_id + category (no target_db or blank target_db)
  match = mapping.find((m) =>
    m.category === cat &&
    m.companyId === companyId &&
    !m.targetDb
  );
  if (match) return match.accountId;

  // Fallback: category only (global default row with no company_id and no target_db)
  match = mapping.find((m) => m.category === cat && !m.companyId && !m.targetDb);
  return match ? match.accountId : 0;
}

const GENERIC_ACCOUNT_WORDS = new Set([
  "expense", "expenses", "admin", "administrative", "general", "miscellaneous",
  "other", "misc", "sundry", "various"
]);

const CATEGORY_KEYWORDS = {
  fuel: ["fuel", "gas", "oil", "lpg", "diesel", "petroleum", "gasoline", "petrol"],
  office_supplies: ["office", "supplies", "stationery", "paper", "toner", "ink"],
  meals: ["meals", "food", "representation", "entertainment", "catering"],
  repairs: ["repairs", "maintenance", "repair"],
  rent: ["rent", "rental", "lease"],
  professional_fees: ["professional", "fees", "consulting", "legal", "audit", "advisory"],
  freight: ["freight", "shipping", "delivery", "transport", "logistics", "courier"],
  utilities: ["utilities", "electricity", "water", "power", "telephone", "internet", "communication", "telecom"],
  inventory: ["inventory", "cost of goods", "cogs", "merchandise", "stock", "cost of sales"]
};

function fuzzyMatchAccount(accounts, suggestedName, category, lineDescription) {
  if (!accounts.length) return 0;
  const query = String(suggestedName || lineDescription || category || "").toLowerCase();
  if (!query) return 0;

  const tokens = query.split(/[\s&,/_-]+/).filter((t) => t.length > 2);
  if (!tokens.length) return 0;

  const extraTokens = CATEGORY_KEYWORDS[String(category || "").toLowerCase()] || [];
  const allTokens = [...new Set([...tokens, ...extraTokens])];
  const specificTokens = allTokens.filter((t) => !GENERIC_ACCOUNT_WORDS.has(t));

  let bestId = 0;
  let bestScore = 0;
  for (const acct of accounts) {
    const haystack = `${acct.code} ${acct.name}`.toLowerCase();
    let score = 0;
    let specificHits = 0;
    for (const t of allTokens) {
      if (haystack.includes(t)) {
        const weight = GENERIC_ACCOUNT_WORDS.has(t) ? 1 : t.length;
        score += weight;
        if (!GENERIC_ACCOUNT_WORDS.has(t)) specificHits++;
      }
    }
    const nameWords = acct.name.toLowerCase().split(/[\s&,/_-]+/).filter((w) => w.length > 2);
    const genericNameRatio = nameWords.filter((w) => GENERIC_ACCOUNT_WORDS.has(w)).length / (nameWords.length || 1);
    if (genericNameRatio > 0.5) score = Math.floor(score * 0.4);

    if (score > bestScore || (score === bestScore && specificHits > 0)) {
      bestScore = score;
      bestId = acct.id;
    }
  }
  return bestScore >= 4 ? bestId : 0;
}

function isGenericAccount(acct) {
  if (!acct) return false;
  const name = String(acct.name || "").toLowerCase();
  const nameWords = name.split(/[\s&,/_-]+/).filter((w) => w.length > 2);
  const genericRatio = nameWords.filter((w) => GENERIC_ACCOUNT_WORDS.has(w)).length / (nameWords.length || 1);
  return genericRatio > 0.5;
}

function resolveGeminiCandidate(candidate, expenseAccounts) {
  if (!candidate || !expenseAccounts?.length) return 0;
  const id = Number(candidate.account_id || 0);
  if (id && expenseAccounts.some((a) => a.id === id)) return id;
  const code = String(candidate.account_code || "").trim();
  if (code) {
    const byCode = expenseAccounts.find((a) => a.code === code);
    if (byCode) return byCode.id;
  }
  const name = String(candidate.account_name || "").trim().toLowerCase();
  if (name) {
    const byName = expenseAccounts.find((a) => a.name.toLowerCase() === name);
    if (byName) return byName.id;
    const byPartial = expenseAccounts.find((a) =>
      a.name.toLowerCase().includes(name) || name.includes(a.name.toLowerCase())
    );
    if (byPartial) return byPartial.id;
  }
  return 0;
}

function pickBestGeminiAccount(geminiPick, expenseAccounts) {
  if (!geminiPick || !expenseAccounts?.length) return { accountId: 0, source: "gemini" };
  const primaryId = resolveGeminiCandidate(geminiPick, expenseAccounts);
  if (primaryId) {
    const acct = expenseAccounts.find((a) => a.id === primaryId);
    if (!isGenericAccount(acct)) return { accountId: primaryId, source: "gemini" };
    const alts = geminiPick.alternatives || [];
    for (const alt of alts) {
      const altId = resolveGeminiCandidate(alt, expenseAccounts);
      if (altId) {
        const altAcct = expenseAccounts.find((a) => a.id === altId);
        if (!isGenericAccount(altAcct)) return { accountId: altId, source: "gemini_alt" };
      }
    }
    return { accountId: primaryId, source: "gemini_generic" };
  }
  const alts = geminiPick.alternatives || [];
  for (const alt of alts) {
    const altId = resolveGeminiCandidate(alt, expenseAccounts);
    if (altId) return { accountId: altId, source: "gemini_alt" };
  }
  return { accountId: 0, source: "gemini" };
}

async function resolveExpenseAccountId({
  odoo, companyId, vendorId, category, suggestedName,
  geminiPick, expenseAccounts, accountMapping, targetDb,
  lineDescription, vendorName
}) {
  // Tier 1: vendor default (skip if it's a generic account like Admin Expense)
  const vendorAcct = await getVendorDefaultAccountId(odoo, companyId, vendorId);
  if (vendorAcct && expenseAccounts?.length) {
    const vendorAcctObj = expenseAccounts.find((a) => a.id === vendorAcct);
    if (vendorAcctObj && !isGenericAccount(vendorAcctObj)) {
      return { accountId: vendorAcct, source: "vendor_default" };
    }
  }

  // Tier 2: Gemini pick (validated + repaired via code/name, anti-generic guard)
  if (geminiPick && expenseAccounts?.length) {
    const result = pickBestGeminiAccount(geminiPick, expenseAccounts);
    if (result.accountId) return result;
  }

  // Tier 3: vendor name keywords (e.g. "FABRIC TRADING" → Supplies)
  if (vendorName && expenseAccounts?.length) {
    const vnHint = vendorNameAccountHint(vendorName, expenseAccounts);
    if (vnHint) return { accountId: vnHint, source: "vendor_name_hint" };
  }

  // Tier 4: sheet mapping (AccountMapping tab)
  if (accountMapping?.length) {
    const mapped = lookupAccountMapping(accountMapping, companyId, category, targetDb);
    if (mapped) return { accountId: mapped, source: "sheet_mapping" };
  }

  // Tier 5: fuzzy name match using line description + category keywords
  if (expenseAccounts?.length) {
    const fuzzy = fuzzyMatchAccount(expenseAccounts, suggestedName, category, lineDescription);
    if (fuzzy) return { accountId: fuzzy, source: "fuzzy_match" };
  }

  // Tier 6: Gemini pick even if generic (still better than Odoo's blind default)
  if (geminiPick && expenseAccounts?.length) {
    const primaryId = resolveGeminiCandidate(geminiPick, expenseAccounts);
    if (primaryId) return { accountId: primaryId, source: "gemini_last_resort" };
  }

  // Tier 7: best non-generic expense account matching any keyword from description/category/vendor
  if (expenseAccounts?.length) {
    const combined = [suggestedName, lineDescription, category, vendorName].filter(Boolean).join(" ").toLowerCase();
    const words = combined.split(/[\s&,/_\-()]+/).filter((w) => w.length > 2);
    const nonGeneric = expenseAccounts.filter((a) => !isGenericAccount(a));
    if (nonGeneric.length) {
      let bestId = 0, bestHits = 0;
      for (const acct of nonGeneric) {
        const hay = `${acct.code} ${acct.name}`.toLowerCase();
        const hits = words.filter((w) => hay.includes(w)).length;
        if (hits > bestHits) { bestHits = hits; bestId = acct.id; }
      }
      if (bestId) return { accountId: bestId, source: "keyword_last_resort" };
      return { accountId: nonGeneric[0].id, source: "first_non_generic" };
    }
    return { accountId: expenseAccounts[0].id, source: "first_available" };
  }

  // Tier 8: env fallback
  if (config.odooDefaults.defaultExpenseAccountId > 0) {
    return { accountId: config.odooDefaults.defaultExpenseAccountId, source: "env_fallback" };
  }

  return { accountId: 0, source: "none" };
}

function adjustPriceForTax(price, invoiceVatInclusive, taxPriceInclude, taxRate) {
  if (!price) return price;
  if (invoiceVatInclusive && !taxPriceInclude) {
    return Math.round((price / (1 + taxRate / 100)) * 1e6) / 1e6;
  }
  if (!invoiceVatInclusive && taxPriceInclude) {
    return Math.round((price * (1 + taxRate / 100)) * 1e6) / 1e6;
  }
  return price;
}

function lineItemsTotalMatchesInvoice(lineItems, grandTotal, netTotal) {
  if (!lineItems.length) return false;
  const lineSum = lineItems.reduce((s, li) => s + Number(li.amount || 0), 0);
  if (!lineSum) return false;
  if (grandTotal > 0) {
    const diffGrand = Math.abs(lineSum - grandTotal) / grandTotal;
    if (diffGrand < 0.05) return true;
  }
  if (netTotal > 0 && netTotal !== grandTotal) {
    const diffNet = Math.abs(lineSum - netTotal) / netTotal;
    if (diffNet < 0.05) return true;
  }
  return false;
}

function extractOcrAmounts(ocrText) {
  if (!ocrText) return [];
  const matches = ocrText.match(/[\d,]+\.?\d*/g) || [];
  return matches
    .map((s) => Number(s.replace(/,/g, "")))
    .filter((n) => n >= 100 && Number.isFinite(n));
}

function isTotalLikeLabel(label) {
  const l = String(label || "").toLowerCase();
  const excludePatterns = ["line_item", "line item", "unit_price", "unit price", "vat_amount", "vat amount", "tax_amount", "tax amount", "exempt", "zero_rated"];
  if (excludePatterns.some((p) => l.includes(p))) return false;
  return l.includes("total") || l.includes("grand") || l.includes("due") || l.includes("amount due") || l.includes("amount_due") || l === "amount";
}

function fixExtractedAmounts(extracted, ocrText, logger) {
  const totals = extracted?.totals;
  if (!totals) return;
  const grandTotal = Number(totals.grand_total || 0);
  const lineItems = extracted?.line_items || [];
  const candidates = (extracted?.amount_candidates || [])
    .map((c) => ({ amount: Number(c.amount || 0), confidence: Number(c.confidence || 0), label: String(c.label || "").toLowerCase() }))
    .filter((c) => c.amount >= 10);
  const ocrAmounts = extractOcrAmounts(ocrText);

  let correctTotal = 0;

  const lineSum = lineItems.reduce((s, li) => s + Number(li.amount || 0), 0);

  // Case Y: grand_total looks like a year (2020-2030) confused with a monetary amount
  if (!correctTotal && grandTotal >= 2020 && grandTotal <= 2030 && grandTotal === Math.floor(grandTotal)) {
    if (lineItems.length >= 1 && lineSum > 0 && Math.abs(lineSum - grandTotal) / grandTotal > 0.1) {
      correctTotal = lineSum;
      if (logger) logger.info("Amount correction: grand total looks like a year number.", {
        geminiTotal: grandTotal, lineSum
      });
    } else {
      const totalCand = candidates
        .filter((c) => isTotalLikeLabel(c.label) && Math.abs(c.amount - grandTotal) / grandTotal > 0.1)
        .sort((a, b) => b.confidence - a.confidence)[0];
      if (totalCand) {
        correctTotal = totalCand.amount;
        if (logger) logger.info("Amount correction: grand total looks like a year, using candidate.", {
          geminiTotal: grandTotal, candidateAmount: totalCand.amount, label: totalCand.label
        });
      }
    }
  }

  // Case A: line sum >> grand total (grand total is too small — missing digits or picked a line item)
  if (!correctTotal && lineItems.length >= 2 && lineSum >= 100 && grandTotal >= 1) {
    const ratio = lineSum / grandTotal;
    if (ratio >= 2 && ratio <= 20) {
      correctTotal = lineSum;
      if (logger) logger.info("Amount correction: line sum >> grand total.", {
        geminiTotal: grandTotal, lineSum, ratio: ratio.toFixed(1)
      });
    }
  }

  // Case B: grand total >> line sum (grand total inflated, e.g. 85509 vs 8017)
  if (!correctTotal && lineItems.length >= 1 && lineSum >= 100 && grandTotal >= 1) {
    const ratio = grandTotal / lineSum;
    if (ratio >= 5 && ratio <= 15) {
      const bestCandidate = candidates
        .filter((c) => isTotalLikeLabel(c.label))
        .sort((a, b) => b.confidence - a.confidence)[0];
      if (bestCandidate && Math.abs(bestCandidate.amount - lineSum) / lineSum < 2) {
        correctTotal = bestCandidate.amount;
      } else {
        correctTotal = lineSum;
      }
      if (logger) logger.info("Amount correction: grand total >> line sum (inflated).", {
        geminiTotal: grandTotal, lineSum, corrected: correctTotal, ratio: ratio.toFixed(1)
      });
    }
  }

  // Case C: amount_candidate much larger than grand total (grand total truncated or picked a line item)
  if (!correctTotal && grandTotal >= 1) {
    const totalCands = candidates
      .filter((c) => isTotalLikeLabel(c.label))
      .sort((a, b) => b.amount - a.amount);
    for (const c of totalCands) {
      const ratio = c.amount / grandTotal;
      if (ratio >= 2 && ratio <= 20 && c.amount > grandTotal) {
        correctTotal = c.amount;
        if (logger) logger.info("Amount correction: total-candidate >> grand total.", {
          geminiTotal: grandTotal, candidateAmount: c.amount, label: c.label, ratio: ratio.toFixed(1)
        });
        break;
      }
    }
    if (!correctTotal) {
      for (const c of candidates) {
        const ratio = c.amount / grandTotal;
        if (ratio >= 5 && ratio <= 15) {
          correctTotal = c.amount;
          if (logger) logger.info("Amount correction: candidate >> grand total.", {
            geminiTotal: grandTotal, candidateAmount: c.amount, label: c.label, ratio: ratio.toFixed(1)
          });
          break;
        }
      }
    }
  }

  // Case D: amount_candidate much smaller than grand total (grand total inflated)
  if (!correctTotal && grandTotal >= 1) {
    const totalCandidates = candidates.filter((c) => isTotalLikeLabel(c.label));
    for (const c of totalCandidates) {
      const ratio = grandTotal / c.amount;
      if (ratio >= 5 && ratio <= 15) {
        correctTotal = c.amount;
        if (logger) logger.info("Amount correction: grand total >> candidate (inflated).", {
          geminiTotal: grandTotal, candidateAmount: c.amount, label: c.label, ratio: ratio.toFixed(1)
        });
        break;
      }
    }
  }

  // Case E: OCR max much larger than grand total (grand total truncated)
  if (!correctTotal && ocrAmounts.length && grandTotal >= 1) {
    const maxOcr = Math.max(...ocrAmounts);
    const ratio = maxOcr / grandTotal;
    if (ratio >= 2 && ratio <= 20) {
      correctTotal = maxOcr;
      if (logger) logger.info("Amount correction: OCR max >> grand total.", {
        geminiTotal: grandTotal, ocrMax: maxOcr, ratio: ratio.toFixed(1)
      });
    }
  }

  // Case F: grand total much larger than ALL OCR amounts (grand total inflated)
  if (!correctTotal && ocrAmounts.length >= 2 && grandTotal >= 100) {
    const maxOcr = Math.max(...ocrAmounts);
    const ratio = grandTotal / maxOcr;
    if (ratio >= 5 && ratio <= 15) {
      correctTotal = maxOcr;
      if (logger) logger.info("Amount correction: grand total >> OCR max (inflated).", {
        geminiTotal: grandTotal, ocrMax: maxOcr, ratio: ratio.toFixed(1)
      });
    }
  }

  // Case H: grand_total ≈ tax_total or vat_amount (picked VAT component as total)
  if (!correctTotal && grandTotal >= 1) {
    const taxTotal = Number(totals.tax_total || 0);
    const vatAmount = Number(extracted?.vat?.vat_amount || 0);
    const vatBase = Number(extracted?.vat?.vatable_base || 0);
    const taxRef = taxTotal || vatAmount;

    if (taxRef > 0 && Math.abs(grandTotal - taxRef) / grandTotal < 0.1) {
      if (vatBase > 0 && vatBase > taxRef) {
        correctTotal = vatBase + taxRef;
      } else {
        const bigCandidate = candidates
          .filter((c) => c.amount > grandTotal * 2 && isTotalLikeLabel(c.label))
          .sort((a, b) => b.confidence - a.confidence)[0];
        if (bigCandidate) {
          correctTotal = bigCandidate.amount;
        } else {
          correctTotal = Math.round((taxRef / 0.12) * 1.12 * 100) / 100;
        }
      }
      if (logger) logger.info("Amount correction: grand_total ≈ tax/vat_amount (picked VAT as total).", {
        geminiTotal: grandTotal, taxRef, vatBase, corrected: correctTotal
      });
    }
  }

  // Case I: tax_total > grand_total (impossible — tax cannot exceed total)
  if (!correctTotal && grandTotal >= 1) {
    const taxTotal = Number(totals.tax_total || 0);
    if (taxTotal > 0 && taxTotal > grandTotal * 0.20) {
      const bigCandidates = candidates
        .filter((c) => c.amount > grandTotal && isTotalLikeLabel(c.label))
        .sort((a, b) => b.confidence - a.confidence);
      if (bigCandidates.length) {
        correctTotal = bigCandidates[0].amount;
      } else if (lineSum > grandTotal * 1.5) {
        correctTotal = lineSum;
      } else {
        correctTotal = Math.round((taxTotal / 0.12) * 1.12 * 100) / 100;
      }
      if (logger) logger.info("Amount correction: tax_total > 20% of grand_total (likely wrong grand total).", {
        geminiTotal: grandTotal, taxTotal, lineSum, corrected: correctTotal
      });
    }
  }

  // Case G: decimal point misread — grandTotal / 10 or /100 is close to lineSum or a candidate
  if (!correctTotal && grandTotal >= 1000) {
    for (const divisor of [10, 100]) {
      const scaled = grandTotal / divisor;
      if (lineSum >= 100 && Math.abs(scaled - lineSum) / lineSum < 0.4) {
        correctTotal = lineSum;
        if (logger) logger.info("Amount correction: decimal misread (grand total /" + divisor + " ≈ line sum).", {
          geminiTotal: grandTotal, scaled: scaled.toFixed(2), lineSum
        });
        break;
      }
      const matchCandidate = candidates.find((c) =>
        Math.abs(scaled - c.amount) / c.amount < 0.15 && isTotalLikeLabel(c.label)
      );
      if (matchCandidate) {
        correctTotal = matchCandidate.amount;
        if (logger) logger.info("Amount correction: decimal misread (grand total /" + divisor + " ≈ candidate).", {
          geminiTotal: grandTotal, scaled: scaled.toFixed(2), candidateAmount: matchCandidate.amount, label: matchCandidate.label
        });
        break;
      }
    }
  }

  if (correctTotal > 0) {
    totals.grand_total = correctTotal;
    totals.grand_total_confidence = Math.min(totals.grand_total_confidence || 0.5, 0.7);
    if (totals.net_total) totals.net_total = correctTotal;
    if (lineItems.length === 1) {
      const li = lineItems[0];
      const liAmt = Number(li.amount || 0);
      if (Math.abs(liAmt - correctTotal) / (correctTotal || 1) > 0.5) {
        li.amount = correctTotal;
        const qty = Number(li.quantity) || 1;
        li.unit_price = qty > 0 ? Math.round((correctTotal / qty) * 100) / 100 : correctTotal;
      }
    }
  }
}

const VENDOR_NAME_ACCOUNT_KEYWORDS = {
  fabric: ["supplies", "raw materials", "inventory", "cost of sales", "cost of goods"],
  "fabric trading": ["supplies", "raw materials", "inventory", "cost of sales", "cost of goods"],
  textile: ["supplies", "raw materials", "inventory", "cost of sales"],
  cloth: ["supplies", "raw materials", "inventory"],
  hardware: ["supplies", "repairs", "maintenance", "hardware"],
  lumber: ["raw materials", "supplies", "cost of sales", "construction"],
  gas: ["fuel", "oil", "gas", "transportation"],
  fuel: ["fuel", "oil", "gas", "transportation"],
  petroleum: ["fuel", "oil", "gas", "petroleum"],
  food: ["meals", "food", "representation", "entertainment"],
  catering: ["meals", "food", "representation", "catering"],
  restaurant: ["meals", "food", "representation"],
  electrical: ["supplies", "electrical", "utilities"],
  plumbing: ["supplies", "plumbing", "repairs"],
  printing: ["printing", "supplies", "office"],
  stationery: ["office supplies", "stationery"],
  pharmacy: ["medical", "supplies", "medicine"],
  auto: ["repairs", "maintenance", "transportation"],
  tire: ["repairs", "maintenance", "transportation"],
  cement: ["raw materials", "construction", "supplies"],
  steel: ["raw materials", "construction", "supplies"],
  paint: ["supplies", "paint", "maintenance"],
  chemical: ["supplies", "chemicals", "raw materials"],
  laundry: ["laundry", "supplies", "services"],
  cleaning: ["janitorial", "cleaning", "supplies"]
};

function vendorNameAccountHint(vendorName, expenseAccounts) {
  if (!vendorName || !expenseAccounts?.length) return 0;
  const vn = String(vendorName).toLowerCase();
  for (const [keyword, searchTerms] of Object.entries(VENDOR_NAME_ACCOUNT_KEYWORDS)) {
    if (!vn.includes(keyword)) continue;
    for (const term of searchTerms) {
      const match = expenseAccounts.find((a) => {
        const name = a.name.toLowerCase();
        return name.includes(term) && !isGenericAccount(a);
      });
      if (match) return match.id;
    }
  }
  return 0;
}

function buildBillVals(extracted, vendorId, companyId, taxIds, purchaseJournalId, currencyId, taxMeta, lineAccountIds) {
  const inv = extracted?.invoice || {};
  const totals = extracted?.totals || {};
  const grandTotal = Number(totals.grand_total || 0);
  const netTotal = Number(totals.net_total || 0);
  const globalVatInclusive = !!totals.amounts_are_vat_inclusive;
  const hasTax = taxIds.length > 0;
  const taxPriceInclude = !!taxMeta?.priceInclude;
  const taxRate = Number(taxMeta?.amount || 12);

  const usedNetTotal = hasTax && globalVatInclusive && !taxPriceInclude && netTotal > 0;
  const total = usedNetTotal ? netTotal : (grandTotal || netTotal || 0);
  const invoiceDate = String(inv.date || "").slice(0, 10) || undefined;
  const ref = String(inv.number || "").trim();

  const lineItems = extracted?.line_items || [];
  const useLineItems = lineItems.length > 0 && lineItemsTotalMatchesInvoice(lineItems, grandTotal, netTotal);
  const hint = extracted?.expense_account_hint || {};
  const invoiceLines = [];

  const expectedUntaxed = hasTax && !taxPriceInclude && grandTotal > 0
    ? (netTotal > 0 ? netTotal : Math.round((grandTotal / (1 + taxRate / 100)) * 100) / 100)
    : (grandTotal || netTotal || 0);

  const hasPerLineVat = lineItems.some((li) => li.vat_code);

  if (useLineItems) {
    for (let i = 0; i < lineItems.length; i++) {
      const item = lineItems[i];
      const lineVatCode = String(item.vat_code || "").toLowerCase();

      let lineHasTax;
      if (hasPerLineVat && lineVatCode) {
        lineHasTax = lineVatCode === "vatable" && taxIds.length > 0;
      } else {
        lineHasTax = hasTax;
      }

      const itemVatInclusive = lineHasTax && (globalVatInclusive || (item.unit_price_includes_vat ?? false));
      const rawPrice = Number(item.unit_price || item.amount || 0);
      const line = {
        name: String(item.description || "Line item").slice(0, 256),
        quantity: Number(item.quantity) || 1,
        price_unit: lineHasTax ? adjustPriceForTax(rawPrice, itemVatInclusive, taxPriceInclude, taxRate) : rawPrice
      };
      const acctId = lineAccountIds?.[i] || 0;
      if (acctId) line.account_id = acctId;
      if (lineHasTax) line.tax_ids = [[6, 0, taxIds]];
      invoiceLines.push([0, 0, line]);
    }

    if (!hasPerLineVat && expectedUntaxed > 0 && invoiceLines.length > 0) {
      const lineUntaxedSum = invoiceLines.reduce((s, entry) => {
        const l = entry[2];
        return s + (l.price_unit * l.quantity);
      }, 0);
      const diff = expectedUntaxed - lineUntaxedSum;
      if (Math.abs(diff) > 0.005) {
        let bestIdx = 0;
        let bestScore = -Infinity;
        for (let i = 0; i < invoiceLines.length; i++) {
          const l = invoiceLines[i][2];
          const lineTotal = l.price_unit * l.quantity;
          const perUnitAdj = Math.abs(diff) / (l.quantity || 1);
          const adjRatio = perUnitAdj / (l.price_unit || 1);
          const score = lineTotal - adjRatio * 1e6;
          if (l.quantity === 1 || adjRatio < 0.001) {
            if (score > bestScore) { bestScore = score; bestIdx = i; }
          } else if (bestScore === -Infinity) {
            bestScore = score; bestIdx = i;
          }
        }
        const target = invoiceLines[bestIdx][2];
        const qty = target.quantity || 1;
        target.price_unit = Math.round((target.price_unit + diff / qty) * 1e6) / 1e6;
      }
    }
  } else {
    const singleLineVatInclusive = usedNetTotal ? false : globalVatInclusive;
    const adjustedTotal = hasTax ? adjustPriceForTax(total, singleLineVatInclusive, taxPriceInclude, taxRate) : total;
    const finalTotal = expectedUntaxed > 0 ? expectedUntaxed : adjustedTotal;
    const lineDescs = lineItems
      .map((li) => String(li.description || "").trim())
      .filter(Boolean);
    const fallbackLabel = lineDescs.length > 0
      ? lineDescs.join(", ").slice(0, 256)
      : "Vendor Bill";
    const line = {
      name: fallbackLabel,
      quantity: 1,
      price_unit: finalTotal
    };
    const acctId = lineAccountIds?.[0] || 0;
    if (acctId) line.account_id = acctId;
    if (hasTax) line.tax_ids = [[6, 0, taxIds]];
    invoiceLines.push([0, 0, line]);
  }

  const vals = {
    move_type: "in_invoice",
    partner_id: Number(vendorId),
    company_id: Number(companyId),
    invoice_line_ids: invoiceLines
  };

  if (purchaseJournalId) vals.journal_id = Number(purchaseJournalId);
  if (currencyId) vals.currency_id = Number(currencyId);
  if (ref) vals.ref = ref;
  if (invoiceDate) vals.invoice_date = invoiceDate;
  return vals;
}

const documentFieldSupportCache = new Map();

async function documentsDocumentHasField(odoo, fieldName) {
  if (documentFieldSupportCache.has(fieldName)) return documentFieldSupportCache.get(fieldName);
  try {
    const fg = await odoo.executeKw("documents.document", "fields_get", [[fieldName], ["type"]], {});
    const has = !!fg?.[fieldName];
    documentFieldSupportCache.set(fieldName, has);
    return has;
  } catch (_err) {
    documentFieldSupportCache.set(fieldName, false);
    return false;
  }
}

async function attachFileToBillChatter(odoo, companyId, att, billId, docId) {
  if (!att?.datas) return;
  try {
    const chatAttId = await odoo.create("ir.attachment", {
      name: att.name,
      mimetype: att.mimetype,
      datas: att.datas,
      res_model: "mail.compose.message",
      res_id: 0,
      description: `Source: documents.document#${docId} attachment#${att.id}`
    });
    await odoo.executeKw(
      "account.move",
      "message_post",
      [[Number(billId)]],
      kwWithCompany(companyId, {
        body: `📄 Original document file attached (doc #${docId})`,
        message_type: "comment",
        attachment_ids: [Number(chatAttId)]
      })
    );
  } catch (_err) {
    // best effort
  }
}

function readFolderId(docRow) {
  const raw = docRow?.folder_id;
  return raw ? (Array.isArray(raw) ? Number(raw[0]) : Number(raw)) : 0;
}

async function linkDocumentToBill(odoo, companyId, docId, billId, logger) {
  const docRows = await odoo.searchRead(
    "documents.document",
    [["id", "=", Number(docId)]],
    ["id", "folder_id"],
    kwWithCompany(companyId, { limit: 1 })
  );
  const originalFolderId = readFolderId(docRows?.[0]);

  const linkVals = {};
  if (await documentsDocumentHasField(odoo, "res_model")) linkVals.res_model = "account.move";
  if (await documentsDocumentHasField(odoo, "res_id")) linkVals.res_id = Number(billId);
  if (await documentsDocumentHasField(odoo, "account_move_id")) linkVals.account_move_id = Number(billId);
  if (await documentsDocumentHasField(odoo, "invoice_id")) linkVals.invoice_id = Number(billId);
  if (originalFolderId) linkVals.folder_id = originalFolderId;

  if (Object.keys(linkVals).length) {
    await odoo.write("documents.document", [Number(docId)], linkVals);
  }

  if (originalFolderId) {
    const delays = [800, 1500, 3000, 5000];
    for (let attempt = 0; attempt < delays.length; attempt++) {
      await sleep(delays[attempt]);
      try {
        const rows = await odoo.searchRead(
          "documents.document",
          [["id", "=", Number(docId)]],
          ["id", "folder_id"],
          kwWithCompany(companyId, { limit: 1 })
        );
        const currentFolderId = readFolderId(rows?.[0]);
        if (currentFolderId === originalFolderId) break;
        await odoo.write("documents.document", [Number(docId)], { folder_id: originalFolderId });
        if (logger) logger.info("Restored document folder after link.", {
          docId, originalFolderId, movedTo: currentFolderId, attempt: attempt + 1
        });
      } catch (_) {}
    }
  }

  const baseUrl = odoo.baseUrl || "";
  const docLink = `${baseUrl}/odoo/documents/${docId}`;
  await safeMessagePost(
    odoo,
    companyId,
    "account.move",
    Number(billId),
    `📎 Source document: <a href="${docLink}">Document #${docId}</a> (Documents app)`
  );
}

async function processOneDocument(args) {
  const {
    logger,
    odoo,
    companyId,
    targetKey,
    doc,
    vatIds,
    purchaseJournalId,
    industry,
    reprocess = false
  } = args;
  const attachmentId = m2oId(doc.attachment_id);
  if (!attachmentId) return { status: "skip", reason: "no_attachment" };

  const att = await loadAttachment(odoo, companyId, attachmentId);
  if (!att) return { status: "skip", reason: "attachment_not_found" };

  if (reprocess && isProcessed(att.description, config.scan.processedMarkerPrefix, targetKey, doc.id)) {
    const billId = getProcessedBillId(att.description, config.scan.processedMarkerPrefix, targetKey, doc.id);
    const marker = makeProcessedMarker(config.scan.processedMarkerPrefix, targetKey, doc.id, billId || 0, doc.name);
    const cleaned = String(att.description || "").replace(marker, "").replace(/\n{2,}/g, "\n").trim();
    await odoo.write("ir.attachment", [att.id], { description: cleaned });
    att.description = cleaned;
    logger.info("Reprocess requested: cleared processed marker.", { docId: doc.id });
  }
  if (!reprocess && isProcessed(att.description, config.scan.processedMarkerPrefix, targetKey, doc.id)) {
    const billId = getProcessedBillId(att.description, config.scan.processedMarkerPrefix, targetKey, doc.id);
    if (billId) {
      const billExists = await odoo.searchRead(
        "account.move",
        [["id", "=", billId]],
        ["id"],
        kwWithCompany(companyId, { limit: 1 })
      );
      if (billExists?.length) {
        return { status: "skip", reason: "already_processed", billId };
      }
      logger.info("Linked bill was deleted, clearing marker for reprocessing.", { docId: doc.id, billId });
      const marker = makeProcessedMarker(config.scan.processedMarkerPrefix, targetKey, doc.id, billId, doc.name);
      const cleaned = String(att.description || "").replace(marker, "").replace(/\n{2,}/g, "\n").trim();
      await odoo.write("ir.attachment", [att.id], { description: cleaned });
      att.description = cleaned;
    }
  }

  let ocrText = "";
  const existingJob = parseOcrJobMarker(
    att.description,
    config.scan.ocrJobMarkerPrefix,
    targetKey,
    doc.id,
    att.id
  );

  if (existingJob) {
    logger.info("Found prior OCR job marker; rerunning OCR inline for continuity.", {
      docId: doc.id,
      attId: att.id,
      opName: existingJob.opName
    });
  } else {
    const jobMarker = makeOcrJobMarker(
      config.scan.ocrJobMarkerPrefix,
      targetKey,
      doc.id,
      att.id,
      `inline-${Date.now()}`,
      "inline"
    );
    await odoo.write("ir.attachment", [att.id], {
      description: appendMarker(att.description, jobMarker)
    });
  }

  ocrText = await ocrTextForAttachment(att, config, logger);
  if (!ocrText || ocrText.trim().length < config.scan.ocrMinTextLen) {
    return { status: "skip", reason: "ocr_too_short" };
  }

  const extracted = await extractInvoiceWithGemini(ocrText, config, att);
  fixExtractedAmounts(extracted, ocrText, logger);
  let vendor = await findVendor(odoo, companyId, extracted, ocrText);
  if (!vendor.id) {
    const createdVendor = await createVendorIfMissing(odoo, companyId, extracted, ocrText);
    if (createdVendor.partnerId) {
      vendor = {
        id: Number(createdVendor.partnerId),
        name: String(createdVendor.name || extracted?.vendor?.name || ""),
        confidence: Number(extracted?.vendor?.confidence || 0),
        source: extracted?.vendor?.source || "unknown",
        created: !!createdVendor.created
      };
      await safeMessagePost(
        odoo,
        companyId,
        "documents.document",
        doc.id,
        `✅ Vendor auto-${createdVendor.created ? "created" : "matched"}: ${vendor.name} (#${vendor.id}).`
      );
    } else {
      await safeMessagePost(
        odoo,
        companyId,
        "documents.document",
        doc.id,
        `⚠️ Manual review required: vendor not confidently matched.\n` +
          `Extracted vendor=${extracted?.vendor?.name || "(blank)"} conf=${Number(extracted?.vendor?.confidence || 0)} source=${extracted?.vendor?.source || "unknown"}\n` +
          `TIN=${extracted?.vendor_details?.tin || "(none)"} Address=${extracted?.vendor_details?.address || "(none)"}`
      );
      return { status: "skip", reason: "vendor_not_found", manual_review: true };
    }
  }

  if (!reprocess) {
    const duplicate = await findDuplicateBill(odoo, companyId, vendor.id, extracted);
    if (duplicate?.id) {
      const marker = makeProcessedMarker(
        config.scan.processedMarkerPrefix,
        targetKey,
        doc.id,
        duplicate.id,
        doc.name
      );
      await odoo.write("ir.attachment", [att.id], {
        description: appendMarker(att.description, marker)
      });
      return { status: "skip", reason: "duplicate", billId: duplicate.id };
    }
  }

  const currencyCode = String(extracted?.invoice?.currency || "").trim();
  const currencyId = await resolveCurrencyId(odoo, companyId, currencyCode);
  const taxIds = pickTaxIds(vatIds, extracted);
  const taxMeta = await getTaxMeta(odoo, companyId, taxIds);

  // --- Account resolution ---
  const expenseAccounts = await loadExpenseAccounts(odoo, companyId);
  const acctLoadLog = expenseAccounts._loadLog || [];
  logger.info("Expense accounts loaded.", {
    docId: doc.id, count: expenseAccounts.length,
    sample: expenseAccounts.slice(0, 5).map((a) => `${a.code} ${a.name}`),
    hasNonGeneric: expenseAccounts.some((a) => !isGenericAccount(a)),
    loadLog: acctLoadLog
  });
  const accountMapping = await getAccountMapping();
  let geminiAssignments = null;
  try {
    geminiAssignments = await assignAccountsWithGemini(extracted, expenseAccounts, config, industry, ocrText);
    if (geminiAssignments) {
      logger.info("Gemini Pass 2 account assignments.", {
        docId: doc.id,
        billLevel: {
          accountId: geminiAssignments.bill_level_account_id,
          code: geminiAssignments.bill_level_account_code,
          name: geminiAssignments.bill_level_account_name,
          conf: geminiAssignments.bill_level_confidence
        },
        assignments: (geminiAssignments.assignments || []).map((a) => ({
          line: a.line_index,
          accountId: a.account_id,
          code: a.account_code,
          name: a.account_name,
          conf: a.confidence,
          reason: (a.reasoning || "").slice(0, 80),
          alts: (a.alternatives || []).map((alt) => ({
            id: alt.account_id, code: alt.account_code, name: alt.account_name, conf: alt.confidence
          }))
        }))
      });
    } else {
      logger.warn("Gemini Pass 2 returned null.", { docId: doc.id });
    }
  } catch (err) {
    logger.warn("Gemini Pass 2 failed.", { docId: doc.id, error: err?.message || String(err) });
  }

  const lineItems = extracted?.line_items || [];
  const hint = extracted?.expense_account_hint || {};
  const grandTotal = Number(extracted?.totals?.grand_total || 0);
  const netTotal = Number(extracted?.totals?.net_total || 0);
  const useLines = lineItems.length > 0 && lineItemsTotalMatchesInvoice(lineItems, grandTotal, netTotal);

  const lineCount = useLines ? lineItems.length : 1;
  const lineAccountIds = [];
  const lineAccountSources = [];
  for (let i = 0; i < lineCount; i++) {
    const item = useLines ? lineItems[i] : null;
    const category = item?.expense_category || hint.category || "other";
    const lineDesc = item ? String(item.description || "").trim() : "";
    const suggestedName = hint.suggested_account_name || lineDesc || "";
    const geminiLinePick = geminiAssignments?.assignments?.find((a) => a.line_index === i);
    const geminiPick = geminiLinePick || (i === 0 && geminiAssignments ? {
      account_id: geminiAssignments.bill_level_account_id,
      account_code: geminiAssignments.bill_level_account_code || "",
      account_name: geminiAssignments.bill_level_account_name || "",
      confidence: geminiAssignments.bill_level_confidence || 0,
      reasoning: "bill-level fallback",
      alternatives: []
    } : null);

    const vendorNameForHint = String(extracted?.vendor_details?.trade_name || extracted?.vendor?.name || vendor.name || "").trim();
    const resolved = await resolveExpenseAccountId({
      odoo, companyId, vendorId: vendor.id,
      category, suggestedName, geminiPick,
      expenseAccounts, accountMapping, targetDb: odoo.db,
      lineDescription: lineDesc, vendorName: vendorNameForHint || vendor.name
    });
    lineAccountIds.push(resolved.accountId);
    lineAccountSources.push(resolved.source);
    logger.info("Account resolved.", {
      docId: doc.id, line: i, category, lineDesc: lineDesc.slice(0, 40),
      accountId: resolved.accountId, source: resolved.source
    });
  }

  const billVals = buildBillVals(
    extracted,
    vendor.id,
    companyId,
    taxIds,
    purchaseJournalId,
    currencyId,
    taxMeta,
    lineAccountIds
  );
  const billId = await odoo.create("account.move", billVals);
  const marker = makeProcessedMarker(
    config.scan.processedMarkerPrefix,
    targetKey,
    doc.id,
    Number(billId),
    doc.name
  );
  await odoo.write("ir.attachment", [att.id], {
    description: appendMarker(att.description, marker)
  });
  await attachFileToBillChatter(odoo, companyId, att, Number(billId), Number(doc.id));
  await linkDocumentToBill(odoo, companyId, Number(doc.id), Number(billId), logger);
  await safeMessagePost(
    odoo,
    companyId,
    "documents.document",
    doc.id,
    `✅ Draft Vendor Bill created: account.move #${billId}<br/>Vendor=${vendor.name || "(unknown)"}`
  );

  {
    const vd = extracted?.vendor_details || {};
    const et = String(vd.entity_type || vendor.entityType || "unknown").toLowerCase();
    const entityLabel = et === "sole_proprietor" ? "Sole Proprietor"
      : et === "corporation" ? "Corporation"
      : et === "individual" ? "Individual"
      : "Unknown";
    const tn = String(vd.trade_name || vendor.tradeName || "").trim();
    const pn = String(vd.proprietor_name || vendor.proprietorName || "").trim();
    const vendorMsg = [
      `<b>🔍 Vendor extraction</b>`,
      `Name: ${vendor.name || "(unknown)"} | Confidence: ${Number(extracted?.vendor?.confidence || 0).toFixed(2)}`,
      `Entity type: <b>${entityLabel}</b>`,
      tn && tn.toLowerCase() !== (vendor.name || "").toLowerCase() ? `Trade name: ${tn}` : null,
      pn ? `Proprietor/Owner: ${pn}` : null,
      vd.tin ? `TIN: ${vd.tin}` : null,
      vd.address ? `Address: ${vd.address}` : null,
      vendor.created ? `<i>Vendor auto-created in Odoo (as ${et === "sole_proprietor" || et === "individual" ? "Individual" : "Company"})</i>` : null
    ].filter(Boolean).join("<br/>");
    await safeMessagePost(odoo, companyId, "account.move", Number(billId), vendorMsg);
  }

  {
    const lines = [];
    for (let i = 0; i < lineAccountIds.length; i++) {
      const acctId = lineAccountIds[i];
      const acct = acctId ? expenseAccounts.find((a) => a.id === acctId) : null;
      const li = useLines && lineItems[i] ? lineItems[i] : null;
      const desc = li ? String(li.description || "").slice(0, 60) : "Single line";
      const resolvedSource = lineAccountSources[i] || "";
      const srcLabel = resolvedSource ? ` <i>(${resolvedSource})</i>` : "";
      lines.push(`Line ${i + 1}: ${desc} → ${acct ? `<b>${acct.code} ${acct.name}</b>${srcLabel}` : `(account #${acctId || "default"}) <i>(${resolvedSource || "no accounts loaded"})</i>`}`);
    }
    const geminiInfo = geminiAssignments
      ? `Gemini: bill_level=${geminiAssignments.bill_level_account_code || "?"} ${geminiAssignments.bill_level_account_name || "?"}`
      : "Gemini Pass 2: null";
    const loadStatus = acctLoadLog.length ? acctLoadLog.join("; ") : "no log";
    const acctMsg = [`<b>💡 Account suggestions</b> <i>(${expenseAccounts.length} accounts loaded)</i>`, `<i>${loadStatus}</i>`, geminiInfo, ...lines].join("<br/>");
    await safeMessagePost(odoo, companyId, "account.move", Number(billId), acctMsg);
  }

  {
    const t = extracted?.totals || {};
    const amtMsg = [
      `<b>📊 Extracted amounts</b>`,
      `Grand total: ${Number(t.grand_total || 0).toFixed(2)} | Net total: ${Number(t.net_total || 0).toFixed(2)} | Tax: ${Number(t.tax_total || 0).toFixed(2)}`,
      `VAT-inclusive prices: ${t.amounts_are_vat_inclusive ? "Yes" : "No"} | Currency: ${extracted?.invoice?.currency || "(not detected)"}`,
      extracted?.invoice?.number ? `Invoice #: ${extracted.invoice.number}` : null,
      extracted?.invoice?.date ? `Invoice date: ${extracted.invoice.date}` : null
    ].filter(Boolean).join("<br/>");
    await safeMessagePost(odoo, companyId, "account.move", Number(billId), amtMsg);
  }

  if ((extracted?.warnings || []).length || Number(extracted?.vendor?.confidence || 0) < 0.9) {
    await safeMessagePost(
      odoo,
      companyId,
      "account.move",
      Number(billId),
      `<b>⚠️ Manual review recommended.</b> Vendor confidence=${Number(extracted?.vendor?.confidence || 0).toFixed(2)}<br/>Warnings:<br/>- ${(extracted?.warnings || []).join("<br/>- ") || "(none)"}`
    );
  }
  return { status: "ok", billId: Number(billId), vendorId: vendor.id, vendorCreated: !!vendor.created };
}

async function processTargetGroup(target, startMs, logger) {
  const odoo = new OdooClient(target.targetCfg);
  const state = await loadState(config, target.targetKey);

  let apFolderId = Number(target.apFolderId || 0);
  if (!apFolderId) apFolderId = await resolveApFolderId(odoo, target.companyId);

  const docs = await listCandidateDocuments(odoo, target.companyId, apFolderId);
  const lastProcessed = Number(state.last_doc_id || 0);
  const newDocs = docs
    .filter((d) => Number(d.id) > lastProcessed)
    .sort((a, b) => Number(a.id) - Number(b.id));
  const revisitDocs = docs
    .filter((d) => Number(d.id) <= lastProcessed)
    .sort((a, b) => Number(a.id) - Number(b.id));
  const docsSorted = [...newDocs, ...revisitDocs];

  const stats = {
    scanned: 0,
    created: 0,
    skipped: 0,
    errors: 0,
    lastDocId: Number(state.last_doc_id || 0)
  };

  for (const doc of docsSorted) {
    if (outOfTime(startMs)) {
      logger.warn("Stopped target processing due to runtime budget.", {
        targetKey: target.targetKey
      });
      break;
    }
    stats.scanned += 1;
    try {
      const result = await processOneDocument({
        logger,
        odoo,
        companyId: target.companyId,
        targetKey: target.targetKey,
        doc,
        vatIds: target.vatIds,
        purchaseJournalId: target.purchaseJournalId,
        industry: target.industry
      });
      if (result.status === "ok") stats.created += 1;
      else stats.skipped += 1;
      stats.lastDocId = Math.max(stats.lastDocId, Number(doc.id) || 0);
    } catch (err) {
      stats.errors += 1;
      logger.error("Document processing failed.", {
        targetKey: target.targetKey,
        docId: doc.id,
        error: err?.message || String(err)
      });
    }
  }

  await saveState(config, target.targetKey, {
    last_doc_id: stats.lastDocId
  });
  return stats;
}

async function runOne({ logger, payload = {} }) {
  const timeStart = new Date().toISOString();
  clearPerRunCaches();
  const routingRows = await getRoutingRows(logger);
  const targets = groupRoutingRows(routingRows);
  if (!targets.length) {
    throw new Error("No enabled routing rows available.");
  }

  const targetKeyInput = String(payload.target_key || "").trim();
  const docId = Number(payload.doc_id || 0);
  const attachmentId = Number(payload.attachment_id || 0);
  if (!docId && !attachmentId) {
    throw new Error("run-one requires either doc_id or attachment_id.");
  }

  let target = null;
  if (targetKeyInput) {
    target = targets.find((t) => t.targetKey === targetKeyInput) || null;
    if (!target) throw new Error(`target_key not found: ${targetKeyInput}`);
  } else if (targets.length === 1) {
    target = targets[0];
  } else {
    throw new Error("Multiple targets enabled. Pass target_key in request body.");
  }

  const odoo = new OdooClient(target.targetCfg);
  const companyId = Number(target.companyId);

  const docFields = ["id", "name", "attachment_id", "folder_id", "company_id", "create_date", "res_model", "res_id"];
  let docs = [];
  if (docId) {
    docs = await odoo.searchRead(
      "documents.document",
      [["id", "=", docId], ["is_folder", "=", false]],
      docFields,
      kwWithCompany(companyId, { limit: 1 })
    );
    if (!docs?.length) {
      docs = await odoo.searchRead(
        "documents.document",
        [["id", "=", docId]],
        docFields,
        { limit: 1 }
      );
    }
    if (!docs?.length) {
      try {
        docs = await odoo.searchRead(
          "documents.document",
          [["id", "=", docId], ["active", "in", [true, false]]],
          docFields,
          { limit: 1 }
        );
      } catch (_) {}
    }
  } else {
    docs = await odoo.searchRead(
      "documents.document",
      [["attachment_id", "=", attachmentId], ["is_folder", "=", false]],
      docFields,
      kwWithCompany(companyId, { limit: 1, order: "id desc" })
    );
  }

  const doc = docs?.[0] || null;
  if (!doc) {
    throw new Error(
      docId
        ? `Document not found for doc_id=${docId}. It may have been deleted from Odoo (check Odoo trash/archive). Try uploading the file again to the AP folder to get a new doc_id.`
        : `Document not found for attachment_id=${attachmentId}.`
    );
  }

  if (doc.res_model === "account.move" && doc.res_id) {
    const billExists = await odoo.searchRead(
      "account.move",
      [["id", "=", Number(doc.res_id)]],
      ["id"],
      kwWithCompany(companyId, { limit: 1 })
    );
    if (!billExists?.length) {
      logger.info("Clearing stale bill link from document (bill was deleted).", {
        docId: doc.id, staleBillId: doc.res_id
      });
      const clearVals = { res_model: false, res_id: false };
      try { clearVals.account_move_id = false; } catch (_) {}
      try { clearVals.invoice_id = false; } catch (_) {}
      await odoo.write("documents.document", [Number(doc.id)], clearVals);
    }
  }

  const result = await processOneDocument({
    logger,
    odoo,
    companyId,
    targetKey: target.targetKey,
    doc,
    vatIds: target.vatIds,
    purchaseJournalId: target.purchaseJournalId,
    industry: target.industry,
    reprocess: !!(payload.reprocess || payload.force_reprocess)
  });

  return {
    ok: true,
    mode: "run-one",
    time_start: timeStart,
    time_completed: new Date().toISOString(),
    targetKey: target.targetKey,
    doc: {
      id: Number(doc.id),
      name: String(doc.name || ""),
      attachment_id: m2oId(doc.attachment_id)
    },
    result
  };
}

async function listApDocuments({ logger, payload = {} }) {
  const routingRows = await getRoutingRows(logger);
  const targets = groupRoutingRows(routingRows);
  if (!targets.length) {
    throw new Error("No enabled routing rows available.");
  }

  const targetKeyInput = String(payload.target_key || "").trim();
  let target = null;
  if (targetKeyInput) {
    target = targets.find((t) => t.targetKey === targetKeyInput) || null;
    if (!target) throw new Error(`target_key not found: ${targetKeyInput}`);
  } else if (targets.length === 1) {
    target = targets[0];
  } else {
    throw new Error("Multiple targets enabled. Pass target_key in request query or body.");
  }

  const odoo = new OdooClient(target.targetCfg);
  let apFolderId = Number(target.apFolderId || 0);
  if (!apFolderId) apFolderId = await resolveApFolderId(odoo, target.companyId);

  const allDocs = await odoo.searchRead(
    "documents.document",
    [
      ["folder_id", "=", apFolderId],
      ["is_folder", "=", false],
      ["attachment_id", "!=", false]
    ],
    ["id", "name", "attachment_id", "create_date"],
    kwWithCompany(target.companyId, { limit: 5000, order: "id desc" })
  );
  return {
    ok: true,
    targetKey: target.targetKey,
    apFolderId,
    count: allDocs.length,
    documents: allDocs.map((d) => ({
      doc_id: Number(d.id),
      name: String(d.name || ""),
      attachment_id: m2oId(d.attachment_id),
      create_date: d.create_date || null
    }))
  };
}

function clearPerRunCaches() {
  expenseAccountsCache.clear();
  vendorAccountCache.clear();
  accountMappingCache = null;
}

async function runWorker({ logger }) {
  clearPerRunCaches();
  const timeStart = new Date().toISOString();
  const startMs = Date.now();
  const routingRows = await getRoutingRows(logger);
  const targets = groupRoutingRows(routingRows);
  const totals = {
    targets: targets.length,
    scanned: 0,
    created: 0,
    skipped: 0,
    errors: 0
  };
  const targetStats = [];

  for (const target of targets) {
    if (outOfTime(startMs)) break;
    try {
      const stats = await processTargetGroup(target, startMs, logger);
      totals.scanned += stats.scanned;
      totals.created += stats.created;
      totals.skipped += stats.skipped;
      totals.errors += stats.errors;
      targetStats.push({
        targetKey: target.targetKey,
        ...stats
      });
    } catch (err) {
      totals.errors += 1;
      targetStats.push({
        targetKey: target.targetKey,
        error: err?.message || String(err)
      });
      logger.error("Target failed.", {
        targetKey: target.targetKey,
        error: err?.message || String(err)
      });
    }
  }

  return {
    ok: true,
    time_start: timeStart,
    time_completed: new Date().toISOString(),
    elapsedMs: Date.now() - startMs,
    totals,
    targets: targetStats
  };
}

module.exports = {
  runWorker,
  runOne,
  listApDocuments
};
