# Monolito modular por dominio

## Estado atual

Este documento registra tambem convencoes da base inicial. A implementacao atual
inclui wallets/ledger, BidService, auditoria com witness, settlements e realtime.
`settlements` coordena captura, ledger, estado e auditoria na mesma transacao;
`realtime` adapta uma porta de eventos publicos emitidos apos COMMIT a Socket.IO.
O [relatorio de conclusao](implementation-reports/backend-completion.md) descreve
o fluxo atual, os limites de integridade e os testes. `docker compose up -d --build`
inicia PostgreSQL, API e witness, migrations, seed e workers; use `up -d postgres`
quando quiser somente o banco para desenvolvimento local.

## Escopo inicial

A base de persistencia contem schemas, tipos inferidos e migracao das 12 tabelas.
A autenticacao e o seed estao descritos em [authentication.md](authentication.md).
A integracao DummyJSON e os snapshots locais estao descritos em [catalog.md](catalog.md).
Criacao e lifecycle dos leiloes estao descritos em [auctions.md](auctions.md).
Esses modulos nao alteram schemas nem implementam operacoes financeiras.

| Modulo | Tabelas sob sua responsabilidade |
| --- | --- |
| users | users |
| catalog | product_snapshots; provider externo, consultas e importacao imutavel |
| auctions | auctions, bids, auction_settlements; criacao, lifecycle e administracao dos lotes |
| wallets | wallets, wallet_reservations |
| ledger | ledger_accounts, ledger_transactions, ledger_entries |
| audit | audit_events, audit_anchors |
| auth | sem tabelas proprias; login, JWT e middlewares de seguranca |

## Contrato entre camadas, antes das classes

- Controller: adapta HTTP a entradas e saidas do Service. Nao acessa Repository ou Drizzle.
- Service: implementa casos de uso e regras de negocio. Recebe dependencias por construtor,
  tipadas por interfaces; nao importa Express, schemas ou implementacoes de Repository.
- Repository: interface no `contracts/` do proprio modulo, definida por caso de uso antes
  da classe concreta. Usa DTOs de dominio e Promises, sem tipos de query, Pool ou Drizzle.
  A implementacao em `repositories/` faz consultas e converte registros em DTOs.
- Entre dominios: Services dependem apenas dos contratos publicos dos outros modulos.
  Nao consultam tabelas nem chamam repositorios privados de outro dominio.
- Composicao: o bootstrap conecta Controllers, Services e implementacoes concretas.
  Sem service locator, container de DI, classe base ou repositorio generico.
- Transacoes entre dominios (por exemplo, liquidacao): o contrato do caso de uso deve
  definir uma unica unidade atomica antes da implementacao; nao efetuar commits por repositorio.

Estrutura por modulo, criada conforme houver implementacao:

```text
src/modules/<dominio>/
  contracts/       # interfaces e DTOs de negocio, independentes do ORM
  controllers/
  services/
  repositories/
  infrastructure/
    schema.ts     # schema Drizzle e tipos de persistencia
```

As pastas sem implementacao ainda nao existem. O modulo users publica UserReader
e DTOs independentes do ORM; AuthService recebe esses contratos por construtor.
Controllers nao consultam banco. O seed e infraestrutura de composicao do banco,
e coordena somente a criacao inicial entre schemas numa unica transacao.
Os tipos `$inferSelect`/`$inferInsert`
exportados pelos schemas sao contratos de persistencia, nao contratos de negocio.
As referencias entre schemas sao dependencias da infraestrutura exigidas pelas FKs;
nao autorizam acesso entre modulos na camada de aplicacao. `shared/database/schema.ts`
agrega exports apenas para ferramentas e composicao de infraestrutura.

## Contrato dos dados

- Nomes SQL em snake_case; propriedades TypeScript em camelCase.
- UUIDs e timestamps obrigatorios sao fornecidos pelo chamador, sem defaults adicionados.
- `timestamp` sem timezone e `json` preservam o modelo recebido. A aplicacao deve
  padronizar timestamps em UTC ao implementar os casos de uso.
- Valores monetarios e sequencias SQL `bigint` usam JavaScript `bigint`, preservando
  precisao acima de Number.MAX_SAFE_INTEGER. O Controller devera serializar esses
  valores como strings decimais ao implementar respostas JSON.
- Apenas `wallets.balance_cents` e `wallets.reserved_cents` tem default `0`.
- `updated_at` nao se atualiza sozinho; futuros Repositories deverao atualiza-lo.
- Exclusoes nao propagam em cascata. Nenhum CHECK, indice adicional ou default de
  negocio foi acrescentado ao modelo.
- A FK circular `auctions.current_bid_id -> bids.id` e intencional: cria-se o leilao
  com lance atual nulo, insere-se o lance e atualiza-se o ponteiro na mesma transacao.
- As FKs simples nao garantem que current_bid/winning_bid pertencam ao mesmo leilao,
  nem que o papel do usuario corresponda a operacao. Essas invariantes, saldos nao
  negativos, exclusividade da reserva ativa, hashes e partidas dobradas precisam
  ser definidos nos contratos dos casos de uso e protegidos transacionalmente.

## Comandos

- `docker compose up -d`: inicia o PostgreSQL. Em um volume novo, cria os bancos
  `verzel_auction` e `verzel_auction_test` automaticamente. O script em
  `docker-entrypoint-initdb.d` executa apenas na primeira inicializacao do volume;
  o banco de testes do volume local atual ja foi criado.
- `npm run db:generate`: gera SQL e snapshot a partir dos schemas, sem conectar ao banco.
- `npm run db:migrate`: aplica migracoes no banco de `DATABASE_URL` (definida no `.env`).
- `npm test`: verifica o contrato dos schemas sem exigir banco.
- `npm run test:db`: aplica migracoes e testa insercoes, restricoes e precisao dos
  valores no PostgreSQL indicado por `TEST_DATABASE_URL`. Use exclusivamente um
  banco descartavel: as migracoes permanecem aplicadas; os dados de teste sofrem rollback.
- `npm run lint` e `npm run build`: validam lint estrito e compilacao.

Os schemas pertencem aos modulos; migracoes ficam centralizadas em `drizzle/`, pois
o monolito usa um unico banco e uma unica sequencia de migracoes.
