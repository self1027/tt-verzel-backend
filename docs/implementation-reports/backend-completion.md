# Conclusão do backend — Verzel Auction House

Data: 24/10/2026. Base inicial: `59bb570`. Execução local, sem push ou deploy externo.

## Resumo executivo

A etapa completou captura de reservas, SettlementService e SettlementWorker,
comprovantes públicos, Socket.IO, CORS configurável, seed demonstrativo e o opcional
de busca/filtro na rota existente. Os módulos anteriores foram preservados e
regredidos contra PostgreSQL real. Não houve migration nem troca de arquitetura.

Resultado final: `npm test` teve 94 aprovados, zero falhos e um skip; `test:db`
teve 195 aprovados e zero falhos. Lint, typecheck e build concluíram com código zero.
O Compose foi reconstruído e exercitado com API, PostgreSQL e witness reais.

Não se declara o desafio integralmente entregue: frontend React e deploy público
continuam pendentes. O opcional de cancelamento com estorno de lotes com lances
permanece parcial por ausência de autoridade administrativa no modelo atual.

## Requisitos e evidências

O PDF original, com sete páginas, foi lido visualmente antes das alterações.
A [matriz completa](../requirements-matrix.md) relaciona requisito, estado inicial,
estado final, código e testes. Resumo do escopo obrigatório aplicável ao backend:

| PDF | Requisito | Evidência e estado |
| --- | --- | --- |
| p2/p4 | JWT e papéis; leiloeiro não dá lances | Auth e testes existentes preservados; integrações aprovadas |
| p2/p4 | DummyJSON e snapshot local estável | Catálogo existente; leitura de lotes e filtros sem rede externa |
| p3/p4 | Lotes, janela LIVE, incremento, anti-sniping e reservas | BidService existente e regressões de concorrência aprovadas |
| p4 | Liquidação e fechamento sem lances | SettlementService, captura, worker e testes financeiros desta etapa |
| p2/p3/p4 | Auditoria pública e adulteração | Witness existente; gate VERIFIED e revalidação sob locks |
| p2/p3 | Comprovante compartilhável | GET `/auctions/:id/receipt`, pseudônimo e vínculos financeiros conferidos |
| p3 | Atualizações em tempo real | Socket.IO após COMMIT; restauração por REST documentada |
| p5 | Dados demonstrativos e execução/documentação | Seed idempotente, Compose e OpenAPI verificáveis |
| p6 opcional | Busca e filtro de lotes | Implementado no GET `/auctions`, com SQL e total consistente |
| p6 opcional | Cancelamento com estorno | Parcial: somente cancelamento seguro sem lances; sem nova autoridade |
| p2/p7 | Frontend, hospedagem e entrega pública | Pendentes, fora deste repositório/execução |

## Orquestração e revisão

Foram utilizados subagentes reais com ownership exclusivo e liberado antes de
edições compartilhadas. O agente principal manteve as decisões financeiras e a
integração final.

- `completion_filters`: contratos/controller/repositório de filtros; depois seed,
  matriz, OpenAPI e documentação de integração.
- `completion_capture`: captura e testes financeiros; depois concorrência de
  settlement, testes do worker e revisão financeira.
- `completion_realtime`: Socket.IO/CORS e testes; depois comprovantes e testes.
- `completion_final_review`: revisão independente, somente leitura, de finanças,
  prova auditada, recibos, seed, filtros e integração; sem achados bloqueantes.

Filtros, captura e realtime ocorreram em paralelo com o desenvolvimento principal
de settlement. Depois dos contratos estabilizados, comprovantes, seed e testes
adversariais também ocorreram em paralelo. A capacidade foi de três filhos mais
o principal. Integrações usaram schemas UUID isolados; nenhum schema foi disputado
entre agentes. O revisor também executou 61 testes direcionados, incluindo 47 de
PostgreSQL, todos aprovados. A execução final completa foi feita pelo principal.

## Fluxo transacional e financeiro

1. O worker descobre PUBLISHED vencidos pelo relógio PostgreSQL.
2. O serviço consulta o witness fora de qualquer lock financeiro e verifica uma
   fotografia consistente da cadeia e do estado operacional.
3. Uma transação READ COMMITTED bloqueia a linha do lote e lê `clock_timestamp()`.
4. Revalida status, prazo e prova: sequência/hash da cabeça, cadeia inteira e
   replay operacional. O fingerprint também detecta mudança do vendedor observado.
5. Bloqueia carteiras em ordem crescente real de UUID e depois reservas.
6. Relê relógio e prova após as esperas. Uma versão diferente adia o processamento.
7. Captura a reserva, grava ledger, settlement, estado e evento/outbox de auditoria.
8. COMMIT libera os locks; somente então são emitidos avisos Socket.IO.

