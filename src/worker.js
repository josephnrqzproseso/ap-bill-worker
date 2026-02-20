const { config } = require("./config");
const { OdooClient, kwWithCompany } = require("./odoo");
const {
  loadRoutingSheetData,
  saveRoutingSheetData,
  toRoutingRowStrict
} = require("./sheets");
const { ocrTextForAttachment } = require("./vision");
const { extractInvoiceWithGemini } = require("./gemini");
const { m2oId, normalizeOdooBaseUrl, deriveDbFromBaseUrl, isFalsyOdooValue } = require("./utils");
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

async function getSourceOdooTargetMap(logger) {
  const src = config.odooDefaults;
  if (!src.sourceBaseUrl || !src.sourceDb || !src.sourceLogin || !src.sourcePassword) {
    return null;
  }
  try {
    const odoo = new OdooClient({
      baseUrl: src.sourceBaseUrl,
      db: src.sourceDb,
      login: src.sourceLogin,
      password: src.sourcePassword
    });
    const stageName = src.routingStageName || "Master";
    const taxFilter = src.taxTaskNameFilter || "Tax PH";
    const taxTasks =
      (await odoo.searchRead(
        "project.task",
        [
          ["name", "ilike", taxFilter],
          ["stage_id.name", "=", stageName]
        ],
        ["id", "project_id"],
        { limit: 500, order: "id desc" }
      )) || [];
    const projectIds = [
      ...new Set(
        taxTasks
          .map((t) => (Array.isArray(t.project_id) ? t.project_id[0] : null))
          .filter(Boolean)
          .map((n) => Number(n))
          .filter((n) => Number.isFinite(n) && n > 0)
      )
    ];
    if (!projectIds.length) return new Map();
    const generalTasks =
      (await odoo.searchRead(
        "project.task",
        [
          ["project_id", "in", projectIds],
          ["name", "=", "General"]
        ],
        ["id", "project_id", config.odooDefaults.sourceGeneralTaskDbField],
        { limit: projectIds.length * 5 }
      )) || [];
    const rawDbByProject = new Map();
    for (const t of generalTasks) {
      const pid = Array.isArray(t.project_id) ? Number(t.project_id[0]) : null;
      if (!pid) continue;
      if (!rawDbByProject.has(pid)) {
        rawDbByProject.set(pid, t[config.odooDefaults.sourceGeneralTaskDbField]);
      }
    }
    const map = new Map();
    for (const pid of projectIds) {
      const parsed = parseAcctDb(rawDbByProject.get(pid));
      if (parsed.target_base_url) map.set(pid, parsed);
    }
    logger.info("Refreshed target_base_url/target_db from SOURCE General task.", { projects: map.size });
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
    "ap_folder_id"
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

  const serviceLike = (t) => has(t, /service|consult|professional|repair|rent|labor|contract|freight/);
  const goodsLike = (t) => has(t, /goods|supply|material|asset|capital|inventory|product|merch/);

  const generic = pickTopTaxByScore(vat12, (t) => {
    let score = 0;
    if (norm(t.type_tax_use) === "purchase") score += 5;
    if (!t.price_include) score += 2;
    if (serviceLike(t) || goodsLike(t)) score += 1;
    return score;
  });
  const services = pickTopTaxByScore(vat12, (t) => {
    let score = 0;
    if (serviceLike(t)) score += 10;
    if (!goodsLike(t)) score += 2;
    if (!t.price_include) score += 1;
    return score;
  });
  const goods = pickTopTaxByScore(vat12, (t) => {
    let score = 0;
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

async function resolvePurchaseJournalId(odoo, companyId) {
  const journals = await odoo.searchRead(
    "account.journal",
    [["type", "=", "purchase"], ["company_id", "=", companyId]],
    ["id"],
    kwWithCompany(companyId, { limit: 1, order: "id asc" })
  );
  return journals?.[0]?.id ? Number(journals[0].id) : 0;
}

async function refreshRoutingAutoFields(headers, rows, logger) {
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

      for (const row of g.rows) {
        const before = [
          String(row.vat_purchase_tax_id_goods || "").trim(),
          String(row.vat_purchase_tax_id_services || "").trim(),
          String(row.vat_purchase_tax_id_generic || "").trim(),
          String(row.purchase_journal_id || "").trim(),
          String(row.ap_folder_id || "").trim()
        ].join("|");

        row.vat_purchase_tax_id_goods = pick.goodsId ? String(pick.goodsId) : "";
        row.vat_purchase_tax_id_services = pick.servicesId ? String(pick.servicesId) : "";
        row.vat_purchase_tax_id_generic = pick.genericId ? String(pick.genericId) : "";
        if (journalId && !Number(row.purchase_journal_id)) row.purchase_journal_id = String(journalId);
        if (apFolderId && !Number(row.ap_folder_id)) row.ap_folder_id = String(apFolderId);

        const after = [
          String(row.vat_purchase_tax_id_goods || "").trim(),
          String(row.vat_purchase_tax_id_services || "").trim(),
          String(row.vat_purchase_tax_id_generic || "").trim(),
          String(row.purchase_journal_id || "").trim(),
          String(row.ap_folder_id || "").trim()
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
  const sourceMap = await getSourceOdooTargetMap(logger);
  if (sourceMap && sourceMap.size > 0) {
    for (const row of rows) {
      const pid = Number(row.source_project_id || 0);
      if (pid && sourceMap.has(pid)) {
        const r = sourceMap.get(pid);
        if (!normalizeOdooBaseUrl(row.target_base_url)) row.target_base_url = r.target_base_url || row.target_base_url;
        if (!String(row.target_db || "").trim()) row.target_db = r.target_db || row.target_db;
      }
    }
  }

  const refreshRes = await refreshRoutingAutoFields(headers, rows, logger);
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
        }
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
        message_type: "comment"
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
  const vendors = await odoo.searchRead(
    "res.partner",
    [
      ["name", "ilike", vendorName],
      ["supplier_rank", ">", 0]
    ],
    ["id", "name"],
    kwWithCompany(companyId, { limit: 5, order: "supplier_rank desc,id asc" })
  );
  const winner = vendors?.[0];
  return {
    id: Number(winner?.id || 0),
    name: String(winner?.name || vendorName),
    confidence: Number(picked.confidence || 0),
    source: picked.source
  };
}

async function createVendorIfMissing(odoo, companyId, extracted, ocrText) {
  const picked = pickVendorFromExtraction(extracted, ocrText);
  const name = String(picked.name || "").trim();
  const conf = Number(picked.confidence || 0);
  if (!name) return { status: "missing", partnerId: 0, created: false };
  if (looksLikeAtpPrinterVendor(name, ocrText) || String(picked.source || "") === "atp_printer_box") {
    return { status: "blocked_printer", partnerId: 0, created: false };
  }
  const AUTOCREATE_VENDOR_MIN = 0.9;
  if (conf < AUTOCREATE_VENDOR_MIN) {
    return { status: "needs_confirmation", partnerId: 0, created: false, confidence: conf, name };
  }

  const existing = await odoo.searchRead(
    "res.partner",
    [["name", "=", name], ["supplier_rank", ">", 0]],
    ["id", "name"],
    kwWithCompany(companyId, { limit: 1 })
  );
  if (existing?.length) {
    return { status: "matched", partnerId: Number(existing[0].id), created: false, name: existing[0].name };
  }

  const details = extracted?.vendor_details || {};
  const vals = {
    name,
    supplier_rank: 1
  };
  if (String(details.address || "").trim()) vals.street = String(details.address).trim().slice(0, 255);
  if (String(details.tin || "").trim()) vals.vat = String(details.tin).trim();
  const newId = await odoo.create("res.partner", vals);
  return { status: "created", partnerId: Number(newId), created: true, name };
}

function pickTaxIds(vatIds, extracted) {
  const classification = String(extracted?.vat?.classification || "").toLowerCase();
  if (classification === "exempt" || classification === "zero_rated" || classification === "unknown") {
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

function adjustPriceForTax(price, invoiceVatInclusive, taxPriceInclude, taxRate) {
  if (!price) return price;
  if (invoiceVatInclusive && !taxPriceInclude) {
    return Math.round((price / (1 + taxRate / 100)) * 100) / 100;
  }
  if (!invoiceVatInclusive && taxPriceInclude) {
    return Math.round((price * (1 + taxRate / 100)) * 100) / 100;
  }
  return price;
}

function buildBillVals(extracted, vendorId, companyId, taxIds, purchaseJournalId, currencyId, taxMeta) {
  const inv = extracted?.invoice || {};
  const totals = extracted?.totals || {};
  const grandTotal = Number(totals.grand_total || 0);
  const netTotal = Number(totals.net_total || 0);
  const globalVatInclusive = !!totals.amounts_are_vat_inclusive;
  const hasTax = taxIds.length > 0;
  const taxPriceInclude = !!taxMeta?.priceInclude;
  const taxRate = Number(taxMeta?.amount || 12);

  const total = (hasTax && globalVatInclusive && !taxPriceInclude && netTotal > 0)
    ? netTotal
    : (grandTotal || netTotal || 0);
  const invoiceDate = String(inv.date || "").slice(0, 10) || undefined;
  const ref = String(inv.number || "").trim();

  const lineItems = extracted?.line_items || [];
  const invoiceLines = [];

  if (lineItems.length > 0) {
    for (const item of lineItems) {
      const itemVatInclusive = item.unit_price_includes_vat ?? globalVatInclusive;
      const rawPrice = Number(item.unit_price || item.amount || 0);
      const line = {
        name: String(item.description || "Line item").slice(0, 256),
        quantity: Number(item.quantity) || 1,
        price_unit: hasTax ? adjustPriceForTax(rawPrice, itemVatInclusive, taxPriceInclude, taxRate) : rawPrice
      };
      if (config.odooDefaults.defaultExpenseAccountId > 0) {
        line.account_id = Number(config.odooDefaults.defaultExpenseAccountId);
      }
      if (hasTax) {
        line.tax_ids = [[6, 0, taxIds]];
      }
      invoiceLines.push([0, 0, line]);
    }
  } else {
    const adjustedTotal = hasTax ? adjustPriceForTax(total, globalVatInclusive, taxPriceInclude, taxRate) : total;
    const line = {
      name: String(extracted?.expense_account_hint?.suggested_account_name || "OCR Vendor Bill").slice(0, 256),
      quantity: 1,
      price_unit: adjustedTotal
    };
    if (config.odooDefaults.defaultExpenseAccountId > 0) {
      line.account_id = Number(config.odooDefaults.defaultExpenseAccountId);
    }
    if (hasTax) {
      line.tax_ids = [[6, 0, taxIds]];
    }
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

async function attachCopyToBill(odoo, companyId, att, billId, docId) {
  if (!att?.datas) return;
  await odoo.create("ir.attachment", {
    name: att.name,
    mimetype: att.mimetype,
    datas: att.datas,
    res_model: "account.move",
    res_id: Number(billId),
    description: `Copied from documents.document#${docId} original_attachment#${att.id}`
  });

  // Keep original attached to documents record.
  await odoo.write("ir.attachment", [att.id], {
    res_model: "documents.document",
    res_id: Number(docId)
  });
}

async function linkDocumentToBill(odoo, companyId, docId, billId, logger) {
  const docRows = await odoo.searchRead(
    "documents.document",
    [["id", "=", Number(docId)]],
    ["id", "folder_id"],
    kwWithCompany(companyId, { limit: 1 })
  );
  const originalFolderId = docRows?.[0]?.folder_id
    ? (Array.isArray(docRows[0].folder_id) ? docRows[0].folder_id[0] : Number(docRows[0].folder_id))
    : 0;

  const vals = {};
  if (await documentsDocumentHasField(odoo, "res_model")) vals.res_model = "account.move";
  if (await documentsDocumentHasField(odoo, "res_id")) vals.res_id = Number(billId);
  if (await documentsDocumentHasField(odoo, "account_move_id")) vals.account_move_id = Number(billId);
  if (await documentsDocumentHasField(odoo, "invoice_id")) vals.invoice_id = Number(billId);
  if (originalFolderId) vals.folder_id = originalFolderId;

  if (Object.keys(vals).length) {
    await odoo.write("documents.document", [Number(docId)], vals);
  }

  if (originalFolderId) {
    try {
      const afterWrite = await odoo.searchRead(
        "documents.document",
        [["id", "=", Number(docId)]],
        ["id", "folder_id"],
        kwWithCompany(companyId, { limit: 1 })
      );
      const newFolderId = afterWrite?.[0]?.folder_id
        ? (Array.isArray(afterWrite[0].folder_id) ? afterWrite[0].folder_id[0] : Number(afterWrite[0].folder_id))
        : 0;
      if (newFolderId && newFolderId !== originalFolderId) {
        await odoo.write("documents.document", [Number(docId)], { folder_id: originalFolderId });
        if (logger) logger.info("Restored document folder after link.", { docId, originalFolderId, movedTo: newFolderId });
      }
    } catch (_) {}
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
    purchaseJournalId
  } = args;
  const attachmentId = m2oId(doc.attachment_id);
  if (!attachmentId) return { status: "skip", reason: "no_attachment" };

  const att = await loadAttachment(odoo, companyId, attachmentId);
  if (!att) return { status: "skip", reason: "attachment_not_found" };

  if (isProcessed(att.description, config.scan.processedMarkerPrefix, targetKey, doc.id)) {
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

  const currencyCode = String(extracted?.invoice?.currency || "").trim();
  const currencyId = await resolveCurrencyId(odoo, companyId, currencyCode);
  const taxIds = pickTaxIds(vatIds, extracted);
  const taxMeta = await getTaxMeta(odoo, companyId, taxIds);
  const billVals = buildBillVals(
    extracted,
    vendor.id,
    companyId,
    taxIds,
    purchaseJournalId,
    currencyId,
    taxMeta
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
  await attachCopyToBill(odoo, companyId, att, Number(billId), Number(doc.id));
  await linkDocumentToBill(odoo, companyId, Number(doc.id), Number(billId), logger);
  await safeMessagePost(
    odoo,
    companyId,
    "documents.document",
    doc.id,
    `✅ Draft Vendor Bill created: account.move #${billId}\nVendor=${vendor.name || "(unknown)"}`
  );
  if ((extracted?.warnings || []).length || Number(extracted?.vendor?.confidence || 0) < 0.9) {
    await safeMessagePost(
      odoo,
      companyId,
      "account.move",
      Number(billId),
      `⚠️ Manual review recommended.\nVendor confidence=${Number(extracted?.vendor?.confidence || 0)}\nWarnings:\n- ${(extracted?.warnings || []).join("\n- ") || "(none)"}`
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
  const docsSorted = docs
    .filter((d) => Number(d.id) > Number(state.last_doc_id || 0))
    .sort((a, b) => Number(a.id) - Number(b.id));

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
        purchaseJournalId: target.purchaseJournalId
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

  let docs = [];
  if (docId) {
    docs = await odoo.searchRead(
      "documents.document",
      [["id", "=", docId], ["is_folder", "=", false]],
      ["id", "name", "attachment_id", "folder_id", "company_id", "create_date"],
      kwWithCompany(companyId, { limit: 1 })
    );
  } else {
    docs = await odoo.searchRead(
      "documents.document",
      [["attachment_id", "=", attachmentId], ["is_folder", "=", false]],
      ["id", "name", "attachment_id", "folder_id", "company_id", "create_date"],
      kwWithCompany(companyId, { limit: 1, order: "id desc" })
    );
  }

  const doc = docs?.[0] || null;
  if (!doc) {
    throw new Error(
      docId
        ? `Document not found for doc_id=${docId}.`
        : `Document not found for attachment_id=${attachmentId}.`
    );
  }

  const result = await processOneDocument({
    logger,
    odoo,
    companyId,
    targetKey: target.targetKey,
    doc,
    vatIds: target.vatIds,
    purchaseJournalId: target.purchaseJournalId
  });

  return {
    ok: true,
    mode: "run-one",
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

async function runWorker({ logger }) {
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
