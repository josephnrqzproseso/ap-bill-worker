const { safeJsonParse, sleep } = require("./utils");

const RETRYABLE_STATUS = new Set([429, 500, 503]);
const MAX_RETRIES = 2;
const RETRY_BASE_MS = 3000;

async function geminiRequest(model, apiKey, body) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
    model
  )}:generateContent?key=${encodeURIComponent(apiKey)}`;

  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  const text = await resp.text();
  return { resp, text };
}

async function geminiWithRetryAndFallback(config, body, { throwOnFail = true } = {}) {
  const primary = config.gemini.model;
  const fallback = config.gemini.fallbackModel || "";
  const models = fallback && fallback !== primary ? [primary, fallback] : [primary];
  let lastError = null;

  for (const model of models) {
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      let resp, text;
      try {
        ({ resp, text } = await geminiRequest(model, config.gemini.apiKey, body));
      } catch (fetchErr) {
        lastError = fetchErr;
        if (attempt < MAX_RETRIES) {
          await sleep(RETRY_BASE_MS * (attempt + 1));
          continue;
        }
        break;
      }
      if (resp.ok) return { text, model };
      if (!RETRYABLE_STATUS.has(resp.status) || attempt === MAX_RETRIES) {
        lastError = new Error(`Gemini request failed: HTTP ${resp.status} ${text.slice(0, 600)}`);
        if (model === models[models.length - 1]) {
          if (throwOnFail) throw lastError;
          return null;
        }
        break;
      }
      await sleep(RETRY_BASE_MS * (attempt + 1));
    }
  }
  if (throwOnFail && lastError) throw lastError;
  return null;
}

const extractionSchema = {
  type: "object",
  properties: {
    vendor: {
      type: "object",
      properties: {
        name: { type: "string" },
        confidence: { type: "number" },
        source: { type: "string", description: "header|body|atp_printer_box|unknown" }
      },
      required: ["name", "confidence", "source"]
    },
    vendor_candidates: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          confidence: { type: "number" },
          source: { type: "string", description: "header|body|atp_printer_box|unknown" }
        },
        required: ["name", "confidence", "source"]
      }
    },
    vendor_details: {
      type: "object",
      properties: {
        tin: { type: "string" },
        branch_code: { type: "string" },
        address: { type: "string" },
        entity_type: { type: "string", description: "corporation|sole_proprietor|individual|unknown" },
        trade_name: { type: "string", description: "Business/trade name (DBA). For sole proprietors this is the shop/store name that differs from the owner's personal name" },
        proprietor_name: { type: "string", description: "Owner/proprietor personal name if entity is a sole proprietor (e.g. 'JOCELYN E. SANTOS' when trade name is 'JORJEL LAUNDRY SHOP')" }
      },
      required: ["tin", "branch_code", "address", "entity_type", "trade_name", "proprietor_name"]
    },
    expense_account_hint: {
      type: "object",
      properties: {
        category: { type: "string", description: "office_supplies|meals|repairs|rent|fuel|professional_fees|freight|other" },
        suggested_account_name: { type: "string" },
        confidence: { type: "number" },
        evidence: { type: "string" }
      },
      required: ["category", "suggested_account_name", "confidence", "evidence"]
    },
    invoice: {
      type: "object",
      properties: {
        number: { type: "string" },
        date: { type: "string", description: "YYYY-MM-DD" },
        date_confidence: { type: "number" },
        currency: { type: "string" }
      },
      required: ["number", "date", "date_confidence", "currency"]
    },
    vat: {
      type: "object",
      properties: {
        classification: { type: "string", description: "vatable|exempt|zero_rated|unknown" },
        goods_or_services: { type: "string", description: "goods|services|unknown" },
        vatable_base: { type: "number" },
        vatable_base_confidence: { type: "number" },
        vat_amount: { type: "number" },
        vat_amount_confidence: { type: "number" },
        exempt_amount: { type: "number" },
        exempt_amount_confidence: { type: "number" },
        zero_rated_amount: { type: "number" },
        zero_rated_amount_confidence: { type: "number" },
        evidence: { type: "string" }
      },
      required: [
        "classification", "goods_or_services",
        "vatable_base", "vatable_base_confidence",
        "vat_amount", "vat_amount_confidence",
        "exempt_amount", "exempt_amount_confidence",
        "zero_rated_amount", "zero_rated_amount_confidence",
        "evidence"
      ]
    },
    totals: {
      type: "object",
      properties: {
        grand_total: { type: "number", description: "Total amount due (final amount to pay, VAT-inclusive if applicable)" },
        grand_total_confidence: { type: "number" },
        tax_total: { type: "number" },
        tax_total_confidence: { type: "number" },
        net_total: { type: "number", description: "Total BEFORE VAT (vatable base / net of tax). If invoice only shows a VAT-inclusive total, compute net_total = grand_total / 1.12 for vatable invoices" },
        net_total_confidence: { type: "number" },
        vat_exempt_amount: { type: "number" },
        vat_exempt_amount_confidence: { type: "number" },
        zero_rated_amount: { type: "number" },
        zero_rated_amount_confidence: { type: "number" },
        amounts_are_vat_inclusive: { type: "boolean", description: "true if the grand_total and line item prices already include VAT (common in PH receipts/invoices)" }
      },
      required: [
        "grand_total", "grand_total_confidence",
        "tax_total", "tax_total_confidence",
        "net_total", "net_total_confidence",
        "vat_exempt_amount", "vat_exempt_amount_confidence",
        "zero_rated_amount", "zero_rated_amount_confidence",
        "amounts_are_vat_inclusive"
      ]
    },
    amount_candidates: {
      type: "array",
      items: {
        type: "object",
        properties: {
          label: { type: "string" },
          amount: { type: "number" },
          confidence: { type: "number" },
          snippet: { type: "string" }
        },
        required: ["label", "amount", "confidence", "snippet"]
      }
    },
    line_items: {
      type: "array",
      items: {
        type: "object",
        properties: {
          description: { type: "string" },
          quantity: { type: "number" },
          unit_price: { type: "number" },
          amount: { type: "number" },
          unit_price_includes_vat: { type: "boolean", description: "true if the unit_price shown on the invoice already includes VAT" },
          expense_category: { type: "string", description: "office_supplies|meals|repairs|rent|fuel|professional_fees|freight|utilities|inventory|other" }
        },
        required: ["description", "quantity", "unit_price", "amount", "unit_price_includes_vat", "expense_category"]
      }
    },
    warnings: { type: "array", items: { type: "string" } }
  },
  required: [
    "vendor", "vendor_candidates",
    "invoice",
    "vat",
    "totals",
    "amount_candidates",
    "line_items",
    "vendor_details",
    "expense_account_hint"
  ]
};

function buildPrompt(ocrText) {
  return `Extract a vendor bill/receipt for Accounts Payable.