Sem lances, rejeita reserva ACTIVE indevida e grava CLOSED_NO_BIDS e auditoria,
sem transferência ou settlement financeiro. Com vencedor, usa a chave persistente
`settlement:<auctionId>` e referência à reserva no ledger existente. As unicidades
de settlement por lote, chave contábil e reserva ACTIVE por lote são reutilizadas.

A captura ACTIVE → CAPTURED reduz `balanceCents` e `reservedCents` do vencedor e
credita o mesmo valor ao vendedor. Exatamente duas entradas USER_WALLET opostas
somam zero. Reservar/liberar não cria ledger. Valores e somas usam bigint, com
checagem de limites BIGINT. Antes da captura, ambos os saldos são reconciliados
contra suas contas contábeis e as reservas são conferidas. Nenhum crédito fictício
é criado para representar liberação.

Captura idêntica repetida valida os termos e retorna o resultado persistido;
destinatário/chave diferentes conflitam. CAPTURED não pode ser liberada e RELEASED
não pode ser capturada. Reexecução de settlement terminal não transfere novamente.
Exceções antes do COMMIT revertem reserva, saldos, ledger, settlement, estado e
auditoria. Depósito bloqueia somente carteira e não tenta adquirir lote depois;
BidService e settlement seguem lote → carteiras ordenadas → reservas → escritas.

## Política de auditoria e limites

| Resultado externo/local | Ação antes de nova liquidação |
| --- | --- |
| VERIFIED | Elegível, condicionado à revalidação sob locks |
| PENDING_ANCHOR | Adiar e tentar novamente |
| VERIFICATION_UNAVAILABLE | Adiar e tentar novamente |
| TAMPERED | Bloquear, logar incidente e emitir aviso público sem reparar dados |

O `stateHash` liga a fotografia verificada ao estado relido dentro da transação;
não é uma nova âncora externa. A segunda conferência inclui a cadeia inteira,
evitando que um hash intermediário adulterado durante uma espera passe apenas
por ter a mesma cabeça. Não há HTTP ou publicação externa durante locks financeiros.
Depois do COMMIT, o AnchorWorker existente publica a outbox de forma recuperável.
O evento de settlement pode permanecer PENDING_ANCHOR temporariamente; repetição
do settlement já confirmado não depende dessa nova publicação para ser idempotente.

O witness prova os compromissos que recebeu, consultados efetivamente na verificação.
Um sufixo não ancorado não possui a mesma proteção contra reescrita/truncamento.
Confiança exige isolamento do journal/chave privada e autenticidade da chave
pública; compromisso simultâneo do witness e banco está fora das garantias.
Reconciliação financeira detecta inconsistência, não uma reescrita administrativa
coerente de todo o ledger. O compromisso de lances não autentica integralmente o
ledger, a identidade do vendedor nem todo o conteúdo do snapshot de produto.
O vendedor observado no preflight fica protegido contra mudança entre preflight
e captura, mas uma adulteração anterior não coberta pelo evento não vira prova
criptográfica por esse fingerprint. Não se apresenta VERIFIED como garantia
global contra administrador PostgreSQL malicioso durante escritas concorrentes.

## Worker, cancelamento e comprovantes

Polling simples, lote de 20, padrão de 2000 ms via `SETTLEMENT_POLL_MS` (100–60000).
Falhas/deferimentos têm backoff exponencial de 1 a 60 segundos por lote. Lotes em
backoff são excluídos da descoberta para não bloquear os seguintes. Execuções
locais não se sobrepõem; entre instâncias, o lock do banco e unicidades garantem
um único efeito financeiro. O prazo é sempre revalidado, inclusive após um lance
concorrente estender o encerramento. O estado elegível é persistente; o backoff é
volátil e reinicia após restart. Shutdown espera o trabalho ativo antes de fechar
o pool, junto ao encerramento do HTTP/Socket.IO e do publicador de âncoras.

Cancelamento do proprietário continua permitido apenas sem lances, PUBLISHED e
antes do fim. Registra `SELLER_REQUEST`, evento e aviso pós-COMMIT; reserva ACTIVE
indevida faz falhar de forma segura. Duplicação conflita sem outro efeito.
SETTLED não pode ser cancelado. Não há papel ADMIN: liberar a reserva de um lance
legítimo por decisão arbitrária do vendedor contrariaria a autorização disponível.
Não foi criado fluxo de disputa, estorno pós-settlement ou cancelamento de incidente.

O comprovante público deriva de uma leitura REPEATABLE READ dos registros
persistidos. Confere lote/lance/reserva capturada/settlement/ledger e as duas
contrapartidas corretas antes de responder. Inclui snapshot, valor, datas,
settlementId, pseudônimo e URLs públicas; omite emails, carteira, idempotência e
receiptToken. Retorna 404 antes da liquidação ou sem vencedor e 409 sanitizado em
inconsistência. Sua existência não significa que o último evento já foi ancorado.

