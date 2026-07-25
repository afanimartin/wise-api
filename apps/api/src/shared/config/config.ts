import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import dotenv from 'dotenv';
import { z } from 'zod';

const isCloudRun = Boolean(process.env.K_SERVICE);
const envFilePath = process.env.WISE_ENV_FILE ?? process.env.DOTENV_CONFIG_PATH ?? '.env';

if (!isCloudRun) {
  const resolvedEnvFilePath = resolve(process.cwd(), envFilePath);

  if (existsSync(resolvedEnvFilePath)) {
    dotenv.config({ path: resolvedEnvFilePath });
  }
}

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  APP_ENV: z.enum(['local', 'production']).optional(),
  PORT: z.coerce.number().int().positive().default(8080),
  LOG_LEVEL: z.string().default('info'),
  DATABASE_URL: z.string().min(1),
  CORS_ORIGINS: z.string().default('http://localhost:3000'),
  FIREBASE_PROJECT_ID: z.string().optional(),
  DEFAULT_WALLET_CURRENCY: z.string().min(3).max(8).default('SSP'),
});

export type AppConfig = {
  nodeEnv: 'development' | 'test' | 'production';
  appEnv: 'local' | 'production';
  port: number;
  logLevel: string;
  databaseUrl: string;
  corsOrigins: string[];
  firebaseProjectId: string | undefined;
  defaultWalletCurrency: string;
};

export function loadConfig(): AppConfig {
  const env = envSchema.parse(process.env);

  return {
    nodeEnv: env.NODE_ENV,
    appEnv: env.APP_ENV ?? (env.NODE_ENV === 'production' ? 'production' : 'local'),
    port: env.PORT,
    logLevel: env.LOG_LEVEL,
    databaseUrl: env.DATABASE_URL,
    corsOrigins: env.CORS_ORIGINS.split(',').map((origin) => origin.trim()),
    firebaseProjectId: env.FIREBASE_PROJECT_ID,
    defaultWalletCurrency: env.DEFAULT_WALLET_CURRENCY,
  };
}
