# Optional demonstration seed

Run the foundational seed first, then call `seedDemonstration(db)` from
`src/shared/database/demo-seed.ts`. The foundational seed remains unchanged;
tests and installations that need zero wallets can continue using it alone.
The demonstration seed performs no network requests and never changes passwords.

On first installation it creates a local product snapshot and one PUBLISHED lot
that is LIVE immediately for two hours. Starting amount is 1000 cents and minimum
increment is 100 cents. No synthetic bids are inserted. The initial audited event
uses a creation time two seconds before the database clock and a start one second
before it, preserving the audit rule that creation precedes the start. The event
and pending witness anchor commit with the auction.

The snapshot is an explicit public-field whitelist copied from
`tests/fixtures/dummyjson/product_1.json`, validated with the same DummyJSON schema
as the catalog adapter. It contains no reviews, reviewer identities, or external
price. Provenance is recorded in `attributes.demoProvenance`; source is
`dummyjson-demo-fixture`. The copied fields live under `src`, so compiled Docker
images do not need test fixtures.

Stable identifiers:

| Record | UUID |
| --- | --- |
| Snapshot | `d3b80001-34ef-4000-8000-000000000001` |
| Auction | `d3b80001-34ef-4000-8000-000000000002` |

Each seeded demo bidder receives a simulated deposit of 100000 cents only when
their wallet has zero balance, zero reserved amount, no ledger entries, and no
reservation history. The existing WalletService writes balanced ledger entries
using `deposit:<userId>:demo-bootstrap-v1`. Existing funds or history cause funding
to be skipped; spent funds are never replenished on restart. This is simulated
demonstration credit, not a payment integration.

One transaction advisory lock serializes concurrent runs. Wallet rows are locked
in UUID order before the new auction is created, and existing wallet service
transactions use savepoints inside the outer transaction. Funding, snapshot,
auction, and audit writes all commit or roll back together.

Reruns preserve the existing demonstration auction exactly, including its dates
and terminal state. They never silently extend or reopen an expired lot. For a
fresh scenario, use a fresh disposable database or explicitly create a new lot
through the authenticated API using a stored snapshot and future start/end times.
Do not delete or rewrite the existing demo auction or financial history to reset
the demonstration. A separate automatic scenario-reset command is not provided.
