import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { LedgerService } from './ledger.service.js';
import { WalletAccountService } from './wallet-account.service.js';
import { hashRequestBody } from '../../shared/security/request-hash.js';
import { hasPermission, type Permission } from '../auth/permissions.js';
import { PermissionDeniedError } from '../../shared/errors/app-error.js';
import type { AuthContext } from '../auth/auth.service.js';
import type { FastifyInstance } from 'fastify';

const transferSchema = z.object({
  fromAccountId: z.string().uuid(),
  toAccountId: z.string().uuid(),
  amountMinor: z.string().regex(/^[1-9][0-9]*$/),
  currency: z.string().min(3).max(8),
  referenceType: z.string().min(1),
  referenceId: z.string().min(1),
});

const accountSchema = z.object({
  currency: z.string().min(3).max(8).default('SSP'),
});

const fundWalletSchema = z.object({
  accountId: z.string().uuid(),
  amountMinor: z.string().regex(/^[1-9][0-9]*$/),
  currency: z.string().min(3).max(8),
  referenceId: z.string().min(1).default(() => randomUUID()),
  note: z.string().max(500).optional(),
});

export async function walletRoutes(app: FastifyInstance): Promise<void> {
  app.get('/accounts', { preHandler: app.authenticate }, async (request, reply) => {
    if (!request.auth) {
      return reply.status(401).send({
        error: {
          code: 'AUTHENTICATION_REQUIRED',
          message: 'Authentication is required',
        },
      });
    }
    requirePermission(request.auth, 'wallet:read:own');

    const accountService = new WalletAccountService(request.server.db);
    const accounts = await accountService.listUserAccounts(request.auth.userId);

    return reply.send({ data: accounts });
  });

  app.post('/accounts/customer', { preHandler: app.authenticate }, async (request, reply) => {
    if (!request.auth) {
      return reply.status(401).send({
        error: {
          code: 'AUTHENTICATION_REQUIRED',
          message: 'Authentication is required',
        },
      });
    }
    requirePermission(request.auth, 'wallet:create:own');

    const body = accountSchema.parse(request.body ?? {});
    const accountService = new WalletAccountService(request.server.db);
    const account = await accountService.getOrCreateCustomerAccount(
      request.auth.userId,
      body.currency,
    );

    return reply.status(201).send({ data: account });
  });

  app.post('/transfers', { preHandler: app.authenticate }, async (request, reply) => {
    if (!request.auth) {
      return reply.status(401).send({
        error: {
          code: 'AUTHENTICATION_REQUIRED',
          message: 'Authentication is required',
        },
      });
    }
    requirePermission(request.auth, 'transfer:create');

    const idempotencyKey = request.headers['idempotency-key'];
    if (typeof idempotencyKey !== 'string' || idempotencyKey.length < 8) {
      return reply.status(400).send({
        error: {
          code: 'MISSING_IDEMPOTENCY_KEY',
          message: 'Idempotency-Key header is required',
        },
      });
    }

    const body = transferSchema.parse(request.body);
    const requestHash = hashRequestBody(body);
    const ledgerService = new LedgerService(request.server.db);

    const response = await ledgerService.transferFunds({
      authenticatedUserId: request.auth.userId,
      idempotencyKey,
      requestHash,
      ...body,
    });

    return reply.status(response.idempotentReplay ? 200 : 201).send({
      data: response,
      meta: {
        idempotencyKey,
        requestHash,
      },
    });
  });

  app.post('/admin/fund', { preHandler: app.authenticate }, async (request, reply) => {
    if (!request.auth) {
      return reply.status(401).send({
        error: {
          code: 'AUTHENTICATION_REQUIRED',
          message: 'Authentication is required',
        },
      });
    }
    requirePermission(request.auth, 'wallet:credit');

    const idempotencyKey = request.headers['idempotency-key'];
    if (typeof idempotencyKey !== 'string' || idempotencyKey.length < 8) {
      return reply.status(400).send({
        error: {
          code: 'MISSING_IDEMPOTENCY_KEY',
          message: 'Idempotency-Key header is required',
        },
      });
    }

    const body = fundWalletSchema.parse(request.body);
    const requestHash = hashRequestBody(body);
    const ledgerService = new LedgerService(request.server.db);

    const response = await ledgerService.fundWallet({
      adminUserId: request.auth.userId,
      idempotencyKey,
      requestHash,
      ...body,
    });

    return reply.status(response.idempotentReplay ? 200 : 201).send({
      data: response,
      meta: {
        idempotencyKey,
        requestHash,
      },
    });
  });
}

function requirePermission(auth: AuthContext, permission: Permission): void {
  if (!hasPermission(auth.permissions, permission)) {
    throw new PermissionDeniedError();
  }
}
