# Financial Super App: Phase 1 Backend Implementation Context

## 1. Product And Deployment Context

This document is the canonical implementation context for the Phase 1 backend of the Financial Super App.

| Area | Decision |
| --- | --- |
| Target market | South Sudan, starting with Juba |
| Primary backend | Node.js on Cloud Run |
| Recommended Node framework | Fastify or NestJS |
| Async/event handlers | Cloud Run functions |
| Mobile client | Flutter |
| Admin dashboard | Next.js with TypeScript |
| Primary database | PostgreSQL on Cloud SQL |
| Hosting region | GCP `africa-south1` in Cape Town |
| Edge routing | Cloudflare Free Tier |
| Phase 1 focus | Financial ledger, wallet funding, venue payments, admin API |

The system must provide a reliable financial backend for mobile clients and a type-safe API surface for a Next.js admin dashboard. The Cloud Run API is the authoritative business domain boundary. Cloud SQL is the financial source of truth. Cloud Run functions are used only for isolated webhook, scheduled, and asynchronous workloads.

No architecture is unhackable. The security objective is a hardened, least-privileged, auditable system where sensitive actions are authenticated, authorized, idempotent, transactionally consistent, monitored, and recoverable.

## 2. System Topology

```text
                 +----------------------------------------------+
                 |              Next.js Web Admin               |
                 |              TypeScript / React              |
                 +----------------------+-----------------------+
                                        |
                                        | HTTPS + OpenAPI-generated TS client
                                        v
+------------------+      HTTPS      +------------------------------+      Private path      +------------------------------+
|  Flutter Mobile  |  ------------>  |      Cloud Run API           |  ------------------->  |       Cloud SQL Postgres     |
|  Client          |                 |      Node.js service         |                        |       financial source       |
+------------------+                 +------------------------------+                        +------------------------------+
                                               ^
                                               |
                                               | internal authenticated calls / Pub/Sub
                                               |
                                      +------------------------------+
                                      |      Cloud Run functions     |
                                      | webhooks, jobs, async events |
                                      +------------------------------+
```

### 2.1 Runtime Responsibilities

| Runtime | Responsibility |
| --- | --- |
| Cloud Run API service | Core auth boundary, wallet APIs, ledger mutations, admin API, OpenAPI docs |
| Cloud Run functions | Telco webhooks, scheduled reconciliation, async notifications, isolated provider callbacks |
| Cloud SQL PostgreSQL | ACID ledger, idempotency, funding state, merchant/geofence data, compliance logs |
| Cloudflare | TLS edge, DDoS filtering, WAF rules, rate limiting, caching for safe static/admin assets |
| Secret Manager | Provider secrets, JWT keys, webhook signing secrets, merchant verification key material |
| Cloud KMS | Envelope encryption for high-value secrets where needed |
| Pub/Sub | Durable async handoff between webhook/function/API/background workers |
| Cloud Scheduler | Timed reconciliation of stale funding requests |
| Cloud Logging / Monitoring | Audit trail, security alerts, SLOs, failure diagnostics |

## 3. Trust Boundaries

The financial backend must be designed around explicit trust boundaries.

| Boundary | Rule |
| --- | --- |
| Mobile client to API | Never trust client amount, GPS, role, merchant identity, or payment status without server validation |
| Admin dashboard to API | Require admin authentication, role checks, and audit logs for every sensitive action |
| Telco webhook to function | Verify IP allowlist where possible, HMAC signature, timestamp, replay window, and idempotency |
| Function to API/database | Use service account identity and least privilege; no public shared secrets between internal services |
| API to Cloud SQL | Use least-privileged DB user, private connectivity, parameterized queries, and migrations |
| Cloud SQL to application | Raw database errors must never cross the API boundary |

## 4. Infrastructure Architecture

