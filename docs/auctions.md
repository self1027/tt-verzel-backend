# Auctions e lifecycle

Lances transacionais, reservas e consultas de liderança estão documentados em
[BidService](bids.md). Criação, edição e cancelamento também registram eventos pela
[auditoria existente](audit-infrastructure.md).

O modulo usa exclusivamente snapshots locais e autenticacao existente. Nao importa
DummyJSON, nao consulta temp e nao atualiza o produto associado. Nenhuma alteracao
de schema, enum ou migration foi necessaria.

## Estado administrativo e apresentacao

`status` e o valor persistido: PUBLISHED, CANCELLED, SETTLED ou CLOSED_NO_BIDS.
`lifecycleState` e calculado pela funcao pura `lifecycleState(auction, now)`:

| status | Condicao temporal | lifecycleState |
| --- | --- | --- |
| PUBLISHED | now < startsAt | SCHEDULED |
| PUBLISHED | startsAt <= now < endsAt | LIVE |
| PUBLISHED | now >= endsAt | FINALIZING |
| CANCELLED | qualquer horario | CANCELLED |
| SETTLED | qualquer horario | SETTLED |
| CLOSED_NO_BIDS | qualquer horario | CLOSED_NO_BIDS |

FINALIZING significa prazo vencido com encerramento/liquidacao ainda pendentes.
Nao significa pagamento realizado. Nao existe job para abrir leiloes ou worker para
liquidar nesta fase. Um leilao vencido permanece PUBLISHED/FINALIZING ate um futuro
fluxo de encerramento; o modulo atual so cria PUBLISHED e permite cancelar.

## Endpoints

| Metodo/rota | Acesso | Resultado |
| --- | --- | --- |
| POST /auctions | AUCTIONEER | 201, `{ auction }` |
| GET /auctions | publico | 200, `{ auctions, total, limit, skip, asOf }` |
| GET /auctions/mine | AUCTIONEER | mesma pagina, restrita ao proprietario autenticado |
| GET /auctions/:id | publico | 200, `{ auction }` |
| PATCH /auctions/:id | AUCTIONEER proprietario | 200, `{ auction }` |
| POST /auctions/:id/cancel | AUCTIONEER proprietario | 200, `{ auction }` |

O proprietario sempre vem do subject JWT validado pelo middleware. IDs ou papeis
enviados no corpo nunca substituem essa identidade. GETs publicos nao exigem token,
nao consultam usuarios e nao expoem hashes, emails ou dados de carteiras.

Listas aceitam limit (padrao 30, de 1 a 100), skip (padrao 0, de 0 a 2147483647) e
lifecycleState opcional com um dos seis estados de apresentacao. PUBLISHED nao e
um filtro de apresentacao valido. Parametros desconhecidos ou repetidos sao rejeitados.
Ordenacao: createdAt DESC, id ASC. Filtros temporais sao aplicados no SQL antes da
paginacao e no total, nunca somente sobre a pagina retornada. A leitura usa uma
transacao REPEATABLE READ e um unico instante do PostgreSQL, exposto como asOf.
Esse mesmo instante e usado na apresentacao de todos os itens da resposta.

## Valores e datas

startingBidCents e minIncrementCents sao strings decimais canonicas positivas no JSON,
de `"1"` ate `"9223372036854775807"`. Numeros JSON, zeros, negativos, fracionarios,
notacao cientifica, sinal + e zeros a esquerda sao rejeitados. Internamente sao
bigint; respostas tambem usam strings. Nao ha conversao pelo tipo Number.

Datas devem ser strings ISO 8601 com Z ou offset explicito, com no maximo tres casas
decimais (milissegundos). Sao normalizadas em UTC. O schema existente usa timestamp
sem timezone: Drizzle grava/le os instantes como UTC. Escritas SQL externas tambem
devem seguir essa convencao. Os testes incluem uma sessao PostgreSQL America/Sao_Paulo.

Criacao aceita exclusivamente:

```json
{
  "productSnapshotId": "<UUID do snapshot local>",
  "startingBidCents": "10000",
  "minIncrementCents": "500",
  "startsAt": "2030-01-01T12:00:00.000Z",
  "endsAt": "2030-01-01T13:00:00.000Z"
}
```

productSnapshotId deve existir no catalogo local; ID numerico DummyJSON nao e aceito.
startsAt deve ser estritamente futuro no instante de validacao do banco, e endsAt
deve ser posterior. O backend gera UUID, createdAt/updatedAt, PUBLISHED e currentBidId
nulo. Campos extras, inclusive controles internos, sao rejeitados.

Cada objeto auction inclui id, auctioneerId, productSnapshotId, currentBidId,
startingBidCents, minIncrementCents, startsAt, endsAt, status, lifecycleState,
createdAt, updatedAt e productSnapshot (os campos publicos do snapshot local).

