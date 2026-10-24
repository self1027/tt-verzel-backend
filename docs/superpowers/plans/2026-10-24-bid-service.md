# BidService implementation plan

> Execution authorized by the user: specialized subagents in parallel; lead integrates and verifies.

**Goal:** transactional PlaceBid with one funded leader, persistent replay and existing audit outbox.
**Architecture:** bids domain/contracts; transaction-bound wallet and audit adapters; Node service
coordinates READ COMMITTED, PostgreSQL serializes writes. No external calls while locked.
**Spec:** requirements.pdf all seven scanned pages reread visually; explicit current user brief.
**Stack:** preserve Express/Drizzle/PostgreSQL/node:test, no new dependencies.

## Findings and global constraints

- Baseline HEAD 8d54bcb; user-staged temp/ must remain byte-for-byte staged and outside our commits.
- Max500 additions+deletions/commit, no push; commit with explicit pathspec so staged temp/ is preserved.
- Graph has417 nodes built at96206370, before wallets/audit; inspect graph then real source.
- ReservationOperations is a port only; reserve/release implementation missing.
- ACTIVE-per-auction uniqueness is absent in actual schema; add partial unique index, never rewrite old migration.
- AuditAppender(tx), BID_ACCEPTED payload, bidderReference and durable audit_anchors outbox already work.
- External production witness still unconfigured; preserve documented anchored-prefix limits.
- Anti-sniping ambiguity in PDF page4 is resolved explicitly by user: old endsAt+120000ms, never now+120000ms.
- Capture/settlement, sockets, UI and deployment remain out of scope.

## Shared contracts before parallel implementation

`src/modules/bids/contracts/bids.ts` defines BidAuction, Bid, PublicBid/BidReceipt,
BidWriteContext, BidRepository, query ports and operation-store ports. Domain API:
`validateBid(auction:BidAuction,current:Bid|null,userId:string,amount:bigint,now:Date):Date`
returns resulting endsAt or typed AppError. `validateHistory(auction:BidAuction,bids:Bid[]):Bid|null`
checks contiguous seq, pointer, amount/ownership consistency; internal corruption =>409.

Reservation adapter API: `DrizzleReservationOperations implements Pick<ReservationOperations,
'reserveFunds'|'releaseReservation'>`; `lockReservationWallets(tx,walletIds:string[]):Promise<BidWallet[]>`
(public wallet DTO may be declared locally structurally, no dependency on bids domain).
Explicit sorted UUID loop acquires wallet locks BEFORE any reservation FOR UPDATE.
Methods reacquire only locks already held by BidService; standalone methods lock parent auction,
wallet(s), then reservation. Never implement capture early. Check reserved sum vs ACTIVE rows.

Idempotency API: `bidFingerprint(amountCents:bigint):string` SHA256 of versioned canonical payload;
`DrizzleBidOperationStore(tx)` implements port. Table bid_operations: id UUID PK, userId FK,
auctionId FK, key varchar128, fingerprint varchar64, bidId FK unique, result JSON, createdAt.
Unique(userId,auctionId,key); operation is implicit PlaceBid. Key bound to canonical amount.

## Ownership / execution waves

1. A: bids/domain/bid-rules.ts, tests/bid-rules.test.js (pure validation/minimum/anti-sniping).
2. B: wallets/repositories/drizzle-reservation-operations.ts, tests/integration/reservations.test.js.
   No schema edits. Wait for root migration before PostgreSQL green checks if needed.
3. C: bids/infrastructure/operations.schema.ts, bids/repositories/drizzle-bid-operation-store.ts,
   bids/domain/idempotency.ts, tests/integration/bid-idempotency.test.js. No migration/shared exports edits.
4. Lead: migrations/schema exports/tests updates, BidService, DrizzleBidRepository, shared fixtures.
5. When A completes: E owns controller/query repository (contracts stable); root composition only.
6. When C completes: D reviews/integrates audit strict anti-sniping replay + rollback tests.
7. When B completes: F real concurrency/adversarial integration tests using root fixtures.
8. Independent final read-only review after integration, lead fixes findings and writes report.

Max3 children+lead; roles run in waves, not six simultaneous agents. Unique schemas isolate suites.
Only lead edits shared files, migrations or commits. Agents write tests first and record red/green.

## PlaceBid sequence

- [x] Validate syntax/key/positiveBIGINT outside tx; lock auction first and read DB wallclock.
- [x] Check current user exists/BIDDER. Read idempotency BEFORE current business state; replay original result.
- [x] Validate contiguous history/current pointer, LIVE/minimum/not-own-lead/sequence overflow.
- [x] Resolve both wallets, lock actual wallet UUIDs ascending, then all active auction reservations.
- [x] Check only prior leader has exact ACTIVE reservation, matching user/bid/amount; validate wallet invariants.
- [x] Re-read DB clock after lock waits; revalidate LIVE and compute old endsAt+2min if remaining<=2min.
- [x] Check available balance, release old reservation, insert bid, reserve new funds, update pointer/endsAt.
- [x] Append BID_ACCEPTED to existing audit in tx, persist immutable operation receipt, COMMIT.
- [x] Only durable existing worker publishes anchors after commit; no premature sockets or external calls.

## Validation and review focus

- [x] Baseline and final npm test/test:db/lint/typecheck/build.
- [x] Required28 PostgreSQL scenarios from brief, including23 same-user concurrent attempts.
- [x] Barrier/pg_blocking_pids synchronization; no reliance solely on HTTP arrival order/timeouts.
- [x] Cross-auction shared-wallet contention, crossed wallet order, deposit-vs-reserve and expiration after waits.
- [x] Rollback after old reservation release/audit failure/operation-save failure restores all rows.
- [x] Replay after leader/status/deadline changes, same-key payload conflict and concurrent dedup.
- [x] Public pages pseudonymized, private mine scoped, strict duplicate Idempotency-Key/queries/body validation.
- [x] Exact120000ms boundary, successive extensions based on olddeadline; rejected bids never extend.
- [x] Preserve existing tests; document additive constraints require cleanup of invalid legacy ACTIVE rows.
- [x] Full PT-BR docs/implementation-reports/bid-service.md and API guide, honest remaining limitations.
