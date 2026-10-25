import type { Request, Response } from 'express';
import { z } from 'zod';
import type { AuditEvent, AuditRepository } from '../contracts/audit.js';
import { AuditCorruptionError } from '../contracts/errors.js';
import type { AuditVerifier } from '../services/audit-verifier.js';
import { hashEvent } from '../domain/cryptography.js';

const query = z.strictObject({
  after: z.string().regex(/^(0|[1-9]\d{0,18})$/).transform(BigInt).pipe(z.bigint().max(9223372036854775807n)).default(0n),
  limit: z.string().regex(/^[1-9]\d{0,2}$/).transform(Number).pipe(z.number().max(100)).default(30),
});

export class AuditController {
  constructor(private readonly repository: AuditRepository, private readonly verifier: AuditVerifier) {}

  verify = async (request: Request, response: Response): Promise<void> => {
    const id = z.uuid().parse(request.params.id).toLowerCase();
    z.strictObject({}).parse(request.query);
    response.setHeader('Cache-Control', 'no-store');
    const result = await this.verifier.verify(id);
    response.status(result.status === 'VERIFICATION_UNAVAILABLE' ? 503 : 200).json(result);
  };

  events = async (request: Request, response: Response): Promise<void> => {
    const id = z.uuid().parse(request.params.id).toLowerCase();
    const input = query.parse(request.query);
    response.setHeader('Cache-Control', 'no-store');
    let events: AuditEvent[];
    try { events = await this.repository.page(id, input.after, input.limit); }
    catch (error) {
      if (!(error instanceof AuditCorruptionError)) throw error;
      await this.verifier.verify(id);
      response.json({ auctionId: id, status: 'TAMPERED', reason: 'INVALID_PUBLIC_EVENT', events: [] });
      return;
    }
    // Public data is untrusted even when read from our database. Reject the entire page on invalid payloads.
    try {
      for (const event of events) {
        const { eventHash, ...unsigned } = event;
        if (!/^[a-f0-9]{64}$/.test(eventHash) || hashEvent(unsigned) !== eventHash) throw new Error('Invalid public event');
      }
    } catch {
      await this.verifier.verify(id);
      response.json({ auctionId: id, status: 'TAMPERED', reason: 'INVALID_PUBLIC_EVENT', events: [] });
      return;
    }
    response.json({ auctionId: id, events: events.map((event) => ({ ...event, sequence: String(event.sequence) })),
      nextAfter: events.at(-1)?.sequence.toString() ?? input.after.toString(), limit: input.limit,
      proof: 'EVENT_PAGE_ONLY' });
  };
}