## API, filtros e realtime

- GET `/auctions`: `q`, `lifecycleState`, `minPriceCents`, `maxPriceCents`, `sort`,
  `page`, `limit` e `skip` legado. Retorna o contrato anterior com `total` e `asOf`.
- GET `/auctions/:id/receipt`: público, JSON determinístico sobre dados persistidos.
- GET `/openapi.json`: contrato OpenAPI 3.1 público, refs/parâmetros testados.
- Rotas existentes de login Bearer, catálogo, wallet, bids e auditoria preservadas.

Filtros, total, ordenação e paginação são SQL Drizzle sobre snapshots locais.
`q` é substring literal ILIKE: `%`, `_` e barra invertida são escapados. Preço é o
lance atual pertencente ao próprio lote ou valor inicial. Faixa inclusiva com
strings canônicas não negativas até BIGINT máximo; não se usa Number para dinheiro.
Sort aceita `price_asc`, `price_desc`, `endsAt_asc`, `endsAt_desc`, com UUID como
desempate. Default anterior preservado. Zod rejeita desconhecidos, repetidos,
faixas invertidas, overflow e combinação ambígua de page com skip.

Socket.IO usa a mesma porta da API. `auction:join`/`auction:leave` recebem
`{ auctionId }`, salas públicas por UUID e limite de 100 por conexão. Eventos:
`bid:accepted`, `auction:extended`, `auction:ended`, `auction:settled`,
`auction:cancelled`, `auction:integrity-warning`. Avisos de mutação são emitidos
após COMMIT; não há emissão de lance revertido nem dados financeiros privados.
Não existe outbox de Socket.IO, replay garantido ou Redis Adapter: crash após
COMMIT pode perder aviso. REST e ressincronização após reconnect são obrigatórios.

`CORS_ORIGINS` aceita origens HTTP(S) exatas separadas por vírgulas. Compose permite
localhost:5173 por padrão; Vercel precisa da origem efetiva configurada no backend.
O [guia frontend](../frontend-integration.md) documenta Bearer, eventos e recuperação.

## Seed e Docker

`docker compose up -d --build` inicia três serviços saudáveis, migrations, seed,
AnchorWorker e SettlementWorker. Witness permanece interno, com journal/chave
privada persistentes e somente chave pública compartilhada com a API. HTTP interno
continua condicionado ao opt-in explícito de desenvolvimento já existente.

O seed adicional usa snapshot offline com whitelist de fixture DummyJSON, lote
LIVE inicial de duas horas e depósito simulado de 100000 centavos por carteira
de licitante totalmente nova. Não altera senhas existentes, não repõe saldo gasto,
não fabrica lances, não reabre lote vencido nem modifica prazos no restart.
Advisory lock serializa seeds, e todo o cenário adicional é atômico. Consulte
[demo-seed](../demo-seed.md) para continuar a demonstração após a janela inicial.

## Testes e evidências reais

| Comando | Resultado final |
| --- | --- |
| `npm test` | 95 casos: 94 aprovados, 0 falhos, 1 skip |
| `npm run test:db` | 195/195 aprovados, 0 falhos |
| `npm run lint` | Código 0, sem warnings |
| `npm run typecheck` | Código 0 |
| `npm run build` | Código 0 |
| `docker compose up -d --build` | Build aprovado; PostgreSQL, API e witness saudáveis |

O skip existente é o teste de symlink de arquivo do journal, pois a conta Windows
não possui esse privilégio (EPERM). A baseline teve 75 aprovados/1 skip e 148 PG;
a tentativa inicial de PG falhou por ausência local de TEST_DATABASE_URL, antes
de executar os cenários. Reexecução com o banco descartável corrigiu o ambiente.

Integrações novas cobrem captura/replay/conflitos/overflow/ledger inconsistente;
settlement vencedor/sem lances/repetido; seis execuções concorrentes com efeito
único; falhas injetadas após captura, INSERT, atualização de status e auditoria;
rollback e retry; witness indisponível, pendente e TAMPERED; mudança de prova após
preflight; espera real de wallet lock com adulteração intermediária da cadeia;
lance concorrente que estende o prazo; recibos e adulteração dos vínculos;
Socket.IO real com estado visível após COMMIT e ausência de evento em rollback;
seed simultâneo/idempotente; filtros combinados, empates e entradas inválidas.
As regressões incluem concorrência bid/depósito/reserva, RBAC e adulterações
diretas UPDATE/INSERT/DELETE do histórico. Sincronização usa conexões independentes,
barreiras e observação de locks onde necessário, não apenas temporizadores.