Return JSON strictly matching the provided schema (no extra keys).
All confidence fields must be between 0 and 1.

CRITICAL PH RECEIPT RULES:
- The "ATP / BIR Permit / Printer's Accreditation / Printer info" box is NOT the vendor.
- Ignore names near keywords: "ATP", "BIR Permit", "Printer", "Accreditation", "Date issued", "O.R. No.", "VAT Reg. TIN" when those appear inside printer/ATP blocks.
- The vendor is the SELLER/ISSUER (usually top header near "OFFICIAL RECEIPT", "SALES INVOICE", or company address), not the printing company.

OUTPUT REQUIREMENTS:
- vendor.source must be one of: header|body|atp_printer_box|unknown
- vendor_candidates should include up to 5 plausible vendors with source + confidence.
- amount_candidates should list ALL important amounts you see with label + confidence + a short snippet where it came from.
- totals.* may be best guess, but if uncertain, lower confidence and add warnings.

AMOUNT INTEGRITY RULES (CRITICAL):
- NEVER "correct" a line item amount downward to match a smaller total. If qty × unit_price gives a larger number than the OCR total, the total OCR is likely wrong, not the line item.
- Handwritten amounts are often misread. Common OCR confusions: "0" vs empty space, "5" vs "S", missing trailing zeros (e.g. "1045" should be "10450" or "10500").
- Cross-check: qty × unit_price should equal the line amount. If the math works for one reading but not another, trust the one where the math works.
- When line item math (qty × unit_price) and the printed/written total disagree, prefer the LARGER amount if the smaller one looks like a truncation or missing digit.
- Put conflicting readings in amount_candidates with confidence scores so the system can audit them.
- NEVER silently drop trailing zeros from amounts. "10500" is NOT the same as "1050" or "1045".

