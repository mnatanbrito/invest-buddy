import { Pool } from 'pg';

/**
 * `pg` returns BIGINT as a string by default so it can't silently lose precision.
 * Every BIGINT in this schema is a cent amount well inside Number.MAX_SAFE_INTEGER,
 * so parsing to number here is safe and keeps the query layer tidy.
 */
import pgTypes from 'pg';
pgTypes.types.setTypeParser(pgTypes.types.builtins.INT8, (value) => Number(value));

export const pool = new Pool({
  connectionString:
    process.env.DATABASE_URL ?? `postgresql://localhost:5432/invest_buddy`,
});

export async function withTransaction<T>(fn: (client: import('pg').PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
