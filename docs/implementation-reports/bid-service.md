# Relatório técnico — BidService

Data: 24/10/2026. Base: `8d54bcb`. Fonte normativa: `requirements.pdf`, todas as sete
páginas relidas visualmente antes de alterar o projeto, e instruções desta fase.

## Resumo executivo

PlaceBid funciona de ponta a ponta por HTTP, com autenticação exclusiva de BIDDER,
reserva financeira, liberação do líder anterior, anti-sniping, idempotência persistente
e auditoria na mesma transação PostgreSQL. Há histórico público e consulta dos próprios
lances, com paginação, liderança atual e identificação pública pseudonimizada.

Foram preservados Node.js/TypeScript strict/Express/Drizzle/PostgreSQL/node:test, sem
dependências novas, mutex em memória, Redis ou infraestrutura financeira paralela.
Captura, SettlementService/Worker, comprovantes, sockets, frontend e deploy seguem pendentes.

Validação final: 73 testes unitários aprovados, 1 ignorado por privilégio Windows,
148 testes PostgreSQL aprovados, lint/typecheck/build com saída 0. A revisão independente
encontrou um problema de validação no histórico paginado, corrigido e revisado novamente.

## Reconhecimento do estado real

O grafo graphify foi inspecionado antes de assumir a existência de reservas. Ele tem
417 nós e foi gerado no commit `96206370`, anterior a Wallets/Auditoria. A inspeção
dos contratos e fontes confirmou que reserve/release ainda não tinham implementação.
O CLI graphify não estava disponível no PATH; foram consultados graph.json/relatório
existentes e o código atual, sem tratar o grafo desatualizado como prova de implementação.

Outra divergência: a unicidade parcial de ACTIVE por leilão citada no pedido não existia
no schema real. Havia somente unicidade de bidId na reserva. A nova migration acrescenta
a proteção, sem modificar migrations antigas ou excluir dados para contornar inconsistências.

A auditoria está operacional no código: append transacional, cadeia v1, replay,
outbox, provider/witness e verificação pública. A testemunha externa de produção
continua sem configuração; esse limite não foi confundido com falta do adaptador.
Baseline reexecutada: 55 unitários aprovados/1 ignorado, 93 PostgreSQL aprovados e
lint/typecheck/build com saída 0.

No início havia oito arquivos de `temp/` já staged pelo usuário. Foram preservados
sem alteração de conteúdo nem estado no índice e excluídos dos commits desta fase.

## Orquestração e ownership

| Agente real | Responsabilidade e arquivos |
| --- | --- |
| `bid_domain` | A: regras puras e testes; depois E: controller, queries e testes HTTP. |
| `bid_reservations` | B: adaptador financeiro e testes; depois F: fluxos, barreiras e concorrência PostgreSQL. |
| `bid_idempotency` | C: schema/store/fingerprint e testes; depois D: integração auditável/replay; depois guia de API. |
| Principal | Contratos, migration compartilhada, serviço/repositório/composição, fixtures, integração, correções e relatório. |
| `bid_final_review` | Revisão final independente, reprodução de defeito e revisão posterior da correção. |

Os três primeiros agentes trabalharam simultaneamente após estabilizar os contratos.
O limite do ambiente é de três filhos ativos mais o principal; A–F foram distribuídos
em ondas, sem alegar seis execuções simultâneas. Implementações dependentes aguardaram
as interfaces, o schema ou a fixture necessários. Apenas o principal alterou migrations,
exports/schema tests, composição e outros arquivos compartilhados.

Cada agente teve ownership explícito. Não houve edição simultânea do mesmo arquivo.
Os testes paralelos usam schemas UUID distintos de `isolatedDatabase`. Os agentes
registraram testes vermelhos antes de suas implementações e não fizeram commits/push.

Bloqueios resolvidos: módulos ausentes durante a primeira rodada vermelha; migration
necessária antes de testar o store; fixture comum antes do HTTP; parsing local de
timestamp em uma fixture de concorrência, corrigido por seleção UTC explícita.

