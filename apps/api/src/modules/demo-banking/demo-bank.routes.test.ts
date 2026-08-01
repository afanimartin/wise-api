import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../server.js';
import type { FastifyInstance } from 'fastify';

const runDbTests = process.env.RUN_DB_TESTS === '1';
const describeDb = runDbTests ? describe : describe.skip;
const databaseUrl = process.env.TEST_DATABASE_URL ?? 'postgres://wise:wise@localhost:5432/wise';

describeDb('demo bank routes', () => {
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
        demo_bank_accounts,
        merchant_profiles,
        compliance_flags,
        app_users,
        wallet_accounts
      restart identity cascade
    `);
    currentFirebaseUid = 'firebase-user-a';
  });

  it('lists demo banks for authenticated users', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/demo/banks',
      headers: {
        authorization: 'Bearer valid-test-token',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().data).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'KCB_SS',
        name: 'KCB South Sudan',
        currencies: expect.arrayContaining(['SSP']),
      }),
    ]));
  });

  it('links and lists a demo bank account for the authenticated user', async () => {
    const linked = await linkDemoBankAccount('750000');

    const response = await app.inject({
      method: 'GET',
      url: '/demo/bank-accounts',
      headers: {
        authorization: 'Bearer valid-test-token',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().data).toEqual([
      expect.objectContaining({
        id: linked.id,
        bankCode: 'KCB_SS',
        accountName: 'Jane Deng',
        accountNumberLast4: '6789',
        balanceMinor: '750000',
        currency: 'SSP',
        status: 'ACTIVE',
      }),
    ]);
  });

  it('moves money from a demo bank account into the Wise wallet', async () => {
    const bankAccount = await linkDemoBankAccount('750000');
    const walletAccountId = await getCustomerWalletId();

    const response = await app.inject({
      method: 'POST',
      url: '/wallet/deposits/bank',
      headers: {
        authorization: 'Bearer valid-test-token',
        'idempotency-key': `bank-deposit-${randomUUID()}`,
      },
      payload: {
        demoBankAccountId: bankAccount.id,
        walletAccountId,
        amountMinor: '125000',
        currency: 'SSP',
        referenceId: randomUUID(),
      },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json().data).toEqual(expect.objectContaining({
      demoBankAccountId: bankAccount.id,
      walletAccountId,
      amountMinor: '125000',
      currency: 'SSP',
      referenceType: 'BANK_DEPOSIT',
      bankBalanceMinor: '625000',
      walletBalanceMinor: '125000',
    }));

    const bankBalance = await app.db.query<{ balance_minor: string }>(
      'select balance_minor::text from demo_bank_accounts where id = $1',
      [bankAccount.id],
    );
    expect(bankBalance.rows[0]?.balance_minor).toBe('625000');

    const ledger = await app.db.query(
      `select entry_type, amount_minor::text, reference_type, metadata->>'demoBankAccountId' as demo_bank_account_id
       from wallet_transaction_ledger
       where account_id = $1`,
      [walletAccountId],
    );
    expect(ledger.rows).toEqual([
      expect.objectContaining({
        entry_type: 'CREDIT',
        amount_minor: '125000',
        reference_type: 'BANK_DEPOSIT',
        demo_bank_account_id: bankAccount.id,
      }),
    ]);
  });

  it('replays a demo bank deposit for the same idempotency key and request', async () => {
    const bankAccount = await linkDemoBankAccount('750000');
    const walletAccountId = await getCustomerWalletId();
    const idempotencyKey = `bank-deposit-${randomUUID()}`;
    const payload = {
      demoBankAccountId: bankAccount.id,
      walletAccountId,
      amountMinor: '125000',
      currency: 'SSP',
      referenceId: randomUUID(),
    };

    const first = await app.inject({
      method: 'POST',
      url: '/wallet/deposits/bank',
      headers: {
        authorization: 'Bearer valid-test-token',
        'idempotency-key': idempotencyKey,
      },
      payload,
    });
    const second = await app.inject({
      method: 'POST',
      url: '/wallet/deposits/bank',
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

    const bankBalance = await app.db.query<{ balance_minor: string }>(
      'select balance_minor::text from demo_bank_accounts where id = $1',
      [bankAccount.id],
    );
    expect(bankBalance.rows[0]?.balance_minor).toBe('625000');

    const ledger = await app.db.query('select count(*)::int as count from wallet_transaction_ledger');
    expect(ledger.rows[0]?.count).toBe(1);
  });

  it('rejects demo bank deposits with insufficient bank funds', async () => {
    const bankAccount = await linkDemoBankAccount('500');
    const walletAccountId = await getCustomerWalletId();

    const response = await app.inject({
      method: 'POST',
      url: '/wallet/deposits/bank',
      headers: {
        authorization: 'Bearer valid-test-token',
        'idempotency-key': `bank-deposit-${randomUUID()}`,
      },
      payload: {
        demoBankAccountId: bankAccount.id,
        walletAccountId,
        amountMinor: '125000',
        currency: 'SSP',
        referenceId: randomUUID(),
      },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe('DEMO_BANK_INSUFFICIENT_FUNDS');
  });

  it('rejects deposits from another user demo bank account', async () => {
    const bankAccount = await linkDemoBankAccount('750000');
    currentFirebaseUid = 'firebase-user-b';
    const walletAccountId = await getCustomerWalletId();

    const response = await app.inject({
      method: 'POST',
      url: '/wallet/deposits/bank',
      headers: {
        authorization: 'Bearer valid-test-token',
        'idempotency-key': `bank-deposit-${randomUUID()}`,
      },
      payload: {
        demoBankAccountId: bankAccount.id,
        walletAccountId,
        amountMinor: '125000',
        currency: 'SSP',
        referenceId: randomUUID(),
      },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe('DEMO_BANK_ACCOUNT_NOT_FOUND');
  });

  async function linkDemoBankAccount(openingBalanceMinor: string): Promise<{ id: string }> {
    const response = await app.inject({
      method: 'POST',
      url: '/demo/bank-accounts',
      headers: {
        authorization: 'Bearer valid-test-token',
      },
      payload: {
        bankCode: 'KCB_SS',
        accountName: 'Jane Deng',
        accountNumber: '123456789',
        currency: 'SSP',
        openingBalanceMinor,
      },
    });

    expect(response.statusCode).toBe(201);
    return response.json().data;
  }

  async function getCustomerWalletId(): Promise<string> {
    await app.inject({
      method: 'POST',
      url: '/wallet/accounts/customer',
      headers: {
        authorization: 'Bearer valid-test-token',
      },
      payload: {
        currency: 'SSP',
      },
    });

    const result = await app.db.query<{ id: string }>(
      `select account.id
       from wallet_accounts account
       join app_users users
         on users.id = account.owner_user_id
       where users.firebase_uid = $1
         and account.account_type = 'CUSTOMER'
         and account.currency = 'SSP'`,
      [currentFirebaseUid],
    );

    return result.rows[0]!.id;
  }
});
