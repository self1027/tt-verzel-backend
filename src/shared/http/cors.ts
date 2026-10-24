import type { RequestHandler } from 'express';

export function readCorsOrigins(env: Record<string, string | undefined>): string[] {
  const origins = env.CORS_ORIGINS?.split(',').map(value => value.trim()).filter(Boolean) ?? [];
  for (const origin of origins) {
    try {
      const url = new URL(origin);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.origin !== origin || origin.includes('*')) throw new Error();
    } catch {
      throw new Error('Invalid CORS_ORIGINS: expected comma-separated exact HTTP(S) origins');
    }
  }
  return [...new Set(origins)];
}

export function corsMiddleware(origins: string[]): RequestHandler {
  return (request, response, next) => {
    response.vary('Origin');
    const origin = request.headers.origin;
    if (origin && origins.includes(origin)) {
      response.setHeader('Access-Control-Allow-Origin', origin);
      if (request.method === 'OPTIONS') {
        response.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, OPTIONS');
        response.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Idempotency-Key');
        response.status(204).end();
        return;
      }
    }
    next();
  };
}
