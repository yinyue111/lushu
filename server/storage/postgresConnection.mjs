import pg from 'pg';

const { Pool } = pg;

/** @param {{connectionString?: string, environment?: NodeJS.ProcessEnv, applicationName?: string, host?: string, port?: number, database?: string, user?: string, password?: string, ssl?: any, max?: number, connectionTimeoutMillis?: number, idleTimeoutMillis?: number}} [options] */
export function createPostgresPool({
  connectionString,
  environment = process.env,
  applicationName = 'trusted-routebook',
  host,
  port,
  database,
  user,
  password,
  ssl,
  max,
  connectionTimeoutMillis,
  idleTimeoutMillis
} = {}) {
  const resolvedConnectionString = String(connectionString ?? environment.DATABASE_URL ?? environment.POSTGRES_URL ?? '').trim();
  const pool = new Pool({
    ...(resolvedConnectionString ? { connectionString: resolvedConnectionString } : {}),
    ...(host !== undefined ? { host } : {}),
    ...(port !== undefined ? { port } : {}),
    ...(database !== undefined ? { database } : {}),
    ...(user !== undefined ? { user } : {}),
    ...(password !== undefined ? { password } : {}),
    ...(ssl !== undefined ? { ssl } : {}),
    application_name: applicationName,
    max: positiveInteger(max ?? environment.POSTGRES_POOL_MAX, 10),
    connectionTimeoutMillis: positiveInteger(connectionTimeoutMillis ?? environment.POSTGRES_CONNECT_TIMEOUT_MS, 5000),
    idleTimeoutMillis: positiveInteger(idleTimeoutMillis ?? environment.POSTGRES_IDLE_TIMEOUT_MS, 30000),
    statement_timeout: positiveInteger(environment.POSTGRES_STATEMENT_TIMEOUT_MS, 15000),
    query_timeout: positiveInteger(environment.POSTGRES_QUERY_TIMEOUT_MS, 20000),
    lock_timeout: positiveInteger(environment.POSTGRES_LOCK_TIMEOUT_MS, 5000),
    idle_in_transaction_session_timeout: positiveInteger(environment.POSTGRES_IDLE_TRANSACTION_TIMEOUT_MS, 15000)
  });
  pool.on('error', (error) => {
    process.stderr.write(
      `${JSON.stringify({
        level: 'error',
        event: 'postgres_pool_idle_error',
        code: typeof error?.code === 'string' ? error.code : 'POSTGRES_POOL_ERROR',
        message: redactPostgresError(error?.message)
      })}\n`
    );
  });
  return pool;
}

export async function withPostgresTransaction(pool, operation) {
  const client = await pool.connect();
  try {
    await client.query('begin');
    const result = await operation(client);
    await client.query('commit');
    return result;
  } catch (error) {
    await client.query('rollback').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export function redactPostgresError(value) {
  return String(value ?? '')
    .replace(/(postgres(?:ql)?:\/\/[^:\s/@]+:)[^@\s/]+@/gi, '$1[REDACTED]@')
    .replace(/(password\s*[=:]\s*)\S+/gi, '$1[REDACTED]');
}

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}