```text
[Flutter / Next.js]
      |
      v
[Cloudflare]
WAF, DDoS filtering, TLS, rate limiting
      |
      v
[Cloud Run API: Node.js]
Private Cloud SQL connector, min instances tuned for latency
      |
      v
[Cloud SQL PostgreSQL]
Private IP preferred, backups, PITR, audit-friendly schema

[Telco Providers]
      |
      v
[Cloud Run functions]
Signature verification, replay protection
      |
      v
[Pub/Sub or internal API]
      |
      v
[Cloud Run API / Cloud SQL transaction]
```

### 4.1 Network Hardening

- Prefer Cloud SQL private IP or Cloud SQL connector from Cloud Run.
- Do not expose Cloud SQL publicly.
- Restrict Cloud Run ingress where practical behind Cloudflare and Google-managed ingress controls.
- Use separate service accounts for API, webhook functions, scheduled jobs, and deployments.
- Grant each service account only the Secret Manager, Pub/Sub, Cloud SQL, and logging permissions it needs.
- Keep production secrets out of environment files and source control.
- Enable Cloud SQL automated backups and point-in-time recovery.

## 5. Node.js Backend Standard

Use TypeScript for all backend code.

Recommended API stack:

- Node.js 22 LTS or current Google-supported LTS runtime.
- Fastify for lean APIs or NestJS if the team wants stronger module conventions.
- `zod` or equivalent for request validation.
- `pg` or an ORM/query builder with explicit transaction control.
- Prisma can be used for ordinary CRUD, but financial ledger mutations should use explicit SQL transactions or carefully reviewed repository methods.
- OpenAPI should be generated from route schemas or maintained as part of the API contract.

### 5.1 Recommended Service Layout

```text
apps/
  api/
    src/
      modules/
        auth/
        ledger/
        wallet/
        funding/
        merchants/
        compliance/
        admin/
      shared/
        db/
        errors/
        idempotency/
        observability/
        security/
      main.ts
  functions/
    src/
      momoWebhook.ts
      mgurushWebhook.ts
      reconcileFunding.ts
packages/
  contracts/
    openapi/
    schemas/
  database/
    migrations/
    sql/
```

## 6. Financial Ledger Model

The database must enforce consistency through an immutable double-entry bookkeeping ledger.

Balances must not be stored as mutable account fields. A wallet balance is derived from the sum of matching ledger entries:

- Credits increase a wallet balance.
- Debits decrease a wallet balance.
- Every value-moving transaction must create matching debit and credit entries.
- Ledger entries are append-only.
- Financial endpoints must be idempotent.
- Every ledger mutation must happen inside a database transaction.

### 6.1 Money Precision Rule

Do not use JavaScript floating-point arithmetic for money.

Implementation must use integer minor units, such as cents, piasters, or the smallest supported currency unit. API request payloads should accept either integer minor units or validated decimal strings that are immediately converted to integer minor units. Never accept `number` amounts for ledger mutation endpoints.

## 7. Cloud SQL Schema Draft

These are implementation-oriented SQL drafts. Final migrations should live under the database migration folder.

### 7.1 Wallet Accounts

`wallet_accounts` exists to provide lockable rows and account metadata. It is not the source of balance truth.

```sql
create table wallet_accounts (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null,
  account_type text not null check (account_type in ('CUSTOMER', 'MERCHANT', 'SYSTEM')),
  currency text not null,
  status text not null check (status in ('ACTIVE', 'FROZEN', 'CLOSED')),
  created_at timestamptz not null default now(),
  unique (owner_user_id, account_type, currency)
);
```

### 7.2 Wallet Transaction Ledger

```sql
create table wallet_transaction_ledger (
  id uuid primary key default gen_random_uuid(),
  transaction_id uuid not null,
  account_id uuid not null references wallet_accounts(id),
  owner_user_id uuid not null,
  entry_type text not null check (entry_type in ('DEBIT', 'CREDIT')),
  amount_minor bigint not null check (amount_minor > 0),
  currency text not null,
  reference_type text not null,
  reference_id text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index wallet_ledger_account_idx
  on wallet_transaction_ledger (account_id, created_at);

create index wallet_ledger_transaction_idx
  on wallet_transaction_ledger (transaction_id);
```

### 7.3 API Idempotency Registry

