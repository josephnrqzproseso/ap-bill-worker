const { getAccessToken } = require("./gcp-auth");
const { uploadObject, listObjects, downloadText } = require("./gcs");
const { sleep, safeJsonParse } = require("./utils");

async function ocrImageViaVision(buffer, config) {
  const accessToken = await getAccessToken();
  const req = {
    requests: [
      {
        image: { content: buffer.toString("base64") },
        features: [{ type: "DOCUMENT_TEXT_DETECTION" }],
        imageContext: { languageHints: config.scan.visionLangHints }
      }
    ]
  };

  const url = "https://vision.googleapis.com/v1/images:annotate";
  const first = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(req)
  });
  const firstText = await first.text();
  if (!first.ok) throw new Error(`Vision annotate failed: HTTP ${first.status} ${firstText.slice(0, 600)}`);
  const firstData = safeJsonParse(firstText, {});
  let text = firstData?.responses?.[0]?.fullTextAnnotation?.text || "";

  if (text.trim().length >= config.scan.ocrMinTextLen) return text;

  req.requests[0].features = [{ type: "TEXT_DETECTION" }];
  const second = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(req)
  });
  const secondText = await second.text();
  if (!second.ok) throw new Error(`Vision fallback failed: HTTP ${second.status} ${secondText.slice(0, 600)}`);
  const secondData = safeJsonParse(secondText, {});
  return (
    secondData?.responses?.[0]?.fullTextAnnotation?.text ||
    secondData?.responses?.[0]?.textAnnotations?.[0]?.description ||
    text ||
    ""
  );
}

async function startPdfOcrJob(pdfBuffer, config) {
  const bucket = config.gcs.bucket;
  const inputName = `${config.gcs.inputPrefix}/bill-${Date.now()}-${Math.floor(Math.random() * 1e9)}.pdf`;
  const outputBase = `${config.gcs.outputPrefix}/ocr-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;

  await uploadObject(bucket, inputName, pdfBuffer, "application/pdf");

  const accessToken = await getAccessToken();
  const url = "https://vision.googleapis.com/v1p2beta1/files:asyncBatchAnnotate";
  const payload = {
    requests: [
      {
        inputConfig: {
          gcsSource: { uri: `gs://${bucket}/${inputName}` },
          mimeType: "application/pdf"
        },
        features: [{ type: "DOCUMENT_TEXT_DETECTION" }],
        outputConfig: {
          gcsDestination: { uri: `gs://${bucket}/${outputBase}/` }
        }
      }
    ]
  };

  const resp = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });
  const text = await resp.text();
  if (!resp.ok) throw new Error(`Vision async start failed: HTTP ${resp.status} ${text.slice(0, 600)}`);
  const data = safeJsonParse(text, {});
  if (!data?.name) throw new Error(`Vision async did not return operation name: ${text.slice(0, 600)}`);
  return { opName: data.name, outputBase };
}

async function tryFinishPdfOcrJob(opName, outputBase, config) {
  const accessToken = await getAccessToken();
  const opPath = opName.startsWith("projects/") ? opName : String(opName).replace(/^\/+/, "");
  const opUrl = `https://vision.googleapis.com/v1/${opPath}`;
  const opResp = await fetch(opUrl, {
    method: "GET",
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  const opText = await opResp.text();
  if (!opResp.ok) throw new Error(`Vision operation check failed: HTTP ${opResp.status} ${opText.slice(0, 600)}`);
  const op = safeJsonParse(opText, {});
  if (!op.done) return { done: false, text: "" };
  if (op.error) throw new Error(`Vision operation error: ${JSON.stringify(op.error)}`);

  const objects = await listObjects(config.gcs.bucket, `${outputBase}/`);
  const jsonObjects = objects.filter((o) => o.name.toLowerCase().endsWith(".json")).slice(0, 200);
  let pages = 0;
  let combined = "";

  for (const obj of jsonObjects) {
    const payload = safeJsonParse(await downloadText(config.gcs.bucket, obj.name), {});
    const responses = payload.responses || [];
    for (const r of responses) {
      const text = r?.fullTextAnnotation?.text || "";
      if (!text) continue;
      combined += (combined ? "\n\n" : "") + text;
      pages += 1;
      if (pages >= config.scan.pdfOcrMaxPages) break;
    }
    if (pages >= config.scan.pdfOcrMaxPages) break;
  }

  return { done: true, text: combined };
}

async function ocrTextForAttachment(attachment, config, logger) {
  const mimetype = String(attachment.mimetype || "").toLowerCase();
  const buffer = Buffer.from(attachment.datas || "", "base64");

  if (mimetype.startsWith("image/")) {
    return ocrImageViaVision(buffer, config);
  }

  if (mimetype === "application/pdf") {
    const { opName, outputBase } = await startPdfOcrJob(buffer, config);
    for (let i = 0; i < 60; i += 1) {
      const res = await tryFinishPdfOcrJob(opName, outputBase, config);
      if (res.done) return res.text || "";
      await sleep(2000);
    }
    logger.warn("Vision PDF OCR timed out waiting for completion.", { opName, outputBase });
    return "";
  }

  return "";
}

module.exports = {
  ocrTextForAttachment
};
