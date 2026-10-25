# Cancelamento e recuperação financeira — relatório

## Checkpoints

1. Bloqueio persistente de TAMPERED sob o lock de auctions. PENDING_ANCHOR e
   VERIFICATION_UNAVAILABLE mantidos distintos. Concluído.
2. Tentativa imediata, fila persistente, alvo de 180 segundos, rollback financeiro,
   idempotência e retomada pelo worker. Capturas exigem compensação. Concluído.
3. Contratos e interface atualizados após concluir o backend e o trabalho de dark
   mode do outro agente. Vitrine exclui cancelados/incidentes; links e painel do
   proprietário preservam histórico. Concluído.
4. Testes, lint, typecheck, build e revisão independente. Resultados abaixo.

## Validação

- Backend: `npm test`: 101 aprovados; um teste opcional de banco ignorado, conforme
  configuração existente. `npm run lint`, `npm run typecheck` e `npm run build`: aprovados.
- Integração PostgreSQL: 230 aprovados na suíte completa com
  `node --import tsx --test --test-concurrency=1 tests/integration/*.test.js`.
- Frontend: `npm test`: 31 aprovados em 11 arquivos. `npm run lint`,
  `npm run typecheck` e `npm run build`: aprovados.
- Playwright: 37 aprovados nas suítes recovery, audit, bidding, seller,
  public-auctions e theme. Inclui tema claro/escuro, larguras de 375/1440px,
  bloqueio visual e distinção entre os estados de integridade.
- Screenshots de recuperação inspecionados nos dois temas; sem overflow horizontal.
- Revisão independente identificou duas omissões, corrigidas com testes que
  falharam antes da correção: corrupção de timestamp no worker de âncoras e
  adulteração ao ler comprovante liquidado. Nova revisão sem achados importantes.
- Ajuste nas fixtures: pool comporta os 23 concorrentes do teste de lances mais
  observadores de locks, evitando esgotamento que bloqueava a própria observação.

## Limitações e operação

Aplicar a nova migration antes de iniciar a API atualizada. Ela foi aplicada
somente em banco/schemas de teste. Não foi feito commit, push, deploy ou alteração
no banco da API em execução. Dark mode preservado.

Três minutos é prazo-alvo após detecção, sem promessa de liberação durante falhas.
O processamento exige API/worker e PostgreSQL disponíveis e continua após o alvo.
Não há varredura de todos os lotes já ancorados: auditoria, âncoras pendentes,
settlement e comprovantes encaminham detecções confirmadas; o detalhe consulta a
verificação. Dados capturados não são estornados: exigem compensação específica.

O incidente separado registra cancelamento após liberação confirmada e conserva
as evidências; não repara nem substitui a cadeia comprometida por uma nova prova
independente. Detalhes em [auction-recovery.md](../auction-recovery.md).

## Arquivos alterados ou adicionados

## back-verzel

- `docs/auction-recovery.md`
- `docs/auctions.md`
- `docs/implementation-reports/cancellation-recovery.md`
- `docs/openapi.yaml`
- `docs/superpowers/plans/2026-10-25-cancellation-recovery.md`
- `drizzle/20261025050827_clever_vivisector/migration.sql`
- `drizzle/20261025050827_clever_vivisector/snapshot.json`
- `src/modules/auctions/contracts/auctions.ts`
- `src/modules/auctions/infrastructure/recovery-guard.ts`
- `src/modules/auctions/infrastructure/recovery.schema.ts`
- `src/modules/auctions/repositories/drizzle-auction-repository.ts`
- `src/modules/auctions/services/recovery-service.ts`
- `src/modules/audit/controllers/audit-controller.ts`
- `src/modules/audit/index.ts`
- `src/modules/audit/services/anchor-worker.ts`
- `src/modules/audit/services/audit-verifier.ts`
- `src/modules/bids/repositories/drizzle-bid-repository.ts`
- `src/modules/settlements/index.ts`
- `src/modules/settlements/infrastructure/settlement-proof.ts`
- `src/modules/settlements/repositories/drizzle-receipt-repository.ts`
- `src/modules/settlements/repositories/drizzle-settlement-repository.ts`
- `src/modules/settlements/workers/settlement-worker.ts`
- `src/modules/wallets/repositories/drizzle-reservation-operations.ts`
- `src/shared/database/schema.ts`
- `tests/helpers/auctions.js`
- `tests/helpers/bids.js`
- `tests/helpers/database.js`
- `tests/integration/auction-filters.test.js`
- `tests/integration/auctions.test.js`
- `tests/integration/cryptographic-binding.test.js`
- `tests/integration/recovery.test.js`
- `tests/integration/settlement-concurrency.test.js`
- `tests/schema.test.js`

## front-verzel

- `contracts/openapi.json`
- `e2e/audit.spec.ts`
- `e2e/recovery.spec.ts`
- `src/api/generated/schema.d.ts`
- `src/features/auctions/components/AuctionRecoveryNotice.css`
- `src/features/auctions/components/AuctionRecoveryNotice.test.tsx`
- `src/features/auctions/components/AuctionRecoveryNotice.tsx`
- `src/features/auctions/components/AuctionStatus.tsx`
- `src/features/auctions/components/BidForm.tsx`
- `src/features/auctions/pages/AuctionDetailPage.tsx`
- `src/features/audit/AuditPage.tsx`
- `src/features/seller/SellerPage.tsx`
