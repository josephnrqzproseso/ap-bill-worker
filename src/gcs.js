const { Storage } = require("@google-cloud/storage");

const storage = new Storage();

async function uploadObject(bucketName, objectName, buffer, contentType) {
  const file = storage.bucket(bucketName).file(objectName);
  await file.save(buffer, {
    contentType: contentType || "application/octet-stream",
    resumable: false
  });
}

async function downloadText(bucketName, objectName) {
  const file = storage.bucket(bucketName).file(objectName);
  const [bytes] = await file.download();
  return bytes.toString("utf8");
}

async function listObjects(bucketName, prefix) {
  const [files] = await storage.bucket(bucketName).getFiles({ prefix });
  return files.map((f) => ({ name: f.name }));
}

async function readJsonObject(bucketName, objectName, fallback = {}) {
  try {
    const text = await downloadText(bucketName, objectName);
    return JSON.parse(text);
  } catch (_err) {
    return fallback;
  }
}

async function writeJsonObject(bucketName, objectName, value) {
  const text = JSON.stringify(value || {});
  await uploadObject(bucketName, objectName, Buffer.from(text, "utf8"), "application/json");
}

module.exports = {
  uploadObject,
  downloadText,
  listObjects,
  readJsonObject,
  writeJsonObject
};
