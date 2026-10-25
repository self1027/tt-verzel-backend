# Plano de implementação do BidService

> Execução autorizada pelo usuário: agentes especializados trabalharam em paralelo; o agente principal integrou e verificou.

**Objetivo:** executar PlaceBid transacionalmente, com um único líder financiado, repetição persistente e uso da outbox de auditoria existente.
**Arquitetura:** domínio/contratos de bids, adaptadores de carteira e auditoria vinculados à transação e serviço Node.js
coordena READ COMMITTED; o PostgreSQL serializa as gravações. Não fazer chamadas externas enquanto houver bloqueios.
**Especificação:** releitura visual das sete páginas digitalizadas de requirements.pdf e pedido explícito do usuário.
**Tecnologias:** manter Express/Drizzle/PostgreSQL/node:test, sem novas dependências.

## Constatações e restrições gerais

- HEAD de referência 8d54bcb; temp/ preparada pelo usuário deve permanecer intacta e fora dos nossos commits.
- Máximo de 500 linhas adicionadas/removidas por commit, sem push; usar pathspec explícito para preservar temp/.
- O grafo tinha 417 nós, gerado em 96206370 antes de carteiras/auditoria; conferir o código-fonte atual.
- ReservationOperations existia somente como porta; faltavam implementações de reserva/liberação.
- O schema não garantia unicidade de reservas ACTIVE por leilão; adicionar índice único parcial sem reescrever migrations antigas.
- AuditAppender(tx), payload BID_ACCEPTED, bidderReference e outbox durável audit_anchors já funcionavam.
- Witness de produção ainda não estava configurado; manter documentados os limites do trecho ancorado.
- O usuário esclareceu a ambiguidade de anti-sniping na página 4 do PDF: usar endsAt anterior + 120000 ms, nunca now + 120000 ms.
- Captura/liquidação, sockets, interface e deploy permanecem fora do escopo.

## Contratos compartilhados antes da implementação em paralelo

`src/modules/bids/contracts/bids.ts` define BidAuction, Bid, PublicBid/BidReceipt,
BidWriteContext, BidRepository, portas de consulta e de armazenamento de operações. API do domínio:
`validateBid(auction:BidAuction,current:Bid|null,userId:string,amount:bigint,now:Date):Date`
retorna o endsAt resultante ou um AppError tipado. `validateHistory(auction:BidAuction,bids:Bid[]):Bid|null`
verifica sequência contínua, ponteiro e coerência de valor/propriedade; corrupção interna retorna 409.

API do adaptador de reservas: `DrizzleReservationOperations implements Pick<ReservationOperations,
'reserveFunds'|'releaseReservation'>`; `lockReservationWallets(tx,walletIds:string[]):Promise<BidWallet[]>`
(o DTO público da carteira pode ser declarado estruturalmente no próprio módulo, sem dependência do domínio de bids).
Um loop explícito em ordem crescente de UUID bloqueia as carteiras ANTES das reservas com FOR UPDATE.
Os métodos readquirem somente bloqueios já mantidos pelo BidService; métodos independentes bloqueiam primeiro o leilão,
depois as carteiras e, por fim, a reserva. Não antecipar a implementação de captura. Conferir o total reservado contra as linhas ACTIVE.

API de idempotência: `bidFingerprint(amountCents:bigint):string` SHA256 de payload canônico versionado;
`DrizzleBidOperationStore(tx)` implementa a porta. Tabela bid_operations: id UUID PK, userId FK,
auctionId FK, key varchar128, fingerprint varchar64, bidId FK único, result JSON, createdAt.
Unicidade por (userId, auctionId, key); a operação PlaceBid é implícita. A chave fica vinculada ao valor canônico.

## Responsáveis e etapas de execução