Um defeito foi encontrado e corrigido: conferir somente a cabeça sob lock não
detectava imediatamente hash intermediário alterado durante espera. O protocolo
passou a validar também `checkChain` antes da captura, e o teste demonstrou adiamento
sem efeitos financeiros. Não foram mascarados erros alterando expectativas válidas.

Smoke tests no Compose real:

- OpenAPI público e filtro combinado retornaram o lote LIVE de demonstração.
- Fixture histórica válida com lance/reserva foi criada atomicamente no container
  para evitar esperar a janela anti-sniping; o worker real liquidou
  `16607c96-0a60-4e24-9ad8-d3fc46ae4724`. Não foi um lance HTTP aceito após expiração.
- Comprovante HTTP 200, débito/crédito iguais a 1000, reservado zero, evento
  `auction:settled` recebido e auditoria VERIFIED com sequência externa 3.
- Preflight CORS para localhost:5173 retornou 204.
- Witness foi parado e criou-se lote vencido sem lances
  `b1c153fb-ff1b-4ba7-a585-61fe8fb9ad81`: auditoria 503 e status PUBLISHED sem finanças.
- Após reiniciar API e restaurar witness, a outbox publicou, o worker fechou
  CLOSED_NO_BIDS e a auditoria retornou VERIFIED com sequência externa 2.
  Volumes/journal/chaves foram preservados; não se executou `down -v`.

Falhas injetadas demonstram rollback pré-COMMIT; não se afirma ter matado o processo
em cada instrução de escrita. O restart real demonstrou redescoberta e recuperação
de publicação pendente. Não há teste de carga prolongado ou deploy multi-instância;
a garantia de efeito único entre workers é demonstrada por transações concorrentes
no PostgreSQL real.

## Arquivos e dependências

Criados: `src/modules/settlements/` (contratos, gate/prova, repositórios, serviços,
controller/router de recibo e worker); `src/modules/realtime/auction-sockets.ts`;
`src/shared/events/auction-events.ts`; `src/shared/http/cors.ts`;
`src/shared/database/demo-product.ts` e `demo-seed.ts`.

Modificados: `src/app.ts`, `src/server.ts`, `src/shared/config.ts`, `run-seed.ts`;
contratos/controller/repositório/composição de auctions; composição/repositório
de bids; adaptador de reservas; validação criptográfica e replay de cancelamento
no audit. Configurações: `.env.example`, `compose.yaml`, `Dockerfile`, `package.json`
e lockfile. Variáveis novas: CORS_ORIGINS e SETTLEMENT_POLL_MS.

Testes criados: `tests/{api-documentation,auction-filters,cors,openapi,realtime,
settlement-config,settlement-policy,settlement-worker}.test.js`, helper settlements;
`tests/integration/{auction-filters,demo-seed,notifications,receipts,
reservation-capture,settlement-concurrency,settlements}.test.js`.

Documentação: README, architecture, auctions e wallets-ledger atualizados;
auction-filters, demo-seed, frontend-integration, openapi.json, requirements-matrix,
plano de execução e este relatório criados. Não foram criadas migrations: tabelas,
constraints e índices existentes suportaram os fluxos. Dependências adicionadas:
`socket.io` runtime (requisito explícito) e `socket.io-client` somente desenvolvimento
para testes reais de transporte. Não foram adicionados Redis, filas ou serviços.

## Execução e próximos passos

```sh
docker compose up -d --build
docker compose ps
npm ci
npm test
npm run test:db
npm run lint
npm run typecheck
npm run build
```

Para testes locais, configure TEST_DATABASE_URL conforme `.env.example`, sempre
no banco descartável `verzel_auction_test`; no PowerShell desta execução foi usado
`$env:TEST_DATABASE_URL='postgresql://verzel:verzel_dev@localhost:5432/verzel_auction_test'`.
Nenhuma credencial real ou chave privada foi versionada.

Checklist de entrega restante:

- [x] Backend obrigatório aplicável, settlement/worker/captura/recibos/realtime.
- [x] Filtros opcionais, regressões e execução Compose verificadas.
- [x] Documentação REST/Bearer/Socket e matriz de requisitos.
- [ ] Frontend React separado: telas, carteira, bids, recibos e estado de incidente.
- [ ] Deploy público autorizado, URLs, configuração CORS e validação integrada.
- [ ] Se desejado, definir autorização administrativa antes de concluir o opcional
  de cancelamento com lances/estorno; não há autoridade implícita do vendedor.
- [ ] Entrega final do desafio com repositórios e URLs conforme o PDF.

Frontend e preparação de deploy podem evoluir em paralelo contra OpenAPI e o guia
de eventos. O opcional administrativo depende primeiro da decisão de autorização.
Entrega durável de Socket.IO, prova integral do ledger e execução multi-instância
com distribuição de notificações não foram acrescentadas especulativamente.
