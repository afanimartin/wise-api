import { readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import pg from 'pg';
import { config as loadDotenv } from 'dotenv';

const envFilePath = process.env.WISE_ENV_FILE ?? process.env.DOTENV_CONFIG_PATH ?? '.env';

if (!process.env.K_SERVICE && existsSync(envFilePath)) {
  loadDotenv({ path: envFilePath });
}

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error('DATABASE_URL is required');
  process.exit(1);
}

const pool = new pg.Pool({ connectionString: databaseUrl });

try {
  await pool.query(`
    create table if not exists schema_migrations (
      filename text primary key,
      applied_at timestamptz not null default now()
    )
  `);

  const migrationsDir = path.resolve('packages/database/migrations');
  const filenames = (await readdir(migrationsDir))
    .filter((filename) => filename.endsWith('.sql'))
    .sort();

  for (const filename of filenames) {
    const alreadyApplied = await pool.query(
      'select 1 from schema_migrations where filename = $1',
      [filename],
    );

    if (alreadyApplied.rowCount) {
      console.log(`skip ${filename}`);
      continue;
    }

    const sql = await readFile(path.join(migrationsDir, filename), 'utf8');
    await pool.query('begin');
    try {
      await pool.query(sql);
      await pool.query('insert into schema_migrations (filename) values ($1)', [filename]);
      await pool.query('commit');
      console.log(`applied ${filename}`);
    } catch (error) {
      await pool.query('rollback');
      throw error;
    }
  }
} finally {
  await pool.end();
}
