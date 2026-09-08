import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { logger } from '../lib/logger.js';
import { closePool, pool } from './pool.js';

const here = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = resolve(here, '../../../../infrastructure/database/migrations');

/**
 * Forward-only migrations. Each file runs once inside its own transaction and
 * its checksum is recorded, so an edited file that has already run is a hard
 * error rather than a silent drift between environments.
 */
export async function migrate(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name        TEXT PRIMARY KEY,
      checksum    TEXT NOT NULL,
      applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  const applied = new Map<string, string>();
  const rows = await pool.query<{ name: string; checksum: string }>(
    'SELECT name, checksum FROM schema_migrations',
  );
  for (const row of rows.rows) applied.set(row.name, row.checksum);

  let ran = 0;
  for (const file of files) {
    const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
    const checksum = createHash('sha256').update(sql).digest('hex');
    const previous = applied.get(file);

    if (previous) {
      if (previous !== checksum) {
        throw new Error(
          `Migration ${file} has changed since it was applied. ` +
            'Add a new migration instead of editing an applied one.',
        );
      }
      continue;
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query(
        'INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)',
        [file, checksum],
      );
      await client.query('COMMIT');
      logger.info({ file }, 'migration applied');
      ran++;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw new Error(`Migration ${file} failed: ${(err as Error).message}`);
    } finally {
      client.release();
    }
  }

  logger.info({ ran, total: files.length }, ran > 0 ? 'migrations complete' : 'schema already current');
}

const invokedDirectly = process.argv[1]?.replace(/\\/g, '/').endsWith('src/db/migrate.ts');

if (invokedDirectly) {
  migrate()
    .then(() => closePool())
    .then(() => process.exit(0))
    .catch((err) => {
      logger.error({ err }, 'migration failed');
      process.exit(1);
    });
}