```sql
create table api_idempotency_registry (
  id uuid primary key default gen_random_uuid(),
  idempotency_key text not null unique,
  request_hash text not null,
  response_status int,
  response_payload jsonb,
  locked_until timestamptz,
  created_at timestamptz not null default now(),
  completed_at timestamptz
);
```

### 7.4 Funding Requests

```sql
create table wallet_funding_requests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  account_id uuid not null references wallet_accounts(id),
  provider text not null check (provider in ('MTN_MOMO', 'MGURUSH')),
  provider_reference text,
  amount_minor bigint not null check (amount_minor > 0),
  currency text not null,
  status text not null check (status in ('PENDING', 'COMPLETED', 'FAILED', 'EXPIRED')),
  request_payload_hash text,
  callback_payload_hash text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index wallet_funding_provider_ref_idx
  on wallet_funding_requests (provider, provider_reference)
  where provider_reference is not null;
```

### 7.5 Merchant Profiles And Compliance Flags

```sql
create table merchant_profiles (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique,
  display_name text not null,
  latitude numeric(10, 7) not null,
  longitude numeric(10, 7) not null,
  geofence_radius_meters int not null default 100,
  verification_secret_ref text not null,
  status text not null check (status in ('ACTIVE', 'SUSPENDED', 'CLOSED')),
  created_at timestamptz not null default now()
);

create table compliance_flags (
  id uuid primary key default gen_random_uuid(),
  user_id uuid,
  merchant_id uuid,
  event_type text not null,
  severity text not null check (severity in ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL')),
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
```

## 8. Wallet Transfer Requirements

Wallet transfers must run inside a single Cloud SQL transaction.

Implementation must:

- Validate request shape and authentication.
- Check idempotency before creating new ledger entries.
- Hash the request body and bind it to the idempotency key.
- Acquire deterministic account locks before calculating available funds.
- Validate available balance using ledger-derived totals.
- Validate merchant status and geofence when applicable.
- Insert the customer debit entry.
- Insert the merchant credit entry.
- Store the idempotent response.
- Return sanitized structured errors.
- Emit audit logs without leaking secrets or full PII.

### 8.1 Locking Strategy

Do not rely on `FOR UPDATE` against aggregate-only ledger queries.

Use lockable `wallet_accounts` rows:

```sql
select id
from wallet_accounts
where id = any($1::uuid[])
order by id
for update;
```

Then calculate balance from the immutable ledger inside the same transaction:

```sql
select coalesce(sum(
  case
    when entry_type = 'CREDIT' then amount_minor
    when entry_type = 'DEBIT' then -amount_minor
  end
), 0) as balance_minor
from wallet_transaction_ledger
where account_id = $1;
```

### 8.2 Idempotency Semantics

- Every value-moving request must include an `Idempotency-Key` header.
- If the same key and same request hash is repeated, return the stored response.
- If the same key is reused with a different request hash, reject with `409 Conflict`.
- Idempotency records must be created or locked inside the same transaction as ledger writes.
- Stale in-progress idempotency records require a safe timeout/recovery policy.

## 9. Mobile Money Funding Engine

Mobile money integrations, including MTN MoMo and mGURUSH, may have slow callbacks, timeouts, or unreliable handshakes. Funding must be asynchronous.

In-person checkout must remain synchronous against the internal wallet ledger. External mobile money funding should not block checkout flows.

### 9.1 Funding Flow

```text
[Mobile Client]
      |
      | 1. Request STK push
      v
[Cloud Run API]
      |
      | 2. Create PENDING funding request
      | 3. Call telco API
      v
[Telco API Gateway]
      |
      | 4. User enters MoMo PIN
      v
[User Phone]

[Telco Webhook]
      |
      | 5. HTTPS callback
      v
[Cloud Run function]
      |
      | 6. Verify signature, timestamp, replay window
      | 7. Publish verified event or call internal API
      v
[Cloud Run API / Cloud SQL transaction]
      |
      | 8. Mark funding complete and credit wallet through ledger
      v
[PostgreSQL Ledger]
```