## Edicao e cancelamento

PATCH aceita somente startingBidCents, minIncrementCents, startsAt e endsAt, com pelo
menos um campo. O Service mescla os valores com o registro bloqueado e revalida o
conjunto. Exige PUBLISHED, horario anterior ao startsAt original e ausencia de lances.
Nao e permitido mover o inicio para o futuro depois que a janela original comecou.

Cancelamento recebe corpo vazio e exige PUBLISHED, ausencia de lances e now < endsAt.
Pode ocorrer tanto em SCHEDULED quanto em LIVE. Persiste CANCELLED e updatedAt sem
excluir o registro. Uma segunda solicitacao retorna 409 AUCTION_NOT_PUBLISHED, sem
alterar updatedAt novamente. SETTLED e CLOSED_NO_BIDS tambem nao sao cancelaveis.

## Transacoes e sincronizacao obrigatoria

Service recebe um contrato AuctionRepository independente de Drizzle. O Repository
fornece um contexto transacional limitado ao dominio. Regras permanecem no Service.

Edicao e cancelamento usam transacao READ COMMITTED:

1. SELECT FOR UPDATE no registro de auctions; aguardar antes de tomar decisoes.
2. Conferir existencia, proprietario, status e lances reais, incluindo casos em que
   bids existe mas currentBidId ainda e nulo.
3. Consultar clock_timestamp() depois da espera e das verificacoes de lances.
4. Validar limites temporais e atualizar dentro da mesma transacao, mantendo o lock
   ate COMMIT/ROLLBACK. updatedAt recebe o horario da decisao do banco.

Nao se usa NOW()/CURRENT_TIMESTAMP para decidir depois de uma espera, pois eles
representam o inicio da transacao. Essa diferenca e descrita na
[documentacao de data/hora do PostgreSQL 17](https://www.postgresql.org/docs/17/functions-datetime.html).
Os locks seguem a [documentacao de bloqueios explicitos](https://www.postgresql.org/docs/17/explicit-locking.html).

A criacao protege o snapshot com FOR KEY SHARE para impedir sua exclusao antes do
INSERT, sem modifica-lo; o horario e obtido depois dessa verificacao.

BidService e futuros SettlementService/Worker devem obrigatoriamente bloquear a
mesma linha de auctions primeiro, antes de decidir ou bloquear registros filhos.
Depois do lock, devem obter databaseNow e verificar status/datas. BidService so
podera aceitar PUBLISHED com startsAt <= databaseNow < endsAt. Anti-sniping devera
alterar endsAt na mesma transacao do lance. Settlement devera selecionar publicados
vencidos, bloquear/revalidar e executar liquidacao transacional e idempotente.
BidService implementa essas regras em `modules/bids`, incluindo reservas e auditoria.
SettlementService/Worker continuam pendentes.

## Erros e testes

Erros reutilizam `{ error: { code, message, details? } }` existente:

- 400: payload/query/UUID invalido, valores monetarios ou datas invalidas.
- 401: autenticacao ausente/invalida em operacao protegida.
- 403: papel inadequado ou usuario diferente do proprietario.
- 404: snapshot ou leilao inexistente.
- 409: leilao nao publicado, ja iniciado, vencido ou com lances para a mutacao.

```sh
npm test
npm run test:db
npm run lint
npm run typecheck
npm run build
```

O projeto usa node:test, preservado nesta fase. Testes de lifecycle e Service usam
instantes explicitos. Integracao usa PostgreSQL real em schemas temporarios, com
seed isolado, e verifica locks atraves de pg_blocking_pids. Lances usados nos testes
sao apenas fixtures SQL para exercitar as restricoes, nao um modulo de lances.

## Arquivos

- contracts/auctions.ts: contratos e DTOs de dominio/publicos.
- lifecycle.ts: calculo puro de apresentacao.
- repositories/drizzle-auction-repository.ts: persistencia, filtros e transacoes.
- services/auction-service.ts: regras de criacao, consulta, edicao e cancelamento.
- controllers/auction-controller.ts: parsing Zod e adaptacao HTTP.
- index.ts: composicao e autorizacao das rotas.
- src/app.ts e src/server.ts: montagem do router no bootstrap existente.
- tests/auctions-lifecycle.test.js e auctions-service.test.js: unidade/limites.
- tests/integration/auctions.test.js e auctions-concurrency.test.js: HTTP/PostgreSQL.
- tests/helpers/auctions.js: ambiente isolado e fixtures.

O valor inicial e definido pelo leiloeiro, sem utilizar preco externo de produto.
Wallets, ledger, lances e auditoria possuem guias proprios; liquidacao, jobs de
settlement e WebSockets continuam pendentes. Nao ha Redis ou fila externa.
