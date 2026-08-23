import pg, { Pool, type PoolClient } from 'pg';

/**
 * `pg` returns BIGINT as a string by default so it can't silently lose precision.
 * Every BIGINT in this schema is a cent amount well inside Number.MAX_SAFE_INTEGER,
 * so parsing to number here is safe and keeps the query layer tidy.
 *
 * Registered once at module load, and therefore inherited by every pool created
 * below — including the throwaway pools tests build against.
 */
pg.types.setTypeParser(pg.types.builtins.INT8, (value) => Number(value));

export const DEFAULT_CONNECTION_STRING = 'postgresql://localhost:5432/invest_buddy';

export function createPool(connectionString?: string): Pool {
  return new Pool({
    connectionString:
      connectionString ?? process.env.DATABASE_URL ?? DEFAULT_CONNECTION_STRING,
  });
}

export async function withTransaction<T>(
  pool: Pool,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
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
