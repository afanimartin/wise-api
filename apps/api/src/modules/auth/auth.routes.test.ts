import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../server.js';
import type { FastifyInstance } from 'fastify';

const runDbTests = process.env.RUN_DB_TESTS === '1';
const describeDb = runDbTests ? describe : describe.skip;
const databaseUrl = process.env.TEST_DATABASE_URL ?? 'postgres://wise:wise@localhost:5432/wise';

describeDb('auth routes', () => {
  let app: FastifyInstance;
  const firebaseUid = 'firebase-admin-check';

  beforeAll(async () => {
    app = await buildApp({
      nodeEnv: 'test',
      port: 0,
      logLevel: 'silent',
      databaseUrl,
      corsOrigins: ['http://localhost:3000'],
      firebaseProjectId: 'test-project',
    }, {
      firebaseTokenVerifier: {
        verifyIdToken: async () => ({
          uid: firebaseUid,
          email: `${firebaseUid}@example.test`,
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
  });

  it('returns the authenticated user roles and permissions', async () => {
    await app.db.query(
      `insert into app_users (firebase_uid, email, roles, permissions, status)
       values ($1, $2, '{ADMIN}', '{admin:access,wallet:read:any}', 'ACTIVE')`,
      [firebaseUid, `${firebaseUid}@example.test`],
    );

    const response = await app.inject({
      method: 'GET',
      url: '/auth/me',
      headers: {
        authorization: 'Bearer valid-test-token',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().data).toEqual(expect.objectContaining({
      firebaseUid,
      roles: ['ADMIN'],
      permissions: ['admin:access', 'wallet:read:any'],
    }));
  });

  it('creates a default customer wallet for newly authenticated users', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/auth/me',
      headers: {
        authorization: 'Bearer valid-test-token',
      },
    });

    expect(response.statusCode).toBe(200);

    const userId = response.json().data.userId;
    const accounts = await app.db.query(
      `select owner_user_id, account_type, currency, status
       from wallet_accounts
       where owner_user_id = $1`,
      [userId],
    );

    expect(accounts.rows).toEqual([
      expect.objectContaining({
        owner_user_id: userId,
        account_type: 'CUSTOMER',
        currency: 'SSP',
        status: 'ACTIVE',
      }),
    ]);
  });

  it('repairs missing default customer access on sign-in', async () => {
    await app.db.query(
      `insert into app_users (firebase_uid, email, roles, permissions, status)
       values ($1, $2, '{}', '{}', 'ACTIVE')`,
      [firebaseUid, `${firebaseUid}@example.test`],
    );

    const response = await app.inject({
      method: 'GET',
      url: '/auth/me',
      headers: {
        authorization: 'Bearer valid-test-token',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().data).toEqual(expect.objectContaining({
      roles: ['CUSTOMER'],
      permissions: expect.arrayContaining([
        'wallet:read:own',
        'wallet:create:own',
        'transfer:create',
      ]),
    }));
  });
});