HANDWRITTEN / LOW-QUALITY OCR RULES:
- Many PH receipts are handwritten. OCR of handwriting is unreliable.
- If the image is available, ALWAYS prefer reading the image directly over the OCR text for amounts, quantities, and item descriptions.
- Use the VENDOR NAME as strong context for item descriptions. E.g., a vendor named "FABRIC TRADING" is selling fabric/cloth/textile, so an unreadable item name is likely a fabric brand or type.
- Common handwriting misreads: "H" vs "N", "R" vs "N", "O" vs "0", "I" vs "1", "S" vs "5". When in doubt, pick the reading that makes semantic sense given the vendor context.

ACCOUNT SUGGESTION REQUIREMENTS:
- Populate expense_account_hint:
  - category: choose best matching category
  - suggested_account_name: a plausible expense account name (human-friendly, not an ID)
  - evidence: short snippet justifying the choice
- USE VENDOR NAME AS CONTEXT: If the vendor name contains keywords like "FABRIC", "GAS", "LUMBER", "HARDWARE", "ELECTRICAL", "FOOD", etc., use that to infer the expense category even if the line item description is unclear or handwritten.
  - "FABRIC TRADING" vendor → category: "inventory" or "supplies", suggested: "Raw Materials" or "Supplies"
  - "GAS STATION" vendor → category: "fuel"
  - "HARDWARE" vendor → category: "supplies" or "repairs"
  - "FOOD" / "CATERING" vendor → category: "meals"

VENDOR DETAIL REQUIREMENTS (PH):
- vendor_details.tin: extract TIN if present (keep formatting)
- vendor_details.branch_code: extract branch code if present
- vendor_details.address: extract issuer address if present
- vendor_details.entity_type: classify the vendor:
  - "corporation" if the name ends with Inc., Corp., Co., LLC, Corporation, etc.
  - "sole_proprietor" if there is BOTH a trade/business name AND a personal owner name (e.g. "Prop.", "Owner:", or a personal name under/near a business name)
  - "individual" if the vendor is clearly a person with no business name
  - "unknown" if you cannot determine
- vendor_details.trade_name: the business/trade name (DBA). For sole proprietors, this is the shop name (e.g. "JORJEL LAUNDRY SHOP"). For corporations, same as vendor.name. Empty if not applicable.
- vendor_details.proprietor_name: the owner/proprietor's personal name if entity is sole_proprietor. Look for keywords like "Prop.", "Owner", "Proprietor", or a personal name printed below/near the business name. Empty string if not a sole proprietor or not found.
  Examples:
  - "JORJEL LAUNDRY SHOP" with "JOCELYN E. SANTOS - Prop." → trade_name="JORJEL LAUNDRY SHOP", proprietor_name="JOCELYN E. SANTOS", entity_type="sole_proprietor"
  - "NONVAT Reg. TIN: 740-326-198-00000" → this is the TIN, not the proprietor
  - "SM PRIME HOLDINGS, INC." → entity_type="corporation", trade_name="SM PRIME HOLDINGS, INC.", proprietor_name=""

PH VAT RULES (IMPORTANT):
- Decide vat.classification:
  - "exempt" if receipt shows "VAT Exempt", "VAT-ExEMPT", or has a VAT-exempt amount column/value.
  - "zero_rated" if receipt shows "Zero Rated", "0% ZR", or similar.
  - "vatable" if receipt shows VAT amount, "VAT Sales", "Vatable Sales", or indicates 12% VAT.
  - "unknown" if none of the above.
- Decide vat.goods_or_services:
  - "services" if wording indicates services (professional fees, rentals, repairs, consulting, labor, contractors, etc.).
  - "goods" if it's primarily goods/products (supplies, inventory, materials).
  - "unknown" if unclear.
