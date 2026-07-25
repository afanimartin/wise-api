import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import Fastify, { type FastifyInstance } from 'fastify';
import { AuthService } from './modules/auth/auth.service.js';
import { authRoutes } from './modules/auth/auth.routes.js';
import {
  createFirebaseTokenVerifier,
  type FirebaseTokenVerifier,
} from './modules/auth/firebase-token-verifier.js';
import { healthRoutes } from './modules/health/health.routes.js';
import { walletRoutes } from './modules/wallet/wallet.routes.js';
import { createDatabase } from './shared/db/database.js';
import { registerErrorHandler } from './shared/errors/error-handler.js';
import type { AppConfig } from './shared/config/config.js';

export type AppDependencies = {
  firebaseTokenVerifier?: FirebaseTokenVerifier;
};

export async function buildApp(
  config: AppConfig,
  dependencies: AppDependencies = {},
): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: config.logLevel,
      redact: ['req.headers.authorization', 'req.headers.cookie'],
    },
  });

  app.decorate('db', createDatabase(config.databaseUrl));
  app.decorate(
    'firebaseTokenVerifier',
    dependencies.firebaseTokenVerifier ?? createFirebaseTokenVerifier(config.firebaseProjectId),
  );
  app.decorateRequest('auth', null);
  app.decorate('authenticate', async (request) => {
    request.auth = await new AuthService(
      app.db,
      app.firebaseTokenVerifier,
      config.defaultWalletCurrency,
    ).authenticate(request.headers.authorization);
  });

  await app.register(helmet);
  await app.register(cors, { origin: config.corsOrigins });
  await app.register(rateLimit, {
    max: 120,
    timeWindow: '1 minute',
  });

  await app.register(swagger, {
    openapi: {
      info: {
        title: 'Wise Financial Super App API',
        version: '0.1.0',
      },
    },
  });

  if (config.appEnv === 'local') {
    await app.register(swaggerUi, { routePrefix: '/docs' });
  }

  registerErrorHandler(app);
  await app.register(healthRoutes, { prefix: '/health' });
  await app.register(authRoutes, { prefix: '/auth' });
  await app.register(walletRoutes, { prefix: '/wallet' });

  app.addHook('onClose', async (instance) => {
    await instance.db.close();
  });

  return app;
}
