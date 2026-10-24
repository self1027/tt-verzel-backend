import type { SettlementRepository, SettlementUseCases } from '../contracts/settlements.js';

interface WorkerOptions {
  now?: () => number; baseDelayMs?: number; maxDelayMs?: number; batchSize?: number;
  log?: (entry: { auctionId: string; status: string; reason?: string }) => void;
}

export class SettlementWorker {
  private timer: ReturnType<typeof setInterval> | undefined;
  private inFlight: Promise<void> | null = null;
  private stopping = false;
  private readonly retries = new Map<string, { attempt: number; at: number }>();
  constructor(private readonly repository: Pick<SettlementRepository, 'due'>, private readonly service: SettlementUseCases,
    private readonly options: WorkerOptions = {}) {}

  runOnce(): Promise<void> {
    if (this.stopping) return Promise.resolve();
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.cycle().finally(() => { this.inFlight = null; });
    return this.inFlight;
  }

  private async cycle(): Promise<void> {
    const now = this.options.now ?? Date.now;
    const excluded = [...this.retries].filter(([, retry]) => retry.at > now()).map(([id]) => id);
    const ids = await this.repository.due(this.options.batchSize ?? 20, excluded);
    for (const id of ids) {
      if (this.stopping) break;
      if ((this.retries.get(id)?.at ?? 0) > now()) continue;
      let retry: boolean;
      try {
        const result = await this.service.settle(id);
        retry = result.status === 'DEFERRED' || result.status === 'TAMPERED';
        this.options.log?.({ auctionId: id, status: result.status, ...(result.reason ? { reason: result.reason } : {}) });
      } catch { retry = true; this.options.log?.({ auctionId: id, status: 'RETRY', reason: 'PROCESSING_FAILED' }); }
      if (retry) {
        const attempt = (this.retries.get(id)?.attempt ?? 0) + 1;
        const delay = Math.min(this.options.maxDelayMs ?? 60000, (this.options.baseDelayMs ?? 1000) * 2 ** Math.min(attempt - 1, 16));
        this.retries.set(id, { attempt, at: now() + delay });
      } else this.retries.delete(id);
    }
  }

  start(intervalMs = 2000): void {
    if (!Number.isSafeInteger(intervalMs) || intervalMs < 100) throw new Error('Settlement interval must be at least 100ms');
    if (this.timer) return;
    this.stopping = false;
    const run = (): void => { void this.runOnce().catch(() => { this.options.log?.({ auctionId: '', status: 'RETRY', reason: 'DISCOVERY_FAILED' }); }); };
    this.timer = setInterval(run, intervalMs);
    this.timer.unref();
    run();
  }

  async stop(): Promise<void> { this.stopping = true; clearInterval(this.timer); this.timer = undefined; await this.inFlight; }
}
