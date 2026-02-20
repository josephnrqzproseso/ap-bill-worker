const { safeJsonParse } = require("./utils");

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
        entity_type: { type: "string", description: "person|company|unknown" }
      },
      required: ["tin", "branch_code", "address", "entity_type"]
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
        grand_total: { type: "number" },
        grand_total_confidence: { type: "number" },
        tax_total: { type: "number" },
        tax_total_confidence: { type: "number" },
        net_total: { type: "number" },
        net_total_confidence: { type: "number" },
        vat_exempt_amount: { type: "number" },
        vat_exempt_amount_confidence: { type: "number" },
        zero_rated_amount: { type: "number" },
        zero_rated_amount_confidence: { type: "number" }
      },
      required: [
        "grand_total", "grand_total_confidence",
        "tax_total", "tax_total_confidence",
        "net_total", "net_total_confidence",
        "vat_exempt_amount", "vat_exempt_amount_confidence",
        "zero_rated_amount", "zero_rated_amount_confidence"
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
          amount: { type: "number" }
        },
        required: ["description", "quantity", "unit_price", "amount"]
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

ACCOUNT SUGGESTION REQUIREMENTS:
- Populate expense_account_hint:
  - category: choose best matching category
  - suggested_account_name: a plausible expense account name (human-friendly, not an ID)
  - evidence: short snippet justifying the choice

VENDOR DETAIL REQUIREMENTS (PH):
- vendor_details.tin: extract TIN if present (keep formatting)
- vendor_details.branch_code: extract branch code if present
- vendor_details.address: extract issuer address if present
- vendor_details.entity_type: person|company|unknown (best guess from wording)

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

OCR TEXT:
${ocrText || "(no OCR text available)"}

Rules:
- invoice.date must be YYYY-MM-DD (best guess; if unknown, empty string + low confidence).
- line_items may be [] if not confident.`;
}

async function extractInvoiceWithGemini(ocrText, config, attachment) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
    config.gemini.model
  )}:generateContent?key=${encodeURIComponent(config.gemini.apiKey)}`;

  const parts = [{ text: buildPrompt(ocrText) }];

  // Include image bytes for better accuracy (same as original script)
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

  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  const text = await resp.text();
  if (!resp.ok) throw new Error(`Gemini request failed: HTTP ${resp.status} ${text.slice(0, 600)}`);
  const data = safeJsonParse(text, {});
  const raw =
    data?.candidates?.[0]?.content?.parts?.[0]?.text ||
    data?.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("\n") ||
    "{}";

  const extracted = safeJsonParse(raw, {});
  if (!extracted || typeof extracted !== "object") return {};
  return extracted;
}

module.exports = {
  extractInvoiceWithGemini
};
