import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import type pg from 'pg';

export async function migrate(pool: pg.Pool, directory = path.resolve('migrations')): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Serialize migration runners, not business requests. The lock is transaction-scoped.
    await client.query('SELECT pg_advisory_xact_lock(21401, 1)');
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name text PRIMARY KEY, sha256 text NOT NULL, applied_at timestamptz NOT NULL DEFAULT clock_timestamp())`);
    const files = (await readdir(directory)).filter((f) => /^\d{3}_[a-z_]+\.sql$/.test(f)).sort();
    if (!files.length) throw new Error('no migrations found');
    const applied = await client.query<{ name: string; sha256: string }>('SELECT name, sha256 FROM schema_migrations ORDER BY name');
    if (applied.rows.some((r, i) => r.name !== files[i])) throw new Error('migration history is not a known prefix');
    for (const [i, name] of files.entries()) {
      const sql = (await readFile(path.join(directory, name), 'utf8')).replace(/\r\n/g, '\n');
      const sha = createHash('sha256').update(sql).digest('hex');
      const existing = applied.rows[i];
      if (existing) {
        if (existing.sha256 !== sha) throw new Error('applied migration checksum mismatch');
      } else {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations(name, sha256) VALUES ($1, $2)', [name, sha]);
      }
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}
