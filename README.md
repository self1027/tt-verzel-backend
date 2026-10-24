# Verzel Auction House

Backend de uma casa de leilões em Node.js 22+, TypeScript strict, Express 5,
PostgreSQL 17 e Drizzle. Monólito modular com autenticação JWT, catálogo DummyJSON
com snapshots locais, administração de lotes, depósitos simulados e auditoria pública.

## Execução local

Pré-requisitos: Node.js 22+, npm e Docker Compose.

1. Execute `npm ci`.
2. Copie `.env.example` para `.env` se ainda não existir. Configure `JWT_SECRET`
   com pelo menos 32 bytes aleatórios e as três senhas de demonstração.
3. Execute `docker compose up -d postgres`.
4. Execute `npm run db:migrate` e `npm run db:seed`.
5. Execute `npm run dev`; a API usa `http://localhost:3000` por padrão.

Para compilar e executar: `npm run build` e `npm start`.
O seed cria `auctioneer@verzel.local`, `bidder1@verzel.local` e
`bidder2@verzel.local`; as senhas vêm das respectivas variáveis `SEED_*`.
Ainda falta incluir um lote publicado aberto no seed.

As URLs de desenvolvimento e testes estão em `.env.example`. O banco de testes
é descartável e separado. O script de criação desse banco no Compose só executa
na primeira inicialização do volume; volumes antigos precisam já conter esse banco.
Não versione `.env`, chaves privadas ou credenciais reais.

## API e documentação

| Recurso | Guia |
| --- | --- |
| Arquitetura e schemas | [Arquitetura](docs/architecture.md) |
| Login e papéis | [Autenticação](docs/authentication.md) |
| Produtos externos e snapshots | [Catálogo](docs/catalog.md) |
| Lotes, edição e cancelamento | [Leilões](docs/auctions.md) |
| Lances, liderança e idempotência | [BidService](docs/bids.md) |
| Depósitos simulados e ledger | [Carteiras](docs/wallets-ledger.md) |
| Auditoria pública e witness independente | [Auditoria](docs/audit-infrastructure.md) |
| Implementação e evidências desta etapa | [Relatório](docs/implementation-reports/audit-infrastructure.md) |
| Implementação e concorrência dos lances | [Relatório BidService](docs/implementation-reports/bid-service.md) |

Valores monetários são strings decimais de centavos na API e `bigint` internamente.
Use login para obter Bearer JWT nas rotas protegidas. A consulta
`GET /auctions/:id/audit` e o histórico `GET /auctions/:id/audit/events` são públicos.

A ancoragem precisa de um serviço independente: `npm run audit:witness` inicia
a implementação de referência, com variáveis `WITNESS_*` próprias. A API recebe
somente a chave pública e acesso limitado de publicação. Siga o guia antes de
configurar `AUDIT_WITNESS_*`; sem configuração, a verificação retorna HTTP 503 e
`VERIFICATION_UNAVAILABLE`. O arquivo de journal não deve ser gravável pelo backend.
Um sufixo ainda sem âncora independente permanece `PENDING_ANCHOR`.

## Verificação

```sh
npm test
npm run test:db
npm run lint
npm run typecheck
npm run build
```

Integrações usam PostgreSQL real com schemas temporários isolados. Testes do witness
usam servidores HTTP locais, chaves efêmeras e journals temporários; não representam
uma ancoragem de produção configurada.

## Próximas etapas

Lances, reservas e liberação ao ser superado estão implementados e auditados na mesma transação.
Captura de reservas, liquidação/worker, comprovantes, WebSockets,
frontend React e deploy público ainda estão pendentes. Os eventos futuros já têm
contratos de settlement, mas não substituem a captura/transferência financeira. O escopo e as garantias
criptográficas estão detalhados no relatório e no guia de auditoria.
