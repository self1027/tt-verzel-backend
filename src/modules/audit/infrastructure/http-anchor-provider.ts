import type { AnchorPublisher, AnchorVerifier, Checkpoint, ExternalAnchor } from '../contracts/anchors.js';
import { pinnedKey, requireCheckpoint, requireIdentifier, validateAnchor } from '../witness/protocol.js';

export interface HttpAnchorProviderOptions {
  baseUrl: string;
  namespace: string;
  publicKey: string;
  publishToken?: string;
  timeoutMs?: number;
  allowInsecureHttpForDevelopment?: boolean;
}
/** The application has only the pinned public key; its database never discovers the witness head. */
export class HttpAnchorProvider implements AnchorPublisher, AnchorVerifier {
  private readonly publicKey;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  constructor(private readonly options: HttpAnchorProviderOptions) {
    requireIdentifier(options.namespace);
    const url = new URL(options.baseUrl);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('Invalid witness URL');
    if (url.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
      && !options.allowInsecureHttpForDevelopment) throw new Error('Witness requires HTTPS outside loopback');
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.publicKey = pinnedKey(options.publicKey);
    this.timeoutMs = options.timeoutMs ?? 5000;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs <= 0) throw new Error('Invalid witness timeout');
  }
  private endpoint(auctionId: string, action: string): string {
    requireIdentifier(auctionId);
    return `${this.baseUrl}/v1/namespaces/${encodeURIComponent(this.options.namespace)}/auctions/${encodeURIComponent(auctionId)}/${action}`;
  }
  private async request(auctionId: string, action: string, body?: unknown): Promise<ExternalAnchor | null> {
    const response = await fetch(this.endpoint(auctionId, action), {
      method: body === undefined ? 'GET' : 'POST', redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(this.timeoutMs),
      headers: { 'content-type': 'application/json', 'cache-control': 'no-cache', ...(body !== undefined && this.options.publishToken ? { authorization: `Bearer ${this.options.publishToken}` } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    // Bound untrusted witness responses before parsing or signature validation.
    const reader = response.body?.getReader();
    if (!reader) throw new Error('Empty witness response');
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.length;
      if (bytes > 16384) { await reader.cancel(); throw new Error('Witness response too large'); }
      chunks.push(chunk.value);
    }
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (body === undefined && response.status === 404 && (value as { error?: unknown } | null)?.error === 'NOT_FOUND') return null;
    if (!response.ok) throw new Error(`Witness request failed (${String(response.status)})`);
    return validateAnchor(value, this.options.namespace, auctionId, this.publicKey);
  }
  async latest(auctionId: string): Promise<ExternalAnchor | null> {
    return this.request(auctionId, 'latest');
  }
  async publish(checkpoint: Checkpoint, previous: ExternalAnchor | null): Promise<ExternalAnchor> {
    requireCheckpoint(checkpoint);
    if (previous) {
      validateAnchor(previous, this.options.namespace, checkpoint.auctionId, this.publicKey);
      if (BigInt(previous.sequence) >= BigInt(checkpoint.sequence)) throw new Error('Invalid previous checkpoint');
    }
    const receipt = await this.request(checkpoint.auctionId, 'checkpoints', {
      checkpoint, previous: previous ? { sequence: previous.sequence, hash: previous.hash } : null,
    });
    if (!receipt || receipt.sequence !== checkpoint.sequence || receipt.hash !== checkpoint.hash
      || receipt.previousSequence !== (previous?.sequence ?? '0') || receipt.previousHash !== (previous?.hash ?? '0'.repeat(64))) throw new Error('Witness publication mismatch');
    return receipt;
  }
}