## Arquitetura e sequência Node.js/PostgreSQL

Controller valida Zod, identifica o usuário autenticado e chama `BidUseCases`.
BidService depende dos ports de escrita/consulta e de funções de domínio, sem
Express, Drizzle, Socket.IO, DummyJSON ou provider de ancoragem.

```text
HTTP -> autenticação/RBAC -> controller -> BidService
  -> BEGIN READ COMMITTED
  -> SELECT auction FOR UPDATE -> clock_timestamp()
  -> usuário/papel -> operação idempotente existente?
     -> sim: comparar fingerprint e retornar recibo original
  -> histórico completo/minimum/estado LIVE/líder
  -> carteiras por UUID crescente -> reservas ACTIVE do lote
  -> clock_timestamp() novamente -> revalidar LIVE e anti-sniping
  -> saldo disponível -> RELEASED anterior -> novo bid -> ACTIVE novo
  -> currentBidId/endsAt -> BID_ACCEPTED + outbox -> replay completo
  -> recibo persistido em bid_operations -> COMMIT
  -> resposta HTTP; worker existente publica âncoras independentemente
```

Não há chamada externa enquanto a transação mantém locks. O appender e as operações
de reserva recebem exatamente a transação do chamador e não iniciam/confirmam outra.
O repositório concreto fornece o contexto limitado ao serviço e injeta reservas/auditoria.

### Locks e invariantes

Ordem efetiva: auction; carteiras em ordem crescente do UUID real da carteira;
reservas; escritas financeiras/auditáveis. Não se confia em uma consulta `IN` para
ordenar locks: o adaptador percorre explicitamente os UUIDs ordenados com FOR UPDATE.
Métodos de reserva readquirem locks já mantidos pelo fluxo, sem inversão.

Depois de adquirir os locks de carteiras/reservas, o serviço obtém outra leitura do
relógio PostgreSQL. Isso impede aceitar um lance com horário anterior a uma longa
espera por depósito ou por outra disputa usando a mesma carteira.

O histórico deve começar em 1, ser contíguo, ter valores válidos e crescentes pelo
incremento, alternar líderes e manter timestamps não decrescentes. Seu último bid
deve ser o currentBidId. O antigo líder deve possuir exatamente uma reserva ACTIVE
correspondente ao bid, valor e carteira. Cada carteira exige:

- `0 <= reservedCents <= balanceCents <= MAX_BIGINT`.
- `reservedCents = SUM(amountCents das reservas ACTIVE)`.
- Disponível suficiente para o novo lance.

Liberação ocorre antes da nova reserva para respeitar o índice parcial. Falhas
posteriores revertem essa liberação. Reservar/liberar não altera balanceCents e não
cria transação ou entrada no ledger. Depósitos continuam usando o mecanismo existente.

### Idempotência

`bid_operations` é específico de PlaceBid, separado da idempotência de depósitos.
Chave única: `(userId, auctionId, key)`. Fingerprint SHA-256 usa separador de domínio
`verzel:bid:place:v1\0` e o JSON canônico `{amountCents: "..."}`. A operação vincula
um bid único e o recibo completo. O store valida formato, escopo, fingerprint e bid.

O lock do leilão serializa o lookup/inserção; o índice único é uma defesa adicional
real, testada com uma transação esperando a chave ainda não confirmada. Não há
SELECT/INSERT desprotegido. Replays são resolvidos antes de LIVE/liderança/saldo:
mesma chave/valor devolve o recibo original mesmo após superação, expiração ou
status terminal; valor diferente gera 409 IDEMPOTENCY_CONFLICT. Autenticação e
papel BIDDER atual continuam obrigatórios. Chaves não são expiradas automaticamente.

### Anti-sniping e auditoria

