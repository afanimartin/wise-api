# Wise Backend

Node.js + TypeScript backend for the Phase 1 Financial Super App.

## Stack

- Cloud Run API service
- Cloud Run functions for webhooks and scheduled jobs
- Cloud SQL PostgreSQL
- Fastify
- TypeScript

## Local Setup

```bash
npm install
cp .env.example .env
docker compose up -d postgres
npm run db:migrate
npm run dev
```

Health checks:

```bash
curl http://localhost:8080/health
curl http://localhost:8080/health/ready
```

OpenAPI docs are available locally at:

```text
http://localhost:8080/docs
```

Required local environment values:

```env
NODE_ENV=development
PORT=8080
LOG_LEVEL=info
DATABASE_URL=postgres://wise:wise@localhost:5432/wise
CORS_ORIGINS=http://localhost:3000
WEBHOOK_SIGNATURE_SECRET=replace-me-local-dev
FIREBASE_PROJECT_ID=xzerra-dev
```

## Verification

```bash
npm run typecheck
npm test
npm run test:db
npm run build
npm audit --omit=dev
```

`npm run test:db` expects local Postgres to be running through Docker Compose.

## Neon + Cloud Run Deployment

Run migrations against Neon using the pooled connection string:

```bash
DATABASE_URL='postgres://USER:PASSWORD@HOST.neon.tech/DB?sslmode=require' \
  npm run db:migrate:remote
```

Deploy the Docker API to Cloud Run:

```bash
DATABASE_URL='postgres://USER:PASSWORD@HOST.neon.tech/DB?sslmode=require' \
WEBHOOK_SIGNATURE_SECRET='replace-with-production-secret' \
PROJECT_ID=xzerra-dev \
REGION=africa-south1 \
npm run deploy:cloud-run
```

The Cloud Run service is deployed with:

```text
Service: wise-api
Memory: 512Mi
CPU: 1
Min instances: 0
Max instances: 5
Concurrency: 40
```

## Wallet Account API

Wallet account routes require a Firebase ID token:

```text
Authorization: Bearer <firebase_id_token>
```

Create or fetch the authenticated user's customer wallet:

```http
POST /wallet/accounts/customer
```

```json
{
  "currency": "SSP"
}
```

List the authenticated user's wallet accounts and ledger-derived balances:

```http
GET /wallet/accounts
```

## Wallet Transfer API

`POST /wallet/transfers` performs an idempotent double-entry wallet transfer.

The route requires a Firebase ID token:

```text
Authorization: Bearer <firebase_id_token>
```

The API verifies the token, maps the Firebase UID to an internal `app_users.id`, and only allows spending from wallet accounts owned by that internal user.

Money values are sent as integer strings in minor units:

```json
{
  "fromAccountId": "uuid",
  "toAccountId": "uuid",
  "amountMinor": "1500",
  "currency": "SSP",
  "referenceType": "VENUE_PAYMENT",
  "referenceId": "provider-or-domain-reference"
}
```

Every request must include:

```text
Idempotency-Key: unique-request-key
```

Before deploying auth-protected transfers, run all migrations against Cloud SQL, including:

```text
packages/database/migrations/0002_app_users.sql
```

## Architecture

See [docs/implementation-context.md](docs/implementation-context.md).
