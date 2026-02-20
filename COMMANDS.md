# AP Bill Worker – Command Reference

## Local (localhost)

**Start server**
```powershell
npm run dev
```

**List doc_ids**
```powershell
Invoke-RestMethod -Uri "http://localhost:8080/list-docs" -Method Get
```

**Run one document**
```powershell
Invoke-RestMethod -Uri "http://localhost:8080/run-one" -Method Post -ContentType "application/json" -Body '{"doc_id": 12345}'
```

**Health check**
```powershell
Invoke-RestMethod -Uri "http://localhost:8080/healthz" -Method Get
```

---

## Cloud Run

**Base URL:** `https://ap-bill-ocr-worker-njiacix2yq-as.a.run.app`

**List doc_ids**
```powershell
$secret = 'Papaya3562!'
Invoke-RestMethod -Uri "https://ap-bill-ocr-worker-njiacix2yq-as.a.run.app/list-docs" -Method Get -Headers @{'x-worker-secret'=$secret}
```

**Run one document**
```powershell
$secret = 'Papaya3562!'
Invoke-RestMethod -Uri "https://ap-bill-ocr-worker-njiacix2yq-as.a.run.app/run-one" -Method Post -ContentType "application/json" -Headers @{'x-worker-secret'=$secret} -Body '{"doc_id": 12345}'
```

**Health check**
```powershell
Invoke-RestMethod -Uri "https://ap-bill-ocr-worker-njiacix2yq-as.a.run.app/healthz" -Method Get
```

---

## Deploy

**Full deploy (build + deploy)**
```powershell
.\deploy_cloud_run.ps1 `
  -ProjectId "odoo-ocr-487104" `
  -Region "asia-southeast1" `
  -ServiceName "ap-bill-ocr-worker" `
  -ServiceAccount "ap-bill-worker@odoo-ocr-487104.iam.gserviceaccount.com" `
  -EnvVarsFile "cloudrun.env.yaml" `
  -SetSecrets "WORKER_SHARED_SECRET=worker-shared-secret:latest,GEMINI_API_KEY=gemini-api-key:latest"
```

**Update secrets only (no rebuild)**
```powershell
gcloud run deploy ap-bill-ocr-worker `
  --project odoo-ocr-487104 `
  --region asia-southeast1 `
  --image asia-southeast1-docker.pkg.dev/odoo-ocr-487104/ap-bill/ap-bill-ocr-worker:latest `
  --update-secrets "WORKER_SHARED_SECRET=worker-shared-secret:latest,GEMINI_API_KEY=gemini-api-key:latest"
```

**Update Secret Manager**
```powershell
"YOUR_VALUE" | gcloud secrets versions add worker-shared-secret --data-file=- --project odoo-ocr-487104
"YOUR_GEMINI_KEY" | gcloud secrets versions add gemini-api-key --data-file=- --project odoo-ocr-487104
```

**Get Cloud Run URL**
```powershell
gcloud run services describe ap-bill-ocr-worker --region asia-southeast1 --project odoo-ocr-487104 --format="value(status.url)"
```

---

## Notes

- Replace `12345` with the actual `doc_id` from list-docs.
- For run-one with multiple targets, add `"target_key": "your-target-key"` to the body.
- Use `attachment_id` instead of `doc_id` if needed: `-Body '{"attachment_id": 67890}'`