- Populate these amounts if present:
  - vat.vat_amount
  - vat.vatable_base
  - vat.exempt_amount
  - vat.zero_rated_amount
- Put the key supporting text into vat.evidence.

Also copy exempt/zero-rated amounts into:
- totals.vat_exempt_amount, totals.zero_rated_amount (if known).

VAT-INCLUSIVE PRICE DETECTION (CRITICAL):
- Most PH receipts/invoices show prices that ALREADY INCLUDE 12% VAT.
- Set totals.amounts_are_vat_inclusive = true if the line item prices and grand_total include VAT.
  - Indicators: "Total Sales (VAT Inclusive)", or the grand total equals vatable_base + vat_amount, or line prices × qty = grand total and a separate VAT amount is shown.
  - If the invoice shows a separate "Vatable Sales" (net) amount and a "VAT Amount", the unit prices are typically VAT-inclusive.
- Set line_items[].unit_price_includes_vat = true for each line where the unit price includes VAT.
- totals.net_total should ALWAYS be the VAT-exclusive amount (before tax). If only a VAT-inclusive total is shown, compute: net_total = grand_total / 1.12 for vatable invoices.
- totals.grand_total should be the final amount due (what the buyer actually pays).

OCR TEXT:
${ocrText || "(no OCR text available)"}

LINE ITEM CATEGORIZATION:
- For each line_items[] entry, set expense_category to the best matching category based on the item description AND vendor context:
  office_supplies, meals, repairs, rent, fuel, professional_fees, freight, utilities, inventory, supplies, other
- Examples: LPG/gas/diesel -> "fuel", paper/ink/toner -> "office_supplies", electricity/water -> "utilities",
  consulting/legal/audit -> "professional_fees", food/catering -> "meals", shipping/delivery -> "freight",
  fabric/cloth/textile/thread -> "inventory" or "supplies", hardware/tools -> "supplies", lumber/cement -> "inventory"
- If the item description is unreadable or a brand name (e.g. "Hiroshi #7" from a fabric vendor), use the VENDOR NAME to determine the category. A fabric vendor sells fabric → "inventory" or "supplies", NOT "other".

