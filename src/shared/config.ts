import { z } from 'zod';
import { isIP } from 'node:net';

export function readTrustedProxies(env: Record<string, string | undefined>): string[] {
  if (!env.TRUST_PROXY_CIDRS?.trim()) return [];
  return env.TRUST_PROXY_CIDRS.split(',').map(value => {
    const entry = value.trim();
    const [address = '', bits, ...extra] = entry.split('/');
    const version = isIP(address);
    const maximum = version === 4 ? 32 : 128;
    if (!version || extra.length || (bits !== undefined && (!/^\d+$/.test(bits) || Number(bits) < 1 || Number(bits) > maximum))) {
      throw new Error('TRUST_PROXY_CIDRS must contain explicit trusted IP addresses or CIDRs');
    }
    return entry;
  });
}

const password = z.string().min(12).max(1024);
const databaseURL = z.url().refine((value) => ['postgres:', 'postgresql:'].includes(new URL(value).protocol));

export function readSeedConfig(env: Record<string, string | undefined>) {
  const parsed = z.object({
    SEED_AUCTIONEER_PASSWORD: password,
    SEED_BIDDER1_PASSWORD: password,
    SEED_BIDDER2_PASSWORD: password,
  }).parse(env);
  return {
    auctioneerPassword: parsed.SEED_AUCTIONEER_PASSWORD,
    bidder1Password: parsed.SEED_BIDDER1_PASSWORD,
    bidder2Password: parsed.SEED_BIDDER2_PASSWORD,
  };
}

export type SeedConfig = ReturnType<typeof readSeedConfig>;

export function readDatabaseURL(env: Record<string, string | undefined>): string {
  return databaseURL.parse(env.DATABASE_URL);
}

export function readAuthConfig(env: Record<string, string | undefined>) {
  const parsed = z.object({
    JWT_SECRET: z.string().refine((value) => Buffer.byteLength(value, 'utf8') >= 32, 'JWT_SECRET must contain at least 32 bytes'),
    JWT_EXPIRES_IN_SECONDS: z.coerce.number().int().min(1).max(86400).default(3600),
  }).parse(env);
  return { jwtSecret: parsed.JWT_SECRET, jwtExpiresInSeconds: parsed.JWT_EXPIRES_IN_SECONDS };
}

export type AuthConfig = ReturnType<typeof readAuthConfig>;

export function readPort(env: Record<string, string | undefined>): number {
  return z.coerce.number().int().min(1).max(65535).default(3000).parse(env.PORT);
}

export function readCatalogTimeout(env: Record<string, string | undefined>): number {
  return z.coerce.number().int().min(1).max(30000).default(5000).parse(env.DUMMYJSON_TIMEOUT_MS);
}

export function readSettlementInterval(env: Record<string, string | undefined>): number {
  return z.coerce.number().int().min(100).max(60000).default(2000).parse(env.SETTLEMENT_POLL_MS);
}