### 9.2 Funding Webhook Contract

| Field | Value |
| --- | --- |
| Endpoint | `/webhooks/momo/mgu-callback` and provider-specific equivalents |
| Runtime | Cloud Run functions |
| Method | `POST` |
| Security | HMAC signature, timestamp tolerance, replay detection, provider IP allowlist where possible |
| Payload | JSON callback from telco gateway |

### 9.3 Funding Reliability Rules

- When a user initiates a deposit, write a `PENDING` funding request before calling the telco API.
- If the webhook does not arrive within 5 minutes, Cloud Scheduler must trigger a reconciliation function.
- Webhooks must be idempotent.
- Webhook handlers must verify signature headers using provider-specific secrets from Secret Manager.
- Invalid signatures must be rejected and logged as security events.
- Wallet crediting must happen through the ledger, never through a mutable balance update.

## 10. Local Juba Resiliency And Anti-Fraud Features

### 10.1 Cryptographic Offline Verification Token

The Cryptographic Offline Verification Token, or COVT, supports merchant-side verification when a restaurant or bar manager temporarily loses connectivity.

After a successful internal wallet transfer, the server generates a compact verification code.

Payload inputs:

- Transaction ID
- Amount in minor units
- Currency
- Timestamp
- Merchant ID

Generation:

- Serialize the payload deterministically.
- Hash it with HMAC-SHA256.
- Use a merchant-specific secret key stored behind Secret Manager or KMS-backed envelope encryption.
- Crop or encode the result into a clean 6-character alphanumeric code.

Verification:

- The merchant terminal can verify the code offline if it has the necessary transaction parameters and merchant verification secret.
- If full offline verification is not possible, the terminal records the code and reconciles it automatically when connectivity returns.

Security notes:

- Merchant secrets must not be stored in plaintext.
- Merchant terminal secret storage must be threat-modeled before launch.
- A 6-character token is convenient but collision-prone; use it as a human verification aid, not as the only source of financial truth.

### 10.2 Geofenced QR Code Validation

Geofenced QR validation prevents malicious actors from replacing venue QR codes with fraudulent stickers.

Implementation requirements:

- Every venue QR payload must identify the merchant or venue.
- Merchant profiles must store trusted physical coordinates and allowed radius.
- The Flutter app must append the customer GPS coordinates to the payment execution request.
- The API must calculate the distance between customer GPS and merchant GPS.
- If the distance is greater than the configured radius, reject the transaction.
- Rejections must create a compliance flag.

The default Phase 1 radius is `100` meters.

## 11. Admin Dashboard Integration

The Next.js admin dashboard must consume a generated TypeScript client from the Node.js API OpenAPI document.

### 11.1 OpenAPI Contract

- Expose OpenAPI docs from the Cloud Run API in non-production environments.
- In production, protect docs behind admin auth or publish a versioned artifact during CI.
- Generate the TypeScript client from the OpenAPI contract.

```bash
npx openapi-typescript-codegen \
  --input http://localhost:8080/openapi.json \
  --output ./src/api-client
```

### 11.2 Admin Authentication

- Admin users require strong authentication and role-based authorization.
- Every admin mutation must create an audit event.
- Privileged routes must enforce server-side authorization; never trust hidden UI controls.
- High-risk actions should require step-up authentication or explicit approval workflows in later phases.

## 12. Security Hardening Rules

These rules are mandatory.

### 12.1 Application Security

- Validate every request body, query, path parameter, and header.
- Use parameterized SQL only.
- Do not concatenate SQL with user input.
- Use structured domain errors and sanitized API responses.
- Rate-limit authentication, wallet, funding, webhook, and QR validation endpoints.
- Use constant-time comparison for HMAC signatures.
- Apply replay protection for webhooks using timestamp tolerance and stored event IDs/hashes.
- Use short-lived access tokens and refresh token rotation.
- Store password hashes only through a proven auth provider or strong password hashing scheme.

### 12.2 Financial Security

