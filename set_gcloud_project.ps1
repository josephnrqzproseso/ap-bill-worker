# Set gcloud active project from this workspace's .env (GCP_PROJECT_ID).
# Run when you open this workspace so gcloud commands use the right project.
$envPath = Join-Path $PSScriptRoot ".env"
if (-not (Test-Path $envPath)) {
  Write-Host "No .env found. Copy .env.example to .env and set GCP_PROJECT_ID."
  exit 1
}
$line = Get-Content $envPath | Where-Object { $_ -match '^\s*GCP_PROJECT_ID=(.+)$' } | Select-Object -First 1
if (-not $line) {
  Write-Host ".env has no GCP_PROJECT_ID. Add: GCP_PROJECT_ID=your-gcp-project-id"
  exit 1
}
$projectId = ($line -replace '^\s*GCP_PROJECT_ID=(.+)$', '$1').Trim()
if ([string]::IsNullOrWhiteSpace($projectId) -or $projectId -eq 'your-gcp-project-id') {
  Write-Host "Set GCP_PROJECT_ID in .env to your actual GCP project ID."
  exit 1
}
& gcloud config set project $projectId
if ($LASTEXITCODE -ne 0) { exit 1 }
Write-Host "gcloud project set to: $projectId"

# Align Application Default Credentials quota project to avoid quota/billing surprises
& gcloud auth application-default set-quota-project $projectId
if ($LASTEXITCODE -eq 0) { Write-Host "ADC quota project set to: $projectId" }