Se `0 < oldEndsAt - dbNow <= 120000ms`, o novo prazo é **oldEndsAt + 120000ms**.
Fora da janela não muda. Rejeições e replays não prorrogam. A regra explícita do
pedido resolve a formulação resumida “para +2 minutos” da página 4 do PDF.

O evento BID_ACCEPTED reutiliza bidId, bidderReference por leilão, centavos, sequência,
horário e endsAt resultante. Após gravar o evento, o adaptador valida cadeia e replay
operacional completos na mesma transação. Baseline ausente ou histórico anterior
incompleto gera AUDIT_STATE_CONFLICT e rollback; não há backfill histórico silencioso.
O replay existente foi reforçado para exigir a prorrogação exata, e não só um prazo maior.

Publicação externa fica na outbox existente após commit. Um teste com PostgreSQL
e witness HTTP assinado observou PENDING_ANCHOR antes de publicar e VERIFIED na
sequência 2 após a publicação. Isso é evidência local controlada, não deploy de produção.

## Implementação e contratos

Arquivos novos de produção:

- `src/modules/bids/contracts/bids.ts`.
- `src/modules/bids/domain/{bid-rules,idempotency}.ts`.
- `src/modules/bids/infrastructure/{operations.schema,transactional-bid-audit}.ts`.
- `src/modules/bids/repositories/{drizzle-bid-repository,drizzle-bid-query-repository,drizzle-bid-operation-store}.ts`.
- `src/modules/bids/services/bid-service.ts`, `controllers/bid-controller.ts` e `index.ts`.
- `src/modules/wallets/repositories/drizzle-reservation-operations.ts`.
- `drizzle/20261024203312_secret_talisman/{migration.sql,snapshot.json}`.

Novos testes: `tests/{bid-rules,bid-service,bid-audit}.test.js`, helpers `{bids,bid-locks}.js`
e integrações `bid-{http,idempotency,audit,anchoring,migration}.test.js`,
`bids-{flow,concurrency}.test.js` e `reservations.test.js`.

Modificados: composição de Auctions; replay operacional da auditoria; contrato de
reservas e schema Wallets; export central do schema; testes de schema/fixture Auctions;
README e guias de Auctions, Wallets e Auditoria. Novos documentos: plano desta fase,
`docs/bids.md` e este relatório. Nenhuma variável de ambiente ou dependência nova.

Migration aditiva: tabela bid_operations com FKs/unicidade de escopo e de bid,
mais índice parcial único ACTIVE por auction_id. Snapshot compactado em JSON válido
para manter commits abaixo de 500 linhas. Duplicatas ACTIVE legadas fazem a migration
falhar; exigem investigação, não exclusão automática ou enfraquecimento da constraint.

Endpoints:

| Endpoint | Contrato |
| --- | --- |
| POST `/auctions/:auctionId/bids` | BIDDER, Idempotency-Key único, `{amountCents:string}`, 201 `{bid}`. |
| GET `/auctions/:auctionId/bids` | Público; sequência crescente, total/página, currentBid, status/endsAt/asOf. |
| GET `/auctions/bids/mine` | BIDDER; somente seus lances, createdAt DESC/id ASC, isLeading/status/endsAt. |

Recibo imutável: id, auctionId, bidderRef, amountCents, sequence, createdAt e endsAt
resultante daquela operação. Para prazo/líder atuais, consultar o histórico. isLeading
significa igualdade com o ponteiro atual, inclusive em estado terminal; não prova pagamento.

UUIDs das rotas são normalizados para minúsculas. Dinheiro/sequências JSON são strings,
sem cálculos monetários por Number. Limit padrão 30/máximo 100; skip até 2147483647;
campos/queries desconhecidos ou repetidos e headers de idempotência duplicados são rejeitados.
Histórico público valida todos os registros suportados antes da página, incluindo os
que não serão retornados. Não se expõem e-mails, bidderId, carteiras, saldos ou chaves.

