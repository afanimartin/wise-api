import type { FastifyInstance } from 'fastify';

export async function healthRoutes(app: FastifyInstance): Promise<void> {
  app.get('/', {
    schema: {
      response: {
        200: {
          type: 'object',
          properties: {
            status: { type: 'string' },
            service: { type: 'string' },
          },
          required: ['status', 'service'],
        },
      },
    },
  }, async () => ({
    status: 'ok',
    service: 'wisebackend-api',
  }));

  app.get('/ready', async (request, reply) => {
    await request.server.db.query('select 1');
    return reply.send({ status: 'ready' });
  });
}
