import { z } from 'zod';
import { DemoBankService } from './demo-bank.service.js';
import { hasPermission, type Permission } from '../auth/permissions.js';
import { PermissionDeniedError } from '../../shared/errors/app-error.js';
import type { AuthContext } from '../auth/auth.service.js';
import type { FastifyInstance } from 'fastify';

const linkBankAccountSchema = z.object({
  bankCode: z.string().min(2).max(32),
  accountName: z.string().min(1).max(120),
  accountNumber: z.string().regex(/^[0-9]{6,20}$/),
  currency: z.string().min(3).max(8).default('SSP'),
  openingBalanceMinor: z.string().regex(/^[0-9]+$/).default('250000'),
});

export async function demoBankRoutes(app: FastifyInstance): Promise<void> {
  app.get('/banks', { preHandler: app.authenticate }, async (request, reply) => {
    if (!request.auth) {
      return reply.status(401).send({
        error: {
          code: 'AUTHENTICATION_REQUIRED',
          message: 'Authentication is required',
        },
      });
    }
    requirePermission(request.auth, 'bank:read:demo');

    const service = new DemoBankService(request.server.db);

    return reply.send({ data: service.listBanks() });
  });

  app.get('/bank-accounts', { preHandler: app.authenticate }, async (request, reply) => {
    if (!request.auth) {
      return reply.status(401).send({
        error: {
          code: 'AUTHENTICATION_REQUIRED',
          message: 'Authentication is required',
        },
      });
    }
    requirePermission(request.auth, 'bank:read:demo');

    const service = new DemoBankService(request.server.db);
    const accounts = await service.listUserAccounts(request.auth.userId);

    return reply.send({ data: accounts });
  });

  app.post('/bank-accounts', { preHandler: app.authenticate }, async (request, reply) => {
    if (!request.auth) {
      return reply.status(401).send({
        error: {
          code: 'AUTHENTICATION_REQUIRED',
          message: 'Authentication is required',
        },
      });
    }
    requirePermission(request.auth, 'bank:link:demo');

    const body = linkBankAccountSchema.parse(request.body ?? {});
    const service = new DemoBankService(request.server.db);
    const account = await service.linkAccount({
      authenticatedUserId: request.auth.userId,
      ...body,
    });

    return reply.status(201).send({ data: account });
  });
}

function requirePermission(auth: AuthContext, permission: Permission): void {
  if (!hasPermission(auth.permissions, permission)) {
    throw new PermissionDeniedError();
  }
}