Erros seguem `{error:{code,message}}`: 400 sintaxe, 401 identidade ausente/inexistente,
403 papel, 404 lote/carteira ausente, 409 LIVE/minimum/liderança/fundos/overflow,
inconsistência financeira/auditável ou idempotência. Erros inesperados são sanitizados
pelo middleware; SQL interno não vai para HTTP.

## Concorrência, testes e evidências

| Comando executado | Resultado final |
| --- | --- |
| `npm test` | 73 aprovados, 0 falhos, 1 ignorado; 74 cenários. |
| `npm run test:db` | 148 aprovados, 0 falhos, 0 ignorados. |
| `npm run lint` | Saída 0, sem warnings. |
| `npm run typecheck` | Saída 0. |
| `npm run build` | Saída 0. |

O único ignorado é o cenário anterior de symlink de arquivo do witness, por EPERM
no Windows. Não foi omitida falha financeira ou de concorrência. A suíte anterior
de Auth/Catalog/Auctions/Wallets/Ledger/Auditoria permaneceu incluída e aprovada.

| Cenários obrigatórios do pedido | Evidência PostgreSQL / estado final |
| --- | --- |
| 1–4: primeiro válido, abaixo do inicial/incremento, líder cobrindo a si | Aceite apenas do válido; rejeições preservam ponteiro, prazo e saldos. |
| 5: AUCTIONEER | 403 em lote próprio e de outro leiloeiro, sem bid persistido. |
| 6–9: agendado, encerrado, cancelado, insuficiência de saldo | 409, sem nova reserva/recibo/bid/prorrogação. |
| 10–11: reserva e liberação | Somente novo líder ACTIVE; anterior RELEASED; reservado exato; balance/ledger iguais. |
| 12: falha imediatamente após liberar o anterior | Exceção após UPDATE real; estado anterior restaurado integralmente. |
| 13: falha da auditoria | Appender real grava evento e lança falha; todos os writes/outbox são revertidos. |
| 14: simultâneos mesmo valor | Um 201 e um 409; um único líder/reserva/recibo. |
| 15: crescentes 11000/12000 após 10000 | Ordem dos locks controlada; ambos aceitos, sequência 1/2/3, reserva final 12000. |
| 16: 23 do mesmo usuário | Um efeito; outras 22 rejeitadas por ALREADY_LEADING; nenhuma reserva duplicada. |
| 17: dois leilões/saldo só para um | Um aceite, outro INSUFFICIENT_FUNDS; soma reservada 100 sobre saldo 150. |
| 18–19: mesma chave concorrente e payload diferente | Recibos idênticos/um efeito; conflito de fingerprint sem segundo efeito. |
| 20: retry após estado alterado | Mesmo recibo após superação, prazo vencido e SETTLED simulado por SQL. |
| 21–22: limite exato e prorrogações | 120000ms inclui janela; 120001ms não; prazo anterior +2min sucessivamente. |
| 23: lance/expiração | Espera real em lock do lote e da carteira; relógio revalidado; prazo preservado na rejeição. |
| 24: depósito/reserva | Depósito confirmado enquanto bid espera; bid observa crédito e ledger soma zero. |
| 25–26: invariantes/ledger | Reservado igual à soma ACTIVE, não negativo/maior que balance; reserva não gera ledger. |
| 27: sequências | Contíguas e únicas após concorrência; ponteiro corresponde ao último bid. |
| 28: rollback crítico | Falhas após release, após audit/outbox e no insert final da operação restauram todas as tabelas. |

Os testes usam conexões independentes, FOR UPDATE mantido por uma barreira e
`pg_blocking_pids`, inclusive cadeia recursiva de esperas. A ordem 11000 antes de
12000 é verificada no PostgreSQL; não se presume ordem de chegada ao Node.
Polling curto serve para observar estado real de bloqueio/relógio, não como único
mecanismo para provocar corrida. Asserções consultam explicitamente o estado final.

