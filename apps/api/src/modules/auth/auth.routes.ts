import type { FastifyInstance } from 'fastify';

export async function authRoutes(app: FastifyInstance): Promise<void> {
  app.get('/me', { preHandler: app.authenticate }, async (request, reply) => {
    if (!request.auth) {
      return reply.status(401).send({
        error: {
          code: 'AUTHENTICATION_REQUIRED',
          message: 'Authentication is required',
        },
      });
    }

    return reply.send({
      data: {
        userId: request.auth.userId,
        firebaseUid: request.auth.firebaseUid,
        roles: request.auth.roles,
        permissions: request.auth.permissions,
      },
    });
  });
}
