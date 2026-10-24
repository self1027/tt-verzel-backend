import { createPublicKey, generateKeyPairSync } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export async function prepareDevelopmentKeys(privatePath, publicPath) {
  await mkdir(dirname(privatePath), { recursive: true, mode: 0o700 });
  await mkdir(dirname(publicPath), { recursive: true });
  let privatePem;
  try { privatePem = await readFile(privatePath, 'utf8'); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    privatePem = generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' });
    await writeFile(privatePath, privatePem, { flag: 'wx', mode: 0o600 });
  }
  const publicPem = createPublicKey(privatePem).export({ type: 'spki', format: 'pem' });
  await writeFile(publicPath, publicPem, { mode: 0o644 });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await prepareDevelopmentKeys(process.env.WITNESS_PRIVATE_KEY_FILE, process.env.WITNESS_PUBLIC_KEY_FILE);
  await import('../../dist/modules/audit/witness/main.js');
}
