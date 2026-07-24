import { buildApp } from './server.js';
import { loadConfig } from './shared/config/config.js';

const config = loadConfig();
const app = await buildApp(config);

try {
  await app.listen({ port: config.port, host: '0.0.0.0' });
  app.log.info({ port: config.port }, 'api listening');
} catch (error) {
  app.log.error({ error }, 'failed to start api');
  process.exit(1);
}
