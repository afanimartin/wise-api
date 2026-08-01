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
APP_ENV=local
PORT=8080
LOG_LEVEL=info
DATABASE_URL=postgres://wise:wise@localhost:5432/wise
CORS_ORIGINS=http://localhost:3000
WEBHOOK_SIGNATURE_SECRET=replace-me-local-dev
FIREBASE_PROJECT_ID=wise-money-499410
DEFAULT_WALLET_CURRENCY=SSP
```

## Environment Configuration

Use `NODE_ENV` for Node/runtime behavior and `APP_ENV` for the Wise deployment lane:

```text
local       local Docker Postgres, Swagger UI enabled at /docs
production  production-mode runtime, production Cloud Run service and DB
```

Templates:

```text
.env.example
.env.production.example
```

Cloud Run reads production secrets from Secret Manager: `DATABASE_URL` and `WEBHOOK_SIGNATURE_SECRET`.

Local runs load `.env` from disk. Cloud Run runs with `K_SERVICE` set, so the API does not read env files there; it uses only Cloud Run environment variables and Secret Manager secrets.

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
npm run deploy:production
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

## CI/CD

GitHub Actions validates the backend on pull requests and pushes to `main`.

On pushes to `main`, the deploy job targets production. Manual runs also deploy production.

- runs production database migrations
- builds and pushes a Docker image to Artifact Registry
- deploys the image to Cloud Run

Required GitHub Environment secrets for `production`:

```text
GCP_SA_KEY
DATABASE_URL
WEBHOOK_SIGNATURE_SECRET
```

Optional GitHub repository variable:

```text
CORS_ORIGINS
```

`GCP_SA_KEY` should be a JSON service account key for an account that can run Cloud Build, push to Artifact Registry, deploy Cloud Run, and update Secret Manager secret versions.

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

## Demo Bank Funding API

Demo bank routes require a Firebase ID token:

```text
Authorization: Bearer <firebase_id_token>
```

List the supported demo banks:

```http
GET /demo/banks
```

Link a simulated external bank account:

```http
POST /demo/bank-accounts
```

```json
{
  "bankCode": "KCB_SS",
  "accountName": "Jane Deng",
  "accountNumber": "123456789",
  "currency": "SSP",
  "openingBalanceMinor": "750000"
}
```

List linked demo bank accounts:

```http
GET /demo/bank-accounts
```

Move money from a linked demo bank account into the user's Wise wallet:

```http
POST /wallet/deposits/bank
Idempotency-Key: bank-deposit-<unique-key>
```

```json
{
  "demoBankAccountId": "uuid",
  "walletAccountId": "uuid",
  "amountMinor": "125000",
  "currency": "SSP"
}
```

This is a demo-only funding path. The simulated bank balance is debited and the Wise wallet is credited through the wallet ledger in one database transaction.

Before deploying auth-protected transfers, run all migrations against Cloud SQL, including:

```text
packages/database/migrations/0002_app_users.sql
packages/database/migrations/0003_app_user_permissions.sql
packages/database/migrations/0004_demo_bank_accounts.sql
```

## Architecture

See [docs/implementation-context.md](docs/implementation-context.md).