Rules:
- invoice.date must be YYYY-MM-DD (best guess; if unknown, empty string + low confidence).
- line_items may be [] if not confident.
- NEVER default to "other" category if the vendor name gives a clear hint about what they sell.`;
}

async function extractInvoiceWithGemini(ocrText, config, attachment) {
  const parts = [{ text: buildPrompt(ocrText) }];

  const mimetype = String(attachment?.mimetype || "").toLowerCase();
  if (mimetype.startsWith("image/") && attachment?.datas) {
    parts.push({
      inlineData: { mimeType: mimetype, data: attachment.datas }
    });
  }

  const body = {
    contents: [{ role: "user", parts }],
    generationConfig: {
      responseMimeType: "application/json",
      responseSchema: extractionSchema
    }
  };

  const result = await geminiWithRetryAndFallback(config, body, { throwOnFail: true });
  const data = safeJsonParse(result.text, {});
  const raw =
    data?.candidates?.[0]?.content?.parts?.[0]?.text ||
    data?.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("\n") ||
    "{}";

  const extracted = safeJsonParse(raw, {});
  if (!extracted || typeof extracted !== "object") return {};
  return extracted;
}

const accountCandidateSchema = {
  type: "object",
  properties: {
    account_id: { type: "number", description: "Account ID from the provided list" },
    account_code: { type: "string", description: "Account code (e.g. '510100')" },
    account_name: { type: "string", description: "Account name (e.g. 'Office Supplies')" },
    confidence: { type: "number", description: "0-1 confidence" }
  },
  required: ["account_id", "account_code", "account_name", "confidence"]
};

const accountAssignmentSchema = {
  type: "object",
  properties: {
    assignments: {
      type: "array",
      items: {
        type: "object",
        properties: {
          line_index: { type: "number", description: "0-based index into the line_items array" },
          account_id: { type: "number", description: "The best matching account ID from the provided list" },
          account_code: { type: "string", description: "The code of the chosen account" },
          account_name: { type: "string", description: "The name of the chosen account" },
          confidence: { type: "number", description: "0-1 confidence in the match" },
          reasoning: { type: "string", description: "Brief explanation of why this account was chosen" },
          alternatives: {
            type: "array",
            description: "2nd and 3rd best account choices, ordered by preference",
            items: accountCandidateSchema
          }
        },
        required: ["line_index", "account_id", "account_code", "account_name", "confidence", "reasoning", "alternatives"]
      }
    },
    bill_level_account_id: { type: "number", description: "Best overall account_id if only one account is used for the whole bill" },
    bill_level_account_code: { type: "string" },
    bill_level_account_name: { type: "string" },
    bill_level_confidence: { type: "number" }
  },
  required: ["assignments", "bill_level_account_id", "bill_level_account_code", "bill_level_account_name", "bill_level_confidence"]
};

async function assignAccountsWithGemini(extracted, expenseAccounts, config, industry, ocrText) {
  if (!expenseAccounts?.length) return null;

  const lineItems = extracted?.line_items || [];
  const hint = extracted?.expense_account_hint || {};

  const accountList = expenseAccounts
    .map((a) => `  ${a.id}: [${a.code}] ${a.name}`)
    .join("\n");

  const lineDesc = lineItems.length
    ? lineItems.map((li, i) =>
      `  ${i}: "${li.description || "?"}" (category: ${li.expense_category || hint.category || "other"}, amount: ${li.amount || 0})`
    ).join("\n")
    : `  0: "${hint.suggested_account_name || "Vendor Bill"}" (category: ${hint.category || "other"}, amount: ${extracted?.totals?.grand_total || 0})`;

  const industryHint = String(industry || "").trim();
  const industrySection = industryHint
    ? `\nCOMPANY INDUSTRY: ${industryHint}\nUse industry context to decide COST OF REVENUE vs OPERATING EXPENSE:\n- If the purchase is directly used to produce/deliver the company's core product or service, use Cost of Revenue / Cost of Sales / COGS accounts.\n- If the purchase is for back-office, admin, or support operations, use Operating Expense accounts.\n- Examples by industry:\n  - Restaurant/food: ingredients, condiments, packaging → Cost of Revenue. Cleaning supplies, office supplies → Operating Expense.\n  - Retail/trading: merchandise for resale → Cost of Sales. Store supplies, bags → Cost of Sales. Office supplies → Operating Expense.\n  - Manufacturing: raw materials, factory supplies → Cost of Revenue. Office supplies → Operating Expense.\n  - Services/consulting: subcontractor fees, project materials → Cost of Revenue. Office rent, admin supplies → Operating Expense.\n  - Laundry: detergent, fabric softener → Cost of Revenue. Store signage → Operating Expense.\n  - Construction: cement, lumber, rebar → Cost of Revenue. Office supplies → Operating Expense.\n`
    : "";

  const ocrSection = ocrText
    ? `\nORIGINAL OCR TEXT (use for additional context about what was purchased):\n${String(ocrText).slice(0, 3000)}\n`
    : "";

  const prompt = `You are a senior accountant. Match each invoice line item to the BEST expense account from the chart of accounts.

AVAILABLE EXPENSE ACCOUNTS:
${accountList}

LINE ITEMS TO CLASSIFY:
${lineDesc}

Bill-level category hint: ${hint.category || "other"}
Bill-level suggested account name: ${hint.suggested_account_name || "(none)"}
Vendor name: ${extracted?.vendor?.name || "(unknown)"}
Vendor entity type: ${extracted?.vendor_details?.entity_type || "unknown"}
${industrySection}${ocrSection}
RULES (CRITICAL - follow strictly):

1. SPECIFICITY IS KING: Always pick the MOST SPECIFIC matching account. NEVER pick generic/catch-all accounts like "Admin Expense", "Administrative Expense", "Miscellaneous Expense", "General Expense", "Other Expense", or "Sundry Expense" unless absolutely NO specific account matches.

2. BANNED ACCOUNTS - DO NOT USE THESE unless literally zero other accounts could work:
   - Any account whose name contains: "Admin", "Administrative", "Miscellaneous", "General Expense", "Other Expense", "Sundry"
   - Any account with code starting with "620" that is a generic catch-all
   - If you MUST use one of these, set confidence below 0.3 and explain why no specific account fits in reasoning.

3. MATCH BY ITEM DESCRIPTION FIRST, THEN USE VENDOR NAME AS CONTEXT:
   - Match based on WHAT was purchased.
   - If the item description is unclear, a brand name, or gibberish (bad OCR), USE THE VENDOR NAME to determine the account:
     - Vendor "FABRIC TRADING" / "TEXTILE" → Supplies / Raw Materials / Cost of Sales
     - Vendor "HARDWARE" → Supplies / Repairs & Maintenance
     - Vendor "GAS STATION" / "FUEL" → Fuel & Oil
     - Vendor "LUMBER" / "CONSTRUCTION" → Raw Materials / Supplies
   - "TABLE CLOTH" from any vendor → Supplies / Housekeeping Supplies / Office Supplies
   - "LPG REFILL 11KG" → Fuel & Oil / Gas & Oil / Fuel Expense
   - "BOND PAPER A4" → Office Supplies / Stationery
   - "TONER CARTRIDGE" → Office Supplies / Printing Supplies
   - "ELECTRICITY BILL" → Utilities / Power & Light
   - "WATER BILL" → Utilities / Water
   - "INTERNET" → Communication / Telecommunications
   - "JANITORIAL SUPPLIES" → Janitorial / Cleaning Supplies
   - "FOOD / MEALS / CATERING" → Meals & Entertainment / Representation
   - "LEGAL FEES / AUDIT FEES" → Professional Fees
   - "SHIPPING / DELIVERY" → Freight / Shipping & Delivery
   - "RENT / LEASE" → Rent Expense / Lease
   - "INSURANCE" → Insurance Expense
   - "REPAIRS / MAINTENANCE" → Repairs & Maintenance
   - "GASOLINE / DIESEL / FUEL" → Fuel & Oil / Transportation
   - "COURIER / GRAB / LALAMOVE" → Freight / Delivery / Transportation
   - "PACKAGING / BOXES / TAPE" → Packaging Supplies (or Cost of Sales if for product)
   - "FABRIC / CLOTH / THREAD" → Raw Materials / Supplies (or Cost of Sales for manufacturers)
   - "CLEANING / DETERGENT / BLEACH" → Janitorial Supplies (or Cost of Revenue for laundry/cleaning business)
   - "UNIFORM / WORKWEAR" → Uniforms / Employee Benefits

4. COST OF REVENUE vs OPERATING EXPENSE:
   - If the item is directly consumed to produce/deliver the company's main product or service → prefer Cost of Sales / COGS / Cost of Revenue accounts.
   - If the item is for office/admin/back-office operations → prefer Operating Expense accounts.
   - When in doubt and no industry context, treat as Operating Expense.

5. CONFIDENCE SCORING:
   - 0.9-1.0: Account name directly matches item (e.g. "Fuel & Oil" for "DIESEL")
   - 0.7-0.9: Account is clearly the right category (e.g. "Office Supplies" for "BOND PAPER")
   - 0.5-0.7: Reasonable guess, multiple accounts could fit
   - 0.3-0.5: Generic fallback used because nothing specific matches
   - Below 0.3: Wild guess

6. For EACH assignment you MUST also return:
   - account_code: the code of your chosen account (copy exactly from the list)
   - account_name: the name of your chosen account (copy exactly from the list)
   - alternatives: your 2nd and 3rd best choices with their account_id, account_code, account_name, and confidence

7. bill_level fields: Pick the single best account if only one account were used for the entire bill. Include bill_level_account_code and bill_level_account_name.`;

  const body = {
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    generationConfig: {
      responseMimeType: "application/json",
      responseSchema: accountAssignmentSchema
    }
  };

  const result = await geminiWithRetryAndFallback(config, body, { throwOnFail: false });
  if (!result) return null;

  const data = safeJsonParse(result.text, {});
  const raw =
    data?.candidates?.[0]?.content?.parts?.[0]?.text ||
    data?.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("\n") ||
    "{}";
  return safeJsonParse(raw, null);
}

module.exports = {
  extractInvoiceWithGemini,
  assignAccountsWithGemini
};
