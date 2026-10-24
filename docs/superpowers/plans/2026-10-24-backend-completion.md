# Backend completion plan

**Spec:** current user mission + all seven pages of requirements.pdf visually reread before edits.
**Goal:** finish the existing backend, including explicit search/filter optional, without frontend/deploy.
**Architecture:** existing ports/adapters and transaction-bound ledger/reservations/audit; simple polling.
**Constraints:** <=500 additions+deletions per commit; no push; no private keys/versioned real secrets.

## Initial traceability

| PDF | Requirement | Initial state/evidence | Required action |
| --- | --- | --- | --- |
| p2,p4 | roles/auth | existing auth middleware + tests | regress, preserve |
| p2,p4 | local product snapshots/external outage | catalog adapter + tests | regress |
| p3,p4 | auctions lifecycle/admin | auctions services + tests | preserve cancellation policy |
| p4 | live/minimum/leader/anti-sniping/reserves | bids service + PostgreSQL concurrency tests | regress against settlement |
| p4 | settlement/winner/no bids | schema only, capture absent | implement atomic service/worker/capture |
| p2,p3 | shareable public receipt | absent | implement persisted public REST representation |
| p2,p3,p4 | public tamper audit/no PII | implemented with witness/outbox | verified preflight and locked token recheck |
| p3 | live updates | absent | Socket.IO best-effort after commit + REST recovery |
| p5 | demo users/open lot | users/wallet seed only | separate idempotent audited demo seed, no repeated bids |
| p6 optional | search/filter | lifecycle+skip only | extend GET /auctions PostgreSQL filters/sort/page |
| p6 optional | cancellation/refund | only no-bid cancel; no admin role | preserve safe no-bid flow; reject inconsistencies; document no authority for bidder-reserve incident cancellation |
| p5 | README/run docs | partially current | update matrix/API/OpenAPI/frontend guide |
| p2,p7 | React/deploy | outside this repo/task | explicitly pending, no deploy |

## Ownership and dependencies

1. Agent filters owns auction contracts/controller/repository and filter tests/docs section only.
2. Agent capture owns wallet reservation adapter+capture financial tests, existing contract reused.
3. Agent frontend owns shared/http/cors.ts, realtime/*, app.ts options integration + CORS/socket tests.
4. Lead owns settlement contracts/service/repos/worker/receipt, seed, server/composition and migrations.
5. After first wave, agents independently test settlement concurrency/audit TOCTOU and review docs/requirements.

No shared edits before ownership release. Max3 children+lead. PostgreSQL tests each use UUID schema.
Missing local TEST_DATABASE_URL caused initial DB failures; use explicit disposable Compose test URL.

## Decisions

- No admin exists: do not authorize seller to cancel a bid winner or a TAMPERED incident.
- External verification before BEGIN financial locks. Proof binds last seq/hash + canonical operational snapshot + seller identity as observed.
- After auction lock and financial lock waits, reread DB clock/state/proof; abort/defer if any verified position changed.
- Existing terminal settlement may replay locally without requiring its new event to have been anchored yet.
- Capture uses caller key `settlement:<auctionId>` in existing ledger, referenceId=reservationId, exact paired entries.
- Public notifications via AuctionEventSink (new shared pure port); never network inside transaction; best effort, client REST re-fetch mandatory.
- Socket.IO is required, so add socket.io runtime + socket.io-client test dependency. No broker/Redis.
- Query price means current own-auction bid amount or startingBidCents; all filters/count/order/offset in PostgreSQL.
- Keep legacy skip; page is one-based, reject explicit page+skip, default ordering unchanged.
- Demo seed separate from foundational seed so old test fixtures/zero wallets remain unchanged.

## Execution checklist

- [x] Baseline actual unit/PG/lint/typecheck/build, record environment failure and corrected run.
- [x] Independent filters, capture and Socket/CORS work in parallel with tests first.
- [x] Implement verified proof gate, capture-backed settlement and no-bid close, concurrent/idempotent rollback tests.
- [x] Implement retry/backoff worker, incidents and graceful stop, no external work while locked.
- [x] Public receipt + query validation + economic consistency checks.
- [x] Safe cancellation reason/event/invariant handling within existing roles; document authorization limit.
- [x] Idempotent demo snapshot/open lot and consistent simulated deposits without changing existing users.
- [x] Compose starts all workers + CORS/env; actual end-to-end Docker bid/settlement/receipt/socket test.
- [x] OpenAPI maintained/validated + matrix/report + final full checks + independent review.
- [x] Local commits <=500 lines, no push (staged line-count guard for each commit).

Final ownership: after initial release, frontend agent implemented receipts,
filters agent implemented seed/docs, capture agent added adversarial/worker tests.
Lead integrated and a fresh fourth reviewer performed a read-only final review.
Evidence: 94 unit/HTTP/provider passes + one Windows privilege skip; 195 PG passes;
lint/typecheck/build and actual Compose settlement/outage recovery passed.
