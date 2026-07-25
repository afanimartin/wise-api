import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../server.js';
import type { FastifyInstance } from 'fastify';

const runDbTests = process.env.RUN_DB_TESTS === '1';
const describeDb = runDbTests ? describe : describe.skip;
const databaseUrl = process.env.TEST_DATABASE_URL ?? 'postgres://wise:wise@localhost:5432/wise';

describeDb('wallet transfer routes', () => {
  let app: FastifyInstance;
  let currentFirebaseUid = 'firebase-user-a';

  beforeAll(async () => {
    app = await buildApp({
      nodeEnv: 'test',
      appEnv: 'local',
      port: 0,
      logLevel: 'silent',
      databaseUrl,
      corsOrigins: ['http://localhost:3000'],
      firebaseProjectId: 'test-project',
      defaultWalletCurrency: 'SSP',
    }, {
      firebaseTokenVerifier: {
        verifyIdToken: async () => ({
          uid: currentFirebaseUid,
          email: `${currentFirebaseUid}@example.test`,
        }),
      },
    });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await app.db.query(`
      truncate table
        wallet_transaction_ledger,
        api_idempotency_registry,
        wallet_funding_requests,
        merchant_profiles,
        compliance_flags,
        app_users,
        wallet_accounts
      restart identity cascade
    `);
    currentFirebaseUid = 'firebase-user-a';
  });

  it('creates balanced ledger entries for a transfer', async () => {
    const fromAccountId = await createAccount('CUSTOMER', 'SSP');
    const toAccountId = await createAccount('MERCHANT', 'SSP');
    await seedCredit(fromAccountId, '5000', 'SSP');

    const response = await app.inject({
      method: 'POST',
      url: '/wallet/transfers',
      headers: {
        authorization: 'Bearer valid-test-token',
        'idempotency-key': `transfer-${randomUUID()}`,
      },
      payload: {
        fromAccountId,
        toAccountId,
        amountMinor: '1500',
        currency: 'SSP',
        referenceType: 'VENUE_PAYMENT',
        referenceId: randomUUID(),
      },
    });

    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body.data.balanceMinor).toBe('3500');

    const ledger = await app.db.query(
      `select entry_type, amount_minor::text, transaction_id
       from wallet_transaction_ledger
       where transaction_id = $1
       order by entry_type`,
      [body.data.transactionId],
    );

    expect(ledger.rows).toEqual([
      expect.objectContaining({ entry_type: 'CREDIT', amount_minor: '1500' }),
      expect.objectContaining({ entry_type: 'DEBIT', amount_minor: '1500' }),
    ]);
  });

  it('creates the authenticated user customer account idempotently', async () => {
    const first = await app.inject({
      method: 'POST',
      url: '/wallet/accounts/customer',
      headers: {
        authorization: 'Bearer valid-test-token',
      },
      payload: {
        currency: 'SSP',
      },
    });
    const second = await app.inject({
      method: 'POST',
      url: '/wallet/accounts/customer',
      headers: {
        authorization: 'Bearer valid-test-token',
      },
      payload: {
        currency: 'SSP',
      },
    });

    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);
    expect(second.json().data.id).toBe(first.json().data.id);
    expect(second.json().data.accountType).toBe('CUSTOMER');
    expect(second.json().data.currency).toBe('SSP');
    expect(second.json().data.balanceMinor).toBe('0');

    const accounts = await app.db.query('select count(*)::int as count from wallet_accounts');
    expect(accounts.rows[0]?.count).toBe(1);

    const users = await app.db.query<{ roles: string[]; permissions: string[] }>(
      `select roles, permissions
       from app_users
       where firebase_uid = $1`,
      [currentFirebaseUid],
    );
    expect(users.rows[0]?.roles).toEqual(['CUSTOMER']);
    expect(users.rows[0]?.permissions).toEqual(expect.arrayContaining([
      'wallet:read:own',
      'wallet:create:own',
      'transfer:create',
    ]));
  });

  it('rejects wallet actions when the user lacks the required permission', async () => {
    await app.db.query(
      `insert into app_users (firebase_uid, email, roles, permissions, status)
       values ($1, $2, '{SUPPORT}', '{}', 'ACTIVE')`,
      [currentFirebaseUid, `${currentFirebaseUid}@example.test`],
    );

    const response = await app.inject({
      method: 'GET',
      url: '/wallet/accounts',
      headers: {
        authorization: 'Bearer valid-test-token',
      },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe('PERMISSION_DENIED');
  });

  it('allows admins to fund a user wallet', async () => {
    const targetAccountId = await createAccount('CUSTOMER', 'SSP', 'firebase-target-user');
    await createAdminUser(currentFirebaseUid);

    const response = await app.inject({
      method: 'POST',
      url: '/wallet/admin/fund',
      headers: {
        authorization: 'Bearer valid-test-token',
        'idempotency-key': `fund-${randomUUID()}`,
      },
      payload: {
        accountId: targetAccountId,
        amountMinor: '25000',
        currency: 'SSP',
        referenceId: randomUUID(),
        note: 'Local test funding',
      },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json().data).toEqual(expect.objectContaining({
      accountId: targetAccountId,
      amountMinor: '25000',
      balanceMinor: '25000',
      currency: 'SSP',
      referenceType: 'ADMIN_FUND',
    }));

    const ledger = await app.db.query(
      `select entry_type, amount_minor::text, reference_type, metadata->>'adminUserId' as admin_user_id
       from wallet_transaction_ledger
       where account_id = $1`,
      [targetAccountId],
    );
    expect(ledger.rows).toEqual([
      expect.objectContaining({
        entry_type: 'CREDIT',
        amount_minor: '25000',
        reference_type: 'ADMIN_FUND',
      }),
    ]);
    expect(ledger.rows[0]?.admin_user_id).toBeTruthy();
  });

  it('rejects non-admin wallet funding', async () => {
    const targetAccountId = await createAccount('CUSTOMER', 'SSP', 'firebase-target-user');

    const response = await app.inject({
      method: 'POST',
      url: '/wallet/admin/fund',
      headers: {
        authorization: 'Bearer valid-test-token',
        'idempotency-key': `fund-${randomUUID()}`,
      },
      payload: {
        accountId: targetAccountId,
        amountMinor: '25000',
        currency: 'SSP',
      },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe('PERMISSION_DENIED');
  });

  it('replays admin wallet funding for the same idempotency key and request', async () => {
    const targetAccountId = await createAccount('CUSTOMER', 'SSP', 'firebase-target-user');
    await createAdminUser(currentFirebaseUid);
    const idempotencyKey = `fund-${randomUUID()}`;
    const payload = {
      accountId: targetAccountId,
      amountMinor: '25000',
      currency: 'SSP',
      referenceId: randomUUID(),
    };

    const first = await app.inject({
      method: 'POST',
      url: '/wallet/admin/fund',
      headers: {
        authorization: 'Bearer valid-test-token',
        'idempotency-key': idempotencyKey,
      },
      payload,
    });
    const second = await app.inject({
      method: 'POST',
      url: '/wallet/admin/fund',
      headers: {
        authorization: 'Bearer valid-test-token',
        'idempotency-key': idempotencyKey,
      },
      payload,
    });

    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(200);
    expect(second.json().data.transactionId).toBe(first.json().data.transactionId);
    expect(second.json().data.idempotentReplay).toBe(true);

    const ledger = await app.db.query('select count(*)::int as count from wallet_transaction_ledger');
    expect(ledger.rows[0]?.count).toBe(1);
  });

  it('lists only the authenticated user wallet accounts with ledger balances', async () => {
    const ownAccountId = await createAccount('CUSTOMER', 'SSP');
    await seedCredit(ownAccountId, '7000', 'SSP');
    const otherAccountId = await createAccount('CUSTOMER', 'SSP', 'firebase-other-user');
    await seedCredit(otherAccountId, '12000', 'SSP');

    const response = await app.inject({
      method: 'GET',
      url: '/wallet/accounts',
      headers: {
        authorization: 'Bearer valid-test-token',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().data).toEqual([
      expect.objectContaining({
        id: ownAccountId,
        accountType: 'CUSTOMER',
        currency: 'SSP',
        balanceMinor: '7000',
      }),
    ]);
  });

  it('rejects account listing without auth', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/wallet/accounts',
    });

    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe('AUTHENTICATION_REQUIRED');
  });

  it('replays the stored response for the same idempotency key and request', async () => {
    const fromAccountId = await createAccount('CUSTOMER', 'SSP');
    const toAccountId = await createAccount('MERCHANT', 'SSP');
    await seedCredit(fromAccountId, '5000', 'SSP');

    const idempotencyKey = `transfer-${randomUUID()}`;
    const payload = {
      fromAccountId,
      toAccountId,
      amountMinor: '1500',
      currency: 'SSP',
      referenceType: 'VENUE_PAYMENT',
      referenceId: randomUUID(),
    };

    const first = await app.inject({
      method: 'POST',
      url: '/wallet/transfers',
      headers: {
        authorization: 'Bearer valid-test-token',
        'idempotency-key': idempotencyKey,
      },
      payload,
    });
    const second = await app.inject({
      method: 'POST',
      url: '/wallet/transfers',
      headers: {
        authorization: 'Bearer valid-test-token',
        'idempotency-key': idempotencyKey,
      },
      payload,
    });

    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(200);
    expect(second.json().data.transactionId).toBe(first.json().data.transactionId);
    expect(second.json().data.idempotentReplay).toBe(true);

    const ledger = await app.db.query('select count(*)::int as count from wallet_transaction_ledger');
    expect(ledger.rows[0]?.count).toBe(3);
  });

  it('rejects idempotency key reuse with a different request hash', async () => {
    const fromAccountId = await createAccount('CUSTOMER', 'SSP');
    const toAccountId = await createAccount('MERCHANT', 'SSP');
    await seedCredit(fromAccountId, '5000', 'SSP');

    const idempotencyKey = `transfer-${randomUUID()}`;
    const payload = {
      fromAccountId,
      toAccountId,
      amountMinor: '1500',
      currency: 'SSP',
      referenceType: 'VENUE_PAYMENT',
      referenceId: randomUUID(),
    };

    await app.inject({
      method: 'POST',
      url: '/wallet/transfers',
      headers: {
        authorization: 'Bearer valid-test-token',
        'idempotency-key': idempotencyKey,
      },
      payload,
    });

    const conflict = await app.inject({
      method: 'POST',
      url: '/wallet/transfers',
      headers: {
        authorization: 'Bearer valid-test-token',
        'idempotency-key': idempotencyKey,
      },
      payload: {
        ...payload,
        amountMinor: '1600',
      },
    });

    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().error.code).toBe('IDEMPOTENCY_CONFLICT');
  });

  it('rejects transfers with insufficient funds', async () => {
    const fromAccountId = await createAccount('CUSTOMER', 'SSP');
    const toAccountId = await createAccount('MERCHANT', 'SSP');
    await seedCredit(fromAccountId, '500', 'SSP');

    const response = await app.inject({
      method: 'POST',
      url: '/wallet/transfers',
      headers: {
        authorization: 'Bearer valid-test-token',
        'idempotency-key': `transfer-${randomUUID()}`,
      },
      payload: {
        fromAccountId,
        toAccountId,
        amountMinor: '1500',
        currency: 'SSP',
        referenceType: 'VENUE_PAYMENT',
        referenceId: randomUUID(),
      },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe('INSUFFICIENT_FUNDS');
  });

  it('rejects missing auth before transfer processing', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/wallet/transfers',
      headers: {
        'idempotency-key': `transfer-${randomUUID()}`,
      },
      payload: {
        fromAccountId: randomUUID(),
        toAccountId: randomUUID(),
        amountMinor: '1500',
        currency: 'SSP',
        referenceType: 'VENUE_PAYMENT',
        referenceId: randomUUID(),
      },
    });

    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe('AUTHENTICATION_REQUIRED');
  });

  it('rejects spending from another user account', async () => {
    const fromAccountId = await createAccount('CUSTOMER', 'SSP', 'firebase-owner');
    const toAccountId = await createAccount('MERCHANT', 'SSP');
    await seedCredit(fromAccountId, '5000', 'SSP');
    currentFirebaseUid = 'firebase-attacker';

    const response = await app.inject({
      method: 'POST',
      url: '/wallet/transfers',
      headers: {
        authorization: 'Bearer valid-test-token',
        'idempotency-key': `transfer-${randomUUID()}`,
      },
      payload: {
        fromAccountId,
        toAccountId,
        amountMinor: '1500',
        currency: 'SSP',
        referenceType: 'VENUE_PAYMENT',
        referenceId: randomUUID(),
      },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe('WALLET_ACCOUNT_ACCESS_DENIED');
  });

  async function createAccount(
    accountType: 'CUSTOMER' | 'MERCHANT',
    currency: string,
    firebaseUid = currentFirebaseUid,
  ): Promise<string> {
    const user = await app.db.query<{ id: string }>(
      `insert into app_users (firebase_uid, email, status)
       values ($1, $2, 'ACTIVE')
       on conflict (firebase_uid) do update
       set updated_at = now()
       returning id`,
      [firebaseUid, `${firebaseUid}@example.test`],
    );
    const result = await app.db.query<{ id: string }>(
      `insert into wallet_accounts (owner_user_id, account_type, currency, status)
       values ($1, $2, $3, 'ACTIVE')
       returning id`,
      [user.rows[0]!.id, accountType, currency],
    );

    return result.rows[0]!.id;
  }

  async function seedCredit(accountId: string, amountMinor: string, currency: string): Promise<void> {
    const account = await app.db.query<{ owner_user_id: string }>(
      'select owner_user_id from wallet_accounts where id = $1',
      [accountId],
    );

    await app.db.query(
      `insert into wallet_transaction_ledger
        (transaction_id, account_id, owner_user_id, entry_type, amount_minor, currency, reference_type, reference_id)
       values ($1, $2, $3, 'CREDIT', $4, $5, 'TEST_SEED', $6)`,
      [randomUUID(), accountId, account.rows[0]!.owner_user_id, amountMinor, currency, randomUUID()],
    );
  }

  async function createAdminUser(firebaseUid: string): Promise<void> {
    await app.db.query(
      `insert into app_users (firebase_uid, email, roles, permissions, status)
       values (
        $1,
        $2,
        '{ADMIN}',
        '{admin:access,wallet:read:any,wallet:credit,wallet:debit,transfer:approve,user:read:any}',
        'ACTIVE'
       )
       on conflict (firebase_uid) do update
       set roles = excluded.roles,
           permissions = excluded.permissions,
           updated_at = now()`,
      [firebaseUid, `${firebaseUid}@example.test`],
    );
  }
});
