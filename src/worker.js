async function runOne({ logger, payload = {} }) {
  const timeStart = new Date().toISOString();
  clearPerRunCaches();
  const targets = await getTargets(logger);
  if (!targets.length) {
    throw new Error("No enabled routing rows available.");
  }

  const targetKeyInput = String(payload.target_key || "").trim();
  const docId = Number(payload.doc_id || payload.document_id || payload.id || 0);
  const attachmentId = Number(payload.attachment_id || 0);
  const messageBody = String(payload.message_body || "").trim();
  if (!docId && !attachmentId) {
    throw new Error("run-one requires either doc_id or attachment_id.");
  }

  let userHint = "";
  let isBotCommand = false;
  let isForce = false;
  let isRetry = false;

  if (messageBody) {
    const plainText = messageBody.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
    isBotCommand = /@(bot|ocr|worker|ai)\b/i.test(plainText);
    isForce = isBotCommand && /\bforce\b/i.test(plainText);
    isRetry = isBotCommand && /\bretry|run\b/i.test(plainText);
    
    if (isBotCommand) {
      userHint = plainText.replace(/@(bot|ocr|worker|ai)\s*(retry|run|force)?\s*,?\s*/gi, "").trim();
    }
  }

  const forceReprocess = isForce || isRetry || !!(payload.reprocess || payload.force_reprocess);

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
      [["id", "=", docId]],
      docFields,
      kwWithCompany(companyId, { limit: 1 })
    );
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
      [["attachment_id", "=", attachmentId]],
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

  const resolvedVatIds = await pickVatTaxesForCompany(odoo, companyId);

  let apFolderId = Number(target.apFolderId || 0);
  let useIsFolder = false;
  if (!apFolderId) {
    const parentName = String(target.apFolderParent ?? "").trim() || undefined;
    const r = await resolveApFolderId(odoo, companyId, { parentFolderName: parentName });
    apFolderId = r.apFolderId;
    useIsFolder = r.useIsFolder;
  }

  const result = await processOneDocument({
    logger,
    odoo,
    companyId,
    targetKey: target.targetKey,
    doc,
    resolvedVatIds,
    purchaseJournalId: target.purchaseJournalId,
    industry: target.industry,
    reprocess: forceReprocess,
    apFolderId,
    useIsFolder,
    userHint
  });

  return {
    ok: true,
    mode: "run-one",
    time_start: timeStart,
    time_completed: new Date().toISOString(),
    targetKey: target.targetKey,
    doc: { id: Number(doc.id), name: String(doc.name || ""), attachment_id: m2oId(doc.attachment_id) },
    result
  };
}