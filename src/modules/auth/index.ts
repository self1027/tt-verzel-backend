import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import type { Database } from '../../shared/database/client.js';
import type { AuthConfig } from '../../shared/config.js';
import { DrizzleUserReader } from '../users/repositories/drizzle-user-reader.js';
import { ArgonPasswords } from './infrastructure/argon-passwords.js';
import { JwtTokens } from './infrastructure/jwt-tokens.js';
import { AuthService } from './services/auth-service.js';
import { AuthController } from './controllers/auth-controller.js';
import { authentication } from './middleware/authentication.js';
import { loginRateLimit } from './infrastructure/login-rate-limit.js';

export async function createAuthModule(
  database: Database, config: AuthConfig,
): Promise<{ router: Router; authenticate: ReturnType<typeof authentication> }> {
  const passwords = new ArgonPasswords();
  const service = new AuthService(
    new DrizzleUserReader(database), passwords, new JwtTokens(config),
    await passwords.hash(randomUUID()), config.jwtExpiresInSeconds,
  );
  const controller = new AuthController(service);
  const authenticate = authentication(service);
  const router = Router();
  router.use((_request, response, next) => {
    response.setHeader('Cache-Control', 'no-store');
    next();
  });
  router.post('/login', loginRateLimit(database), controller.login);
  router.get('/me', authenticate, controller.me);
  return { router, authenticate };
}
