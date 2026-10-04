import crypto from 'node:crypto';
import { createDb } from '../../src/server/db';

/**
 * Real-PostgreSQL tests run only when TEST_DATABASE_URL is set (CI provides a Postgres
 * service). Each test gets its own throw-away database so test files can run in parallel.
 */
export const PG_URL = process.env.TEST_DATABASE_URL;

export async function withTempDatabase<T>(fn: (url: string) => Promise<T>): Promise<T> {
  const base = new URL(PG_URL!);
  if (!/test/i.test(base.pathname)) throw new Error('TEST_DATABASE_URL must name a disposable *test* database');
  const name = `govcheck_test_${crypto.randomBytes(4).toString('hex')}`;
  const admin = await createDb({ databaseUrl: PG_URL, pgliteDir: '' });
  await admin.exec(`CREATE DATABASE ${name}`);
  const url = new URL(PG_URL!);
  url.pathname = `/${name}`;
  try {
    return await fn(url.toString());
  } finally {
    await admin.exec(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`).catch(() => undefined);
    await admin.close();
  }
}
