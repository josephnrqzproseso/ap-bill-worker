param(
  [Parameter(Mandatory = $true)][string]$ProjectId,
  [Parameter(Mandatory = $true)][string]$Region,
  [Parameter(Mandatory = $true)][string]$WorkerUrl,
  [Parameter(Mandatory = $true)][string]$WorkerSecret,
  [string]$JobName = "ap-bill-ocr-every-5m",
  [string]$Schedule = "*/5 * * * *",
  [string]$TimeZone = "Asia/Manila"
)

Write-Host "Creating/updating Cloud Scheduler job: $JobName"

$bodyFile = Join-Path $env:TEMP "scheduler_body.json"
[System.IO.File]::WriteAllText($bodyFile, '{"source":"cloud-scheduler"}')

gcloud scheduler jobs describe $JobName --project $ProjectId --location $Region 1>$null 2>$null
$exists = $LASTEXITCODE -eq 0

if ($exists) {
  gcloud scheduler jobs update http $JobName `
    --project $ProjectId `
    --location $Region `
    --schedule $Schedule `
    --time-zone $TimeZone `
    --uri "$WorkerUrl/run" `
    --http-method POST `
    --headers "Content-Type=application/json,x-worker-secret=$WorkerSecret" `
    --message-body-from-file=$bodyFile
} else {
  gcloud scheduler jobs create http $JobName `
    --project $ProjectId `
    --location $Region `
    --schedule $Schedule `
    --time-zone $TimeZone `
    --uri "$WorkerUrl/run" `
    --http-method POST `
    --headers "Content-Type=application/json,x-worker-secret=$WorkerSecret" `
    --message-body-from-file=$bodyFile
}

Remove-Item $bodyFile -ErrorAction SilentlyContinue

if ($LASTEXITCODE -ne 0) { throw "Cloud Scheduler job command failed" }
Write-Host "Cloud Scheduler job is ready."
