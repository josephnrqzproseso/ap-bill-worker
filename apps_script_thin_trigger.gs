/**
 * Thin trigger Apps Script.
 * Purpose: call Cloud Run worker once per schedule.
 */

const WORKER_URL = 'https://YOUR_CLOUD_RUN_URL/run';
const WORKER_SECRET = 'replace-me';

function pollApBillsViaCloudRun() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) return;
  try {
    const resp = UrlFetchApp.fetch(WORKER_URL, {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify({ source: 'apps-script-trigger' }),
      headers: {
        'x-worker-secret': WORKER_SECRET
      },
      muteHttpExceptions: true
    });
    Logger.log(resp.getResponseCode() + ' ' + resp.getContentText().slice(0, 1000));
  } finally {
    lock.releaseLock();
  }
}

function installCloudRunTriggerEvery5Min() {
  const fn = 'pollApBillsViaCloudRun';
  const triggers = ScriptApp.getProjectTriggers();
  for (const t of triggers) {
    if (t.getHandlerFunction() === fn) ScriptApp.deleteTrigger(t);
  }
  ScriptApp.newTrigger(fn).timeBased().everyMinutes(5).create();
}
