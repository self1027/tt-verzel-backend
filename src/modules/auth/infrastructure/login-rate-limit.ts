import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import { sql, lte } from 'drizzle-orm';
import type { RequestHandler } from 'express';
import type { Database } from '../../../shared/database/client.js';
import { AppError } from '../../../shared/http/app-error.js';
import { loginRateLimits } from './rate-limit.schema.js';

function clientAddress(ip: string): string {
  const version = isIP(ip);
  if (!version) throw new AppError(400, 'INVALID_CLIENT_ADDRESS', 'Invalid client address');
  if (version === 4) return ip;
  const canonical = new URL(`http://[${ip}]`).hostname;
  const mapped = /^\[::ffff:([0-9a-f]+):([0-9a-f]+)\]$/.exec(canonical);
  if (mapped) {
    const high = Number.parseInt(mapped[1] ?? '', 16), low = Number.parseInt(mapped[2] ?? '', 16);
    return `${String(high >> 8)}.${String(high & 255)}.${String(low >> 8)}.${String(low & 255)}`;
  }
  return canonical;
}

/** Shared PostgreSQL budgets: fixed expiry is never extended by blocked requests. */
export function loginRateLimit(db: Database, limits = { perIp: 30, perAccount: 10 }): RequestHandler {
  return async (request, response, next) => {
    const ip = clientAddress(request.ip ?? request.socket.remoteAddress ?? '');
    const body: unknown = request.body;
    const email = body && typeof body === 'object' && 'email' in body && typeof body.email === 'string'
      ? body.email.trim().toLowerCase() : null;
    const buckets: [string, number][] = [[`ip:${ip}`, limits.perIp]];
    if (email && email.length <= 255) buckets.push([`account:${email}`, limits.perAccount]);
    const wait = await db.transaction(async tx => {
      await tx.delete(loginRateLimits).where(lte(loginRateLimits.expiresAt, sql`clock_timestamp() AT TIME ZONE 'UTC'`));
      // IP first, then at most one account: all requests acquire shared rows in this order.
      for (const [identity, budget] of buckets) {
        const key = createHash('sha256').update('verzel:login-budget:v1\0').update(identity).digest('hex');
        const [row] = await tx.insert(loginRateLimits).values({ key, attempts: 1,
          expiresAt: sql`(clock_timestamp() AT TIME ZONE 'UTC') + interval '60 seconds'` })
          .onConflictDoUpdate({ target: loginRateLimits.key, set: { attempts: sql`least(${loginRateLimits.attempts} + 1, ${budget + 1})` } })
          .returning({ attempts: loginRateLimits.attempts,
            wait: sql<number>`greatest(1, ceil(extract(epoch from (${loginRateLimits.expiresAt} - (clock_timestamp() AT TIME ZONE 'UTC')))))::int` });
        if (!row) throw new Error('Login budget unavailable');
        if (row.attempts > budget) return row.wait;
      }
      return 0;
    });
    if (wait) {
      response.setHeader('Retry-After', String(wait));
      throw new AppError(429, 'TOO_MANY_LOGIN_ATTEMPTS', 'Too many login attempts; retry later');
    }
    next();
  };
}
