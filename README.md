# Verzel Auction House

Backend de uma casa de leilões em Node.js 22+, TypeScript strict, Express 5,
PostgreSQL 17 e Drizzle. Monólito modular com autenticação JWT, catálogo DummyJSON
com snapshots locais, lances concorrentes, reservas, liquidação automática,
comprovantes públicos, Socket.IO e auditoria pública com witness independente.

## Execução com Docker

Com Docker e Compose instalados:

```sh
docker compose up -d --build
```

A API fica em `http://localhost:3000`. PostgreSQL, API e `audit-witness` iniciam juntos;
a API aplica migrations e executa o seed automaticamente. Não é necessário criar
`.env`, gerar chaves ou configurar o witness manualmente.

Contas de demonstração: `auctioneer@verzel.local` / `AuctioneerDemo2026!`,
`bidder1@verzel.local` / `BidderOneDemo2026!` e
`bidder2@verzel.local` / `BidderTwoDemo2026!`. Um `.env` existente pode sobrescrever
essas senhas e `PORT`; o seed preserva as senhas de contas já existentes.

O witness gera Ed25519 na primeira execução. A chave privada e o journal ficam no
volume `witness_data`; somente a chave pública é compartilhada, em volume somente
leitura para a API. O token de desenvolvimento é configurado pelo Compose e pode
ser sobrescrito por `AUDIT_WITNESS_PUBLISH_TOKEN`. Nenhuma chave privada é versionada.
O witness não publica uma porta no host: a API usa `http://audit-witness:8081` na rede
do Compose, com `NODE_ENV=development` e `AUDIT_WITNESS_ALLOW_INSECURE_HTTP=true`
explícitos. Sem esse opt-in, HTTPS continua obrigatório fora de loopback.

```sh
docker compose ps
docker compose logs --tail=50 api audit-witness
docker compose restart api audit-witness
docker compose down
```

Reinícios e `down` preservam os volumes, as chaves e o journal. `down -v` apaga os
dados. Se o witness ficar indisponível, a API mantém os eventos na outbox e volta
a publicá-los automaticamente quando ele retornar. Esse ambiente é de desenvolvimento.

## Execução local sem Docker para a API

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
Na primeira execução, o seed também cria um lote LIVE por duas horas e deposita
100000 centavos em cada carteira de licitante ainda sem movimentação. Reexecuções
preservam senhas, saldos, histórico e o prazo original; não reabrem lotes vencidos.
Veja [seed de demonstração](docs/demo-seed.md) para criar outro cenário sem apagar dados.

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
| Busca, faixa de preço e paginação | [Filtros](docs/auction-filters.md) |
| Lances, liderança e idempotência | [BidService](docs/bids.md) |
| Depósitos simulados e ledger | [Carteiras](docs/wallets-ledger.md) |
| Auditoria pública e witness independente | [Auditoria](docs/audit-infrastructure.md) |
| Implementação e evidências desta etapa | [Relatório](docs/implementation-reports/audit-infrastructure.md) |
| Implementação e concorrência dos lances | [Relatório BidService](docs/implementation-reports/bid-service.md) |
| Liquidação, workers e invariantes | [Conclusão do backend](docs/implementation-reports/backend-completion.md) |
| Contratos REST | [OpenAPI 3.1](docs/openapi.json), também em `GET /openapi.json` |
| React/Vite separado e Socket.IO | [Integração frontend](docs/frontend-integration.md) |
| Requisitos do PDF e evidências | [Matriz de cobertura](docs/requirements-matrix.md) |

Valores monetários são strings decimais de centavos na API e `bigint` internamente.
Use login para obter Bearer JWT nas rotas protegidas. A consulta
`GET /auctions/:id/audit` e o histórico `GET /auctions/:id/audit/events` são públicos.

A execução completa pelo Compose já configura a ancoragem. Fora dele, `npm run audit:witness` inicia
a implementação de referência, com variáveis `WITNESS_*` próprias. A API recebe
somente a chave pública e acesso limitado de publicação. Siga o guia antes de
configurar `AUDIT_WITNESS_*`; sem configuração, a verificação retorna HTTP 503 e
`VERIFICATION_UNAVAILABLE`. O arquivo de journal não deve ser gravável pelo backend.
Um sufixo ainda sem âncora independente permanece `PENDING_ANCHOR`.

`GET /auctions` aceita `q`, `lifecycleState`, `minPriceCents`, `maxPriceCents`,
`sort`, `page` e `limit`, preservando `skip`. Exemplo:
`/auctions?q=mascara&sort=price_asc&page=1&limit=10`. A busca usa snapshots locais;
o preço é o lance atual ou, sem lance, o valor inicial. Não combine `page` e `skip`.

O SettlementWorker inicia com a API (`SETTLEMENT_POLL_MS`, padrão 2000 ms).
Somente um histórico `VERIFIED` permite nova liquidação; ancoragem pendente ou
indisponível adia o processamento, e `TAMPERED` bloqueia e gera aviso. A prova é
revalidada sob lock antes da captura. O comprovante público fica disponível em
`GET /auctions/:id/receipt` após a liquidação. Não há endpoint financeiro manual.

Configure `CORS_ORIGINS` com origens exatas separadas por vírgulas para o frontend;
o Compose permite `http://localhost:5173` por padrão. Socket.IO aceita salas por
leilão e emite avisos após COMMIT; reconexão exige ressincronização REST, pois
esses avisos não têm entrega persistente garantida.

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

`test:db` exige `TEST_DATABASE_URL` do `.env.example`, apontando exclusivamente para
o banco descartável `verzel_auction_test`. Última verificação desta etapa:
94 testes aprovados e 1 skip de privilégio de symlink no Windows em `npm test`;
195/195 integrações PostgreSQL; lint, typecheck e build aprovados. Evidências e
smoke tests reais do Compose estão no relatório de conclusão.

## Próximas etapas

Frontend React em repositório separado e deploy público permanecem pendentes.
O cancelamento opcional com estorno de lotes com lances também permanece parcial:
o modelo atual não possui administrador, e o vendedor não recebe autoridade para
desfazer um resultado legítimo. Continua permitido cancelar seu lote sem lances,
antes do encerramento; inconsistências financeiras impedem a operação.
A auditoria de lances não é prova criptográfica de todo o ledger nem da identidade
do vendedor: consulte os limites no relatório antes de ampliar essas garantias.
