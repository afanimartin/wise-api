#!/usr/bin/env bash
set -euo pipefail

if command -v gcloud >/dev/null 2>&1; then
  command -v gcloud
  exit 0
fi

if [ -x "/Users/mac/google-cloud-sdk/bin/gcloud" ]; then
  echo "/Users/mac/google-cloud-sdk/bin/gcloud"
  exit 0
fi

echo "gcloud was not found. Install Google Cloud SDK or set GCLOUD=/path/to/gcloud." >&2
exit 1