1. A: bids/domain/bid-rules.ts e tests/bid-rules.test.js (validação pura, mínimo e anti-sniping).
2. B: wallets/repositories/drizzle-reservation-operations.ts e tests/integration/reservations.test.js.
   Sem alterações no schema. Se necessário, aguardar a migration principal antes dos testes PostgreSQL aprovados.
3. C: bids/infrastructure/operations.schema.ts e bids/repositories/drizzle-bid-operation-store.ts,
   bids/domain/idempotency.ts e tests/integration/bid-idempotency.test.js. Sem alterar migrations ou exports compartilhados.
4. Principal: atualizar migrations/schema/exports/testes, BidService, DrizzleBidRepository e fixtures compartilhadas.
5. Quando A concluir, E assume controller/repositório de consultas (contratos estáveis); composição fica com o principal.
6. Quando C concluir, D revisa/integra reprodução estrita de anti-sniping na auditoria e testes de rollback.
7. Quando B concluir, F cria testes reais de integração de concorrência/ataques usando as fixtures principais.
8. Revisão final independente e somente de leitura após integração; o principal corrige achados e redige o relatório.

Máximo de três agentes filhos além do principal; execução em etapas, não seis agentes simultâneos. Schemas exclusivos isolam as suítes.
Somente o agente principal altera arquivos compartilhados, migrations ou commits. Os agentes escrevem testes primeiro e registram red/green.

## Sequência de PlaceBid

- [x] Validar sintaxe/chave/BIGINT positivo fora da transação; bloquear primeiro o leilão e consultar o relógio do banco.
- [x] Confirmar que o usuário existe e é BIDDER. Consultar a idempotência ANTES do estado atual do negócio e repetir o resultado original.
- [x] Validar histórico contínuo/ponteiro atual/estado LIVE/valor mínimo/não ser o próprio líder/estouro da sequência.
- [x] Resolver as duas carteiras, bloqueá-las em ordem crescente de UUID e, então, bloquear todas as reservas ativas do leilão.
- [x] Confirmar que apenas o líder anterior possui reserva ACTIVE exata, com usuário/lance/valor correspondentes; validar invariantes da carteira.
- [x] Reler o relógio do banco após esperas por bloqueios; revalidar LIVE e somar dois minutos ao endsAt anterior quando restarem até dois minutos.
- [x] Conferir saldo disponível, liberar reserva anterior, inserir lance, reservar novos valores e atualizar ponteiro/endsAt.
- [x] Adicionar BID_ACCEPTED à auditoria na transação, persistir comprovante imutável da operação e executar COMMIT.
- [x] Somente o worker durável existente publica âncoras após o commit; sem sockets antecipados ou chamadas externas.

## Validação e pontos de revisão

- [x] Executar npm test/test:db/lint/typecheck/build antes e depois.
- [x] Cobrir os 28 cenários PostgreSQL do pedido, incluindo 23 tentativas simultâneas do mesmo usuário.
- [x] Sincronização por barreira/pg_blocking_pids; não depender somente da ordem de chegada HTTP ou de timeouts.
- [x] Cobrir disputa por carteira compartilhada entre leilões, ordem cruzada de bloqueios, depósito versus reserva e expiração após esperas.
- [x] Rollback após liberar reserva antiga ou falhar auditoria/salvamento da operação deve restaurar todas as linhas.
- [x] Cobrir repetição após mudanças de líder/status/prazo, conflito de payload com a mesma chave e deduplicação concorrente.
- [x] Páginas públicas pseudonimizadas, consulta privada limitada ao usuário e validação estrita de Idempotency-Key duplicada, consultas e corpo.
- [x] Cobrir o limite exato de 120000 ms e extensões sucessivas a partir do prazo anterior; lances rejeitados nunca estendem o prazo.
- [x] Preservar testes existentes; documentar que as restrições aditivas exigem limpeza de linhas ACTIVE antigas inválidas.
- [x] Documentação integral em português em docs/implementation-reports/bid-service.md e no guia da API, com limitações restantes descritas com clareza.
