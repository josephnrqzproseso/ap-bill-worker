param(
  [Parameter(Mandatory = $true)][string]$ProjectId,
  [Parameter(Mandatory = $true)][string]$Region,
  [string]$ServiceName = "ap-bill-ocr-worker",
  [string]$ServiceAccount = "",
  [string]$Image = "",
  [string]$EnvVarsFile = "",
  [string]$SetSecrets = ""
)

$ProjectId = $ProjectId.Trim()
$Region = $Region.Trim()
$ServiceName = $ServiceName.Trim()
$Image = $Image.Trim()

if (-not $ProjectId) { throw "ProjectId is required." }
if (-not $Region) { throw "Region is required." }
if (-not $ServiceName -and -not $Image) {
  throw "ServiceName is empty. Pass -ServiceName or a full -Image."
}

if (-not $Image) {
  $Image = "$Region-docker.pkg.dev/$ProjectId/ap-bill/$ServiceName:latest"
}

if ($Image -notmatch "^[a-z0-9\.\-]+\/[a-z0-9\.\-]+\/[a-z0-9\.\-_]+\/[a-z0-9\.\-_]+:[A-Za-z0-9_\.\-]+$") {
  throw "Invalid image reference: $Image"
}

Write-Host "Using ProjectId: $ProjectId"
Write-Host "Using Region: $Region"
Write-Host "Using ServiceName: $ServiceName"
Write-Host "Building container image: $Image"
gcloud builds submit --project $ProjectId --tag $Image .
if ($LASTEXITCODE -ne 0) { throw "Cloud Build failed" }

$deployArgs = @(
  "run", "deploy", $ServiceName,
  "--project", $ProjectId,
  "--region", $Region,
  "--image", $Image,
  "--platform", "managed",
  "--allow-unauthenticated",
  "--port", "8080",
  "--timeout", "1800",
  "--memory", "1Gi",
  "--cpu", "1"
)

if ($ServiceAccount) {
  $deployArgs += @("--service-account", $ServiceAccount)
}
if ($EnvVarsFile) {
  $deployArgs += @("--env-vars-file", $EnvVarsFile)
}
if ($SetSecrets) {
  $deployArgs += @("--set-secrets", $SetSecrets)
}

Write-Host "Deploying Cloud Run service..."
gcloud @deployArgs
if ($LASTEXITCODE -ne 0) { throw "Cloud Run deploy failed" }

Write-Host "Deployed successfully."
