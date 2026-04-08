#!/usr/bin/env bash

set -euo pipefail
export $(grep -v '^#' .env | xargs)
export AWS_ACCESS_KEY_ID="${AWS_ACCESS_KEY_ID:-minioadmin}"
export AWS_SECRET_ACCESS_KEY="${AWS_SECRET_ACCESS_KEY:-minioadmin}"
export AWS_ENDPOINT_URL="${AWS_ENDPOINT_URL:-http://localhost:9000}"
export OPENCODE_LOGS_S3_BUCKET="${OPENCODE_LOGS_S3_BUCKET:-my_bucket}"
export AWS_DEFAULT_REGION="${AWS_DEFAULT_REGION:-ru-central-1}"
export OPENCODE_LOGS_S3_PREFIX="${OPENCODE_LOGS_S3_PREFIX:-dev}"

exec bun run dev -- --print-logs --log-level DEBUG