Nos limites exatos do anti-sniping, a transação/banco são reais e o contexto recebe
um instante controlado derivado do prazo persistido. Isso testa o ramo exato sem
alegar sincronização HTTP ao milissegundo. Outros testes usam o clock_timestamp real,
inclusive para expiração após espera. Não existe SettlementService real nesta fase;
SETTLED em teste de retry é fixture SQL, não uma liquidação financeira executada.

Também foram testados UUID maiúsculo, corrupção econômica fora da página, header
duplicado, escopo de consulta privada, índice parcial contra INSERT SQL direto,
BIGINT máximo de ponta a ponta e rejeição de próximo mínimo acima do limite.

### Revisão e correções

O revisor reproduziu um histórico público retornando 200 quando um bid inválido
estava fora da página. O principal escreveu regressão vermelha e passou a validar
o histórico completo suportado na mesma leitura REPEATABLE READ. A regressão ficou
verde e o revisor executou a reprodução novamente: 2 testes focados aprovados,
sem regressão nos ajustes. UUID maiúsculo também teve regressão vermelha e correção.

Não houve deadlock nos cenários de líderes cruzados entre dois leilões nem entre
depósito e bid. A garantia depende de todos os futuros fluxos respeitarem a ordem
global; não é afirmação de ausência de deadlocks em SQL administrativo arbitrário.

## Aderência ao desafio e limites

Páginas 2/4: RBAC, lances LIVE, mínimos, proibição de auto-superação, saldo disponível,
reserva/liberação imediata e anti-sniping atendidos. Páginas 2/3/4: histórico público
e auditoria reutilizada, sem PII. Página 5: stack preservada e documentação atualizada.
Frontend público/Meus Arremates completos, comprovantes e deploy obrigatório continuam
pendentes; não foram declarados concluídos por entregar consultas de backend.

Limites remanescentes:

- Histórico/replay têm limite de 10000 registros; volumes maiores exigem estratégia
  de verificação por checkpoints/páginas sem reduzir a prova. Não houve benchmark de carga.
- Reservas continuam presas ao líder após expiração até a futura liquidação/liberação;
  não há worker automático de settlement nesta entrega.
- Idempotência e provas usam o banco e o witness conforme seus modelos de ameaça.
  Um sufixo ainda não ancorado pode ser reescrito por acesso privilegiado ao banco;
  nenhuma nova garantia externa foi inventada. Produção exige witness independente/TLS/chaves.
- Validação financeira compara balance/reserved/ACTIVE, sem substituir reconciliação
  econômica do ledger nem provar legitimidade de saldo adulterado por SQL privilegiado.
- Não houve teste de estresse prolongado, múltiplas instâncias em deploy ou queda
  de energia do PostgreSQL. Testes usam schemas isolados no PostgreSQL17 local real.
- Testes de falha usam injeção no contexto/appender e trigger SQL de erro, preservando
  persistência/rollback reais; não são simulação de um banco em memória.

## Próximas etapas

1. Definir captura e unidade transacional de SettlementService com as mesmas ordens
   de locks, chaves persistentes e ledger de partidas dobradas.
2. Implementar SettlementService/Worker para lotes vencidos, revalidando prazo após
   o lock para respeitar anti-sniping concorrente; fechar sem lances sem vencedor.
3. Gerar comprovantes públicos e evento de settlement; ampliar prova econômica.
4. Socket.IO pode avançar em paralelo após definir publicação recuperável pós-commit;
   frontend pode consumir contratos HTTP estáveis enquanto settlement evolui.
5. Operação do witness/TLS, seed de lote aberto e preparação de deploy podem ocorrer
   em paralelo; publicar somente com autorização específica, sem push nesta execução.

Aceite da próxima fase: captura idempotente, transferência balanceada, comprovante
consistente, nenhum débito duplo ou reserva perdida, corrida bid/worker serializada
pelo lote e auditoria/outbox participando da mesma transação econômica.
