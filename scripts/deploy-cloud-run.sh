#!/usr/bin/env bash
set -euo pipefail

GCLOUD="${GCLOUD:-$(bash scripts/resolve-gcloud.sh)}"
PROJECT_ID="${PROJECT_ID:-xzerra-dev}"
REGION="${REGION:-africa-south1}"
REPOSITORY="${REPOSITORY:-wise-backend}"
SERVICE="${SERVICE:-wise-api}"
SERVICE_ACCOUNT="${SERVICE_ACCOUNT:-wise-api-sa@${PROJECT_ID}.iam.gserviceaccount.com}"
FIREBASE_PROJECT_ID="${FIREBASE_PROJECT_ID:-${PROJECT_ID}}"
IMAGE_TAG="${IMAGE_TAG:-$(date +%Y%m%d%H%M%S)}"
IMAGE="${REGION}-docker.pkg.dev/${PROJECT_ID}/${REPOSITORY}/${SERVICE}:${IMAGE_TAG}"

if [ -z "${DATABASE_URL:-}" ]; then
  echo "DATABASE_URL is required. Use your Neon pooled connection string." >&2
  exit 1
fi

if [ -z "${WEBHOOK_SIGNATURE_SECRET:-}" ]; then
  echo "WEBHOOK_SIGNATURE_SECRET is required." >&2
  exit 1
fi

"${GCLOUD}" config set project "${PROJECT_ID}" >/dev/null

if [ "${SKIP_GCP_SERVICE_ENABLE:-0}" != "1" ]; then
  "${GCLOUD}" services enable \
    run.googleapis.com \
    artifactregistry.googleapis.com \
    cloudbuild.googleapis.com \
    secretmanager.googleapis.com \
    --project "${PROJECT_ID}"
fi

if [ "${SKIP_ARTIFACT_REPOSITORY_CREATE:-0}" != "1" ] && ! "${GCLOUD}" artifacts repositories describe "${REPOSITORY}" \
  --location "${REGION}" \
  --project "${PROJECT_ID}" >/dev/null 2>&1; then
  "${GCLOUD}" artifacts repositories create "${REPOSITORY}" \
    --repository-format docker \
    --location "${REGION}" \
    --description "Wise backend containers" \
    --project "${PROJECT_ID}"
fi

upsert_secret() {
  local name="$1"
  local value="$2"

  if ! "${GCLOUD}" secrets describe "${name}" --project "${PROJECT_ID}" >/dev/null 2>&1; then
    printf '%s' "${value}" | "${GCLOUD}" secrets create "${name}" \
      --replication-policy automatic \
      --data-file - \
      --project "${PROJECT_ID}" >/dev/null
  else
    printf '%s' "${value}" | "${GCLOUD}" secrets versions add "${name}" \
      --data-file - \
      --project "${PROJECT_ID}" >/dev/null
  fi
}

upsert_secret "DATABASE_URL" "${DATABASE_URL}"
upsert_secret "WEBHOOK_SIGNATURE_SECRET" "${WEBHOOK_SIGNATURE_SECRET}"

"${GCLOUD}" builds submit \
  --tag "${IMAGE}" \
  --project "${PROJECT_ID}"

"${GCLOUD}" run deploy "${SERVICE}" \
  --image "${IMAGE}" \
  --region "${REGION}" \
  --platform managed \
  --service-account "${SERVICE_ACCOUNT}" \
  --allow-unauthenticated \
  --memory 512Mi \
  --cpu 1 \
  --concurrency 40 \
  --min-instances 0 \
  --max-instances 5 \
  --timeout 30s \
  --set-env-vars "NODE_ENV=production,LOG_LEVEL=info,FIREBASE_PROJECT_ID=${FIREBASE_PROJECT_ID},CORS_ORIGINS=${CORS_ORIGINS:-*}" \
  --set-secrets "DATABASE_URL=DATABASE_URL:latest,WEBHOOK_SIGNATURE_SECRET=WEBHOOK_SIGNATURE_SECRET:latest" \
  --project "${PROJECT_ID}"

"${GCLOUD}" run services describe "${SERVICE}" \
  --region "${REGION}" \
  --project "${PROJECT_ID}" \
  --format 'value(status.url)'
