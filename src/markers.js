function makeProcessedMarker(prefix, targetKey, docId, billId, originalDocName = "") {
  return `${prefix}${targetKey}|DOC=${docId}|BILL=${billId}|NAME=${String(originalDocName || "").replace(/\|/g, "/")}`;
}

function isProcessed(description, prefix, targetKey, docId) {
  const needle = `${prefix}${targetKey}|DOC=${docId}|`;
  return String(description || "").includes(needle);
}

function getProcessedBillId(description, prefix, targetKey, docId) {
  const text = String(description || "");
  const re = new RegExp(`${escapeRegExp(prefix + targetKey)}\\|DOC=${docId}\\|BILL=(\\d+)`);
  const match = text.match(re);
  return match ? Number(match[1]) : 0;
}

function makeOcrJobMarker(prefix, targetKey, docId, attId, opName, outputBase) {
  return `${prefix}${targetKey}|DOC=${docId}|ATT=${attId}|OP=${opName}|OUT=${outputBase}`;
}

function parseOcrJobMarker(description, prefix, targetKey, docId, attId) {
  const text = String(description || "");
  const base = `${prefix}${targetKey}|DOC=${docId}|ATT=${attId}|OP=`;
  const idx = text.indexOf(base);
  if (idx < 0) return null;
  const line = text.slice(idx).split("\n")[0];
  const parts = line.split("|");
  const opPart = parts.find((p) => p.startsWith("OP="));
  const outPart = parts.find((p) => p.startsWith("OUT="));
  if (!opPart || !outPart) return null;
  return {
    opName: opPart.slice(3),
    outputBase: outPart.slice(4)
  };
}

function appendMarker(description, marker) {
  const clean = String(description || "").trim();
  if (!clean) return marker;
  if (clean.includes(marker)) return clean;
  return `${clean}\n${marker}`;
}

function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

module.exports = {
  makeProcessedMarker,
  isProcessed,
  getProcessedBillId,
  makeOcrJobMarker,
  parseOcrJobMarker,
  appendMarker
};
