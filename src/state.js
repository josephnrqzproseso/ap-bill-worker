const { readJsonObject, writeJsonObject } = require("./gcs");

function stateObjectName(config, targetKey) {
  return `${config.gcs.statePrefix}/${encodeURIComponent(targetKey)}.json`;
}

async function loadState(config, targetKey) {
  if (!config.gcs.stateBucket) return { last_doc_id: 0 };
  return readJsonObject(config.gcs.stateBucket, stateObjectName(config, targetKey), {
    last_doc_id: 0
  });
}

async function saveState(config, targetKey, state) {
  if (!config.gcs.stateBucket) return;
  await writeJsonObject(config.gcs.stateBucket, stateObjectName(config, targetKey), state || {});
}

module.exports = {
  loadState,
  saveState
};
