# Requirements traceability

Source: `requirements.pdf`, all seven pages visually reviewed during this task.
This matrix covers backend scope. Frontend implementation and deployment remain
outside this repository/task. Evidence paths identify implementation and runnable
tests, rather than claiming that a file's presence proves the requirement.

| PDF area | Initial backend | Final backend status | Implementation and verification evidence |
| --- | --- | --- | --- |
| p1: technical challenge context | Existing TypeScript backend | Backend scope retained | `src/server.ts`; `package.json`; frontend/deployment exclusions below |
| p2, p4: authentication and roles | Implemented | Complete: seeded AUCTIONEER/BIDDER, JWT, server authorization | `src/modules/auth/`; `tests/integration/auth.test.js` |
| p2, p4: catalog and imported local product snapshots | Implemented | Complete: public whitelist, no external calls when reading imported lots | `src/modules/catalog/`; `tests/integration/catalog.test.js`; `tests/integration/auctions.test.js` |
| p3, p4: auction lifecycle and management | Implemented | Complete within the two defined roles: owner create/edit, safe no-bid cancellation, public lifecycle | `src/modules/auctions/`; `tests/integration/auctions.test.js`; `tests/integration/auctions-concurrency.test.js` |
| p4: live bids, minimum increments, leader | Implemented | Complete: validated database clock and complete bid history; current leader cannot rebid | `src/modules/bids/domain/bid-rules.ts`; `tests/integration/bids-flow.test.js`; `tests/integration/bids-concurrency.test.js` |
| p4: anti-sniping | Implemented | Complete: accepted bid with remaining time in (0,120s] extends existing deadline by 120s | `src/modules/bids/domain/bid-rules.ts`; `tests/integration/bids-flow.test.js`; `tests/integration/bid-idempotency.test.js` |
| p4: wallet reservations and displaced leader release | Implemented | Complete: transactional reservation; available balance excludes reserved funds | `src/modules/wallets/`; `tests/integration/reservations.test.js`; `tests/integration/bids-concurrency.test.js` |
| p4: winner settlement and no-bid close | Schema only | Implemented: automatic worker; verified proof recheck under locks; atomic capture, ledger, state and audit; retry/backoff | `src/modules/settlements/services/settlement-service.ts`; `src/modules/settlements/workers/settlement-worker.ts`; `tests/integration/settlements.test.js`; `tests/integration/settlement-concurrency.test.js`; `tests/integration/reservation-capture.test.js` |
| p2, p3: shareable public receipt | Absent | Implemented: persisted financial consistency checks; pseudonymous winner; public REST URL | `src/modules/settlements/services/receipt-service.ts`; `tests/integration/receipts.test.js` |
| p2, p3, p4: public tamper evidence without PII | Implemented | Extended: independent witness plus full operational replay; settlement deferred without verified proof; TAMPERED reported without unsafe automatic financial changes | `src/modules/audit/`; `src/modules/settlements/infrastructure/settlement-proof.ts`; `tests/integration/audit-adversarial.test.js`; `tests/integration/audit-public.test.js`; `tests/integration/settlement-concurrency.test.js` |
| p3: live updates | Absent | Implemented: six public Socket.IO hints after commit, room isolation, REST recovery | `src/modules/realtime/auction-sockets.ts`; `src/shared/events/auction-events.ts`; `tests/realtime.test.js`; `tests/integration/notifications.test.js` |
| p5: demonstration users and available lot | Users and empty wallets only | Implemented: optional offline snapshot, audited initially LIVE lot, idempotent simulated deposits for pristine wallets; repeated seeds preserve history and dates | `src/shared/database/demo-seed.ts`; `src/shared/database/demo-product.ts`; `tests/integration/demo-seed.test.js`; `docs/demo-seed.md` |
| p6 optional: search/filter | Lifecycle and skip only | Complete: SQL title search, current-price range, four sorts, page/legacy skip, consistent total | `src/modules/auctions/controllers/auction-controller.ts`; `src/modules/auctions/repositories/drizzle-auction-repository.ts`; `tests/auction-filters.test.js`; `tests/integration/auction-filters.test.js`; `docs/auction-filters.md` |
| p6 optional: cancellation/refund administration | Seller no-bid cancellation only; no admin role | PARTIAL: safe no-bid seller cancellation retained; auctions with bids cannot be cancelled; no seller undo or reserve refund for incident cancellation | `src/modules/auctions/services/auction-service.ts`; `tests/integration/auctions.test.js`; two-role model in `src/modules/users/contracts/user-reader.ts` |
| p5: startup and API documentation | Partial | Updated: OpenAPI artifact, frontend handoff, seed guidance and traceability | `docs/openapi.json`; `tests/openapi.test.js`; `docs/frontend-integration.md`; repository README |
| p2, p7: React frontend and deployment/delivery | Outside backend | Pending/outside task: no React application or live hosted frontend/backend produced | Handoff in `docs/frontend-integration.md`; root implementation report records executed checks and delivery scope |

Cancellation with bids needs a separately authorized administrator model and an
audited policy for reservations, ledger effects, incidents and terminal states.
The existing seller role does not confer that authority. `TAMPERED` blocks unsafe
settlement; it does not trigger automatic cancellation or refund.

Realtime delivery is best effort in one running process, with no durable message
queue or Redis adapter. Clients rejoin and resynchronize through REST. Receipt
availability indicates a persisted financial settlement; independent audit
verification is a separate status and may still be pending or unavailable.

The root implementation report records final command outcomes and any remaining
limitations. This matrix intentionally does not freeze changing test counts.