- Never expose direct table writes to clients.
- Never mutate stored wallet balances directly.
- Never use JavaScript `number` for money mutation logic.
- Every value movement must be idempotent.
- Every ledger mutation must be transactional.
- Every ledger transaction must produce balanced debit and credit entries.
- Every failed or suspicious value-moving attempt must be logged.

### 12.3 Infrastructure Security

- Use separate Google service accounts for API, functions, scheduled jobs, and CI/CD.
- Use least-privilege IAM.
- Store secrets only in Secret Manager or KMS-backed systems.
- Do not log secrets, tokens, full phone numbers, PINs, or provider credentials.
- Enable Cloud SQL backups and point-in-time recovery.
- Enable Cloud Audit Logs for sensitive resources.
- Configure alerting for failed webhook verification spikes, ledger imbalance, duplicate idempotency conflicts, and unusual geofence failures.

### 12.4 Database Security

- Use migrations for all schema changes.
- Use constraints for enum-like states and positive money amounts.
- Add database indexes for idempotency, provider references, account ledgers, and audit queries.
- Keep a separate read-only DB role for analytics/admin reads if needed.
- The application DB role should not have broad schema-owner privileges at runtime.

## 13. Error Boundaries

Never expose raw database, provider, or infrastructure errors to clients.

Use structured errors such as:

- `InsufficientFundsError`
- `InvalidGeofenceError`
- `DuplicateRequestError`
- `IdempotencyConflictError`
- `InvalidWebhookSignatureError`
- `FundingProviderTimeoutError`
- `MerchantSuspendedError`
- `LedgerInvariantViolationError`

Internally, log enough context to diagnose the issue, but redact secrets and sensitive personal data.

## 14. Operational Reliability

- Use retry-safe workflows for external providers.
- Prefer Pub/Sub for durable async handoff after webhook verification.
- Reconcile stale funding requests through Cloud Scheduler and Cloud Run functions.
- Record provider transaction IDs and callback payload hashes.
- Keep internal wallet checkout independent from telco uptime.
- Add health checks for API, database connectivity, and provider dependency status.
- Track SLOs for wallet transfer latency, webhook processing latency, and funding reconciliation time.

## 15. Phase 1 Implementation Order

Recommended backend implementation sequence:

1. Scaffold Node.js TypeScript API service for Cloud Run.
2. Configure Cloud SQL connectivity for local and Cloud Run environments.
3. Add migration tooling and create core database schema.
4. Implement request validation, structured errors, logging, and auth middleware.
5. Implement idempotency helper logic.
6. Implement ledger repository with transaction and account locking.
7. Implement wallet transfer endpoint.
8. Implement merchant profile and geofence validation.
9. Implement COVT generation for successful payments.
10. Implement mobile money funding request endpoint.
11. Implement Cloud Run functions for provider webhooks.
12. Implement scheduled reconciliation for stale funding requests.
13. Add OpenAPI generation and TypeScript admin client generation.
14. Add integration tests for idempotency, insufficient funds, double-entry consistency, webhook replay, geofence rejection, and failed provider callbacks.
15. Add infrastructure-as-code for Cloud Run, Cloud Functions, Cloud SQL, Secret Manager, IAM, Scheduler, Pub/Sub, and monitoring.

## 16. Acceptance Criteria

Phase 1 backend is implementation-ready when:

- The Node.js API runs locally and on Cloud Run.
- Cloud SQL migrations apply cleanly.
- Cloud SQL is not publicly exposed.
- Ledger mutations are transactional and idempotent.
- Balances are derived from ledger entries.
- Money arithmetic avoids floating-point precision errors.
- Every value movement creates balanced debit and credit entries.
- Mobile money funding safely handles pending, completed, failed, expired, and stale states.
- Webhook callbacks are signature-verified and replay-safe.
- Venue payment requests include geofence validation.
- Successful payments return a verification token.
- Admin OpenAPI docs or artifacts are available.
- The Next.js client can be generated from the API contract.
- Tests cover financial integrity, security failure paths, and provider retry behavior.
- Alerts exist for ledger imbalance, webhook verification failures, high duplicate-request rates, and suspicious geofence failures.
