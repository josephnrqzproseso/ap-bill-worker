# AP Bill OCR Worker (Cloud Run)

This service moves the heavy AP bill OCR flow out of Google Apps Script to avoid Apps Script quotas.

## What this implements

- Cloud Run worker with `GET/POST /run` HTTP endpoint.
- Routing read from Google Sheets (`ProjectRouting`) via Sheets API.
- Odoo XML-RPC execution (`authenticate`, `execute_kw`, `search_read`, `create`, `write`).
- OCR path:
  - image files -> Vision `images:annotate`
  - PDF files -> Vision async OCR through GCS staging
- Gemini structured extraction for invoice fields.
- Vendor lookup, duplicate check, bill create, and processed markers.
- Optional cursor state storage in GCS per target key.
- Thin Apps Script trigger option (`apps_script_thin_trigger.gs`) for hybrid mode.

## Folder layout

- `src/server.js` - HTTP server and run lock.
- `src/worker.js` - orchestration and business flow.
- `src/odoo.js` - XML-RPC client wrapper for Odoo.
- `src/vision.js` - Vision OCR helpers.
- `src/gemini.js` - Gemini structured extraction call.
- `src/sheets.js` - routing loader from Google Sheets.
- `src/state.js` - state load/save from GCS object.
- `apps_script_thin_trigger.gs` - optional minimal Apps Script trigger.
- `deploy_cloud_run.ps1` - build and deploy helper.
- `create_scheduler_job.ps1` - Cloud Scheduler helper.

## Environment variables

Copy `.env.example` to `.env` and fill values.

Required:

- `SHEETS_SPREADSHEET_ID`
- `GEMINI_API_KEY`
- `GCS_BUCKET`

Strongly recommended:

- `WORKER_SHARED_SECRET` (required if endpoint is exposed)
- `STATE_BUCKET` (for cross-run cursor state)
- `DEFAULT_EXPENSE_ACCOUNT_ID` (fallback account for invoice line)

## Local run

1. Install Node.js 20+.
2. Install dependencies:
   - `npm install`
3. Start:
   - `npm start`
4. Health check:
   - `GET http://localhost:8080/healthz`
5. Trigger run:
   - `POST http://localhost:8080/run` with header `x-worker-secret`.

## Deploy to Cloud Run

Use `deploy_cloud_run.ps1`:

```powershell
.\deploy_cloud_run.ps1 -ProjectId "<project-id>" -Region "<region>" -ServiceName "ap-bill-ocr-worker" -ServiceAccount "<sa>@<project>.iam.gserviceaccount.com"
```

Then create scheduler:

```powershell
.\create_scheduler_job.ps1 -ProjectId "<project-id>" -Region "<region>" -WorkerUrl "https://<service-url>" -WorkerSecret "<secret>"
```

## IAM and API requirements

Enable APIs:

- Cloud Run
- Cloud Build
- Cloud Scheduler
- Vision API
- Cloud Storage
- Sheets API

Service account permissions:

- `roles/run.invoker` (if secured invocation is used)
- `roles/storage.objectAdmin` (for OCR staging and state objects)
- `roles/visionai.editor` or equivalent Vision usage role
- Sheets read access to your routing spreadsheet (share the sheet with SA email)

## Cutover strategy

1. Deploy worker and run it manually on a test routing row.
2. Verify created Odoo bills match expected values.
3. Enable Cloud Scheduler or import `apps_script_thin_trigger.gs`.
4. Disable the heavy trigger in your old Apps Script.
5. Keep old script for fallback until new pipeline is stable.

## Notes on parity

This implementation ports the core behavior from your Apps Script:

- per-target polling
- OCR and extraction
- idempotency marker write-back to `ir.attachment.description`

If you need strict one-to-one parity with every helper from the original script (for example vendor rules, deep tax heuristics, and exact account scoring), extend `src/worker.js` with those functions and keep the same naming to simplify verification.


$baseUrl  = "https://proseso-accounting-test.odoo.com"
$db       = "proseso-accounting-test"
$login    = "joseph.proseso@gmail.com"
$password = "Papaya3562!"

$endpoint = "$baseUrl/jsonrpc"

# 1) Auth
$authPayload = @{
  jsonrpc = "2.0"
  method  = "call"
  params  = @{
    service = "common"
    method  = "authenticate"
    args    = @($db, $login, $password, @{})
  }
  id = 1
} | ConvertTo-Json -Depth 10

$auth = Invoke-RestMethod -Uri $endpoint -Method Post -ContentType "application/json" -Body $authPayload
$uid = $auth.result

# 2) Search documents (latest 20)
$searchPayload = @{
  jsonrpc = "2.0"
  method  = "call"
  params  = @{
    service = "object"
    method  = "execute_kw"
    args    = @(
      $db,
      $uid,
      $password,
      "documents.document",
      "search_read",
      @(@(@("is_folder","=", $false), @("attachment_id","!=", $false))),
      @{ fields = @("id","name","folder_id","attachment_id","create_date"); limit = 20; order = "id desc" }
    )
  }
  id = 2
} | ConvertTo-Json -Depth 20

$docs = Invoke-RestMethod -Uri $endpoint -Method Post -ContentType "application/json" -Body $searchPayload
$docs.result | Select-Object id,name,create_date