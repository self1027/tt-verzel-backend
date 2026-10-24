# Wallets & Ledger

Depósitos exclusivamente simulados. O fluxo usa as tabelas e constraints existentes,
sem migration ou dependência nova. Não há cadastro público: o seed cria uma carteira
e uma conta USER_WALLET por usuário. As consultas e depósitos também completam
provisionamento ausente, transacionalmente e usando as constraints únicas de userId
e walletId. Uma carteira já financiada sem conta contábil gera 409, sem reconstrução
silenciosa. A conta SIMULATION_CLEARING deve ser criada pelo seed; ausência,
duplicidade ou vínculo indevido a carteira impede novos depósitos.

## HTTP

Todas as rotas exigem Bearer JWT. O usuário e seu papel vêm do middleware existente,
que verifica o token e consulta o usuário. Nenhuma rota aceita identidade no payload.

| Método | Rota | Papel | Resposta |
| --- | --- | --- | --- |
| GET | /wallet | BIDDER ou AUCTIONEER | 200, `{ wallet: { balanceCents, reservedCents, availableCents } }` |
| POST | /wallet/deposits | BIDDER | 201, `{ deposit: { transactionId, amountCents, createdAt } }` |
| GET | /wallet/transactions?limit=30&skip=0 | BIDDER ou AUCTIONEER | 200, `{ transactions, total, limit, skip }` |

Corpo do depósito: `{ "amountCents": "10000" }`, sem campos extras. Header obrigatório:
`Idempotency-Key`, de 1 a 128 caracteres ASCII, começando por letra ou dígito, seguido
de letras, dígitos, `.`, `_`, `:` ou `-`. Headers repetidos são rejeitados.

Valores monetários da API são strings decimais canônicas. Entrada positiva, de `"1"`
até `"9223372036854775807"`; números JSON, sinais, zeros iniciais, espaços, frações
e notação científica são inválidos. Todas as operações monetárias usam bigint.
Uma entrada válida que excederia o limite do saldo acumulado retorna 409.
O histórico permite valores negativos nas entradas de futuras transferências.

Histórico: limit padrão 30, de 1 a 100; skip padrão 0, até 2147483647. Ordenação
createdAt DESC, id ASC. Paginação e total são aplicados às transações, e cada item
inclui apenas suas próprias entradas `{ id, amountCents }`, além de id, type,
amountCents (soma das próprias entradas) e createdAt. Contrapartidas, chaves de
idempotência, hashes, emails e dados de terceiros não são retornados.

Erros seguem o middleware existente: `{ error: { code, message, details? } }`.
400 para validação; 401 autenticação; 403 papel; 404 usuário inexistente no contrato
interno; 409 conflito de idempotência, overflow acumulado ou estado inconsistente.
Falhas inesperadas retornam 500 sem SQL, constraints ou mensagens PostgreSQL.

## Idempotência persistente

O ledger armazena `deposit:<userId autenticado>:<chave>` no campo idempotencyKey
único. referenceId guarda walletId; a entrada positiva vincula conta e valor.
Usuários diferentes podem usar a mesma chave de cliente independentemente.

Sob o lock da carteira, o serviço consulta a chave antes de qualquer crédito.
Mesmo valor retorna o recibo persistido original, inclusive sua data, com 201.
Valor diferente retorna 409 IDEMPOTENCY_CONFLICT. O recibo não contém um saldo
mutável nem uma flag de repetição: repetições retornam exatamente o mesmo resultado
mesmo após outros depósitos ou reinício do processo. Nenhuma chave é expirada.

## Ledger, atomicidade e concorrência

Cada depósito grava uma transação DEPOSIT e exatamente duas entradas:
USER_WALLET +amount e SIMULATION_CLEARING -amount. O escritor valida entradas
não nulas, limites BIGINT e soma zero antes de persistir. Não há métodos de edição
ou exclusão nem endpoints públicos para escrita no ledger. A compensação não é uma
carteira e pode apresentar saldo contábil negativo.

O repositório inicia uma transação READ COMMITTED, provisiona se necessário e
bloqueia a carteira com SELECT FOR UPDATE. Requisições concorrentes aguardam esse
registro; após adquirir o lock, lêem o saldo e a idempotência já confirmados.
Ledger e atualização de balanceCents/updatedAt usam a mesma transação. Qualquer
falha reverte todos os registros, inclusive provisionamento inicial. Não há I/O
externo durante os locks.

Ordem para futuros fluxos entre módulos: **auctions primeiro**, carteiras em ordem
crescente de UUID, reservas, depois escrita no ledger. Depósito só usa sua carteira
e nunca tenta adquirir um lock de leilão depois. Toda alteração de saldo/reserva
deverá bloquear a carteira. Contas não têm saldo materializado a atualizar.
DrizzleLedgerRepository recebe DatabaseTransaction do chamador; não abre ou confirma
transações próprias. Assim poderá participar da transação do futuro lance/liquidação.

Invariantes verificadas antes de consultar/creditar: balance >= 0, reserved >= 0,
reserved <= balance; available = balance - reserved >= 0. Depósitos alteram apenas
balance, preservando reserved. Sem migration, estas verificações protegem os fluxos
da aplicação; SQL administrativo direto continua sendo responsabilidade do operador.

## Reconciliação interna

`new WalletService(new DrizzleWalletRepository(db)).reconcile(userId)` retorna
walletId, balanceCents, ledgerBalanceCents, differenceCents (saldo menos ledger) e
consistent. SUM usa PostgreSQL numeric, convertido de texto para bigint, sem perda
de precisão ou overflow do agregado. A leitura mantém o lock da carteira durante
o cálculo, evitando divergência falsa por depósitos concorrentes. Reservas não são
somadas ou subtraídas do ledger. Divergência ou invariantes inválidas resultam em
consistent=false e nunca modificam o saldo. Não existe endpoint de reconciliação.

## Reservas transacionais

`ReservationOperations` recebe a transação PostgreSQL do chamador em cada operação.
`DrizzleReservationOperations` implementa reserveFunds/releaseReservation e é usado
pelo [BidService](bids.md). Captura permanece um contrato para a fase de liquidação.

- reserveFunds: carteira/auction/bid devem corresponder, valor positivo e disponível
  suficiente; incrementar reserved e criar ACTIVE atomicamente, sem alterar balance
  ou ledger. bidId único é a chave: mesmos termos em ACTIVE retornam o registro;
  termos diferentes ou estado terminal geram 409.
- releaseReservation: ACTIVE -> RELEASED, decrementar reserved uma única vez e
  registrar releasedAt; RELEASED repetido retorna o original; CAPTURED gera 409.
  Balance e ledger permanecem iguais.
- captureReservation: ACTIVE -> CAPTURED, decrementar balance e reserved pelo valor
  reservado, com transferência balanceada para a carteira destinatária na mesma
  transação. Chave persistente deve vincular reserva, destinatário e valor. Repetição
  idêntica devolve resultado original; termos diferentes ou RELEASED geram 409.
  Não se usa releasedAt para representar captura. Os dois lados da transferência
  e a liquidação futura devem compartilhar a transação do chamador.

O adaptador valida carteira/usuário/lance, saldos e soma das reservas ACTIVE; os locks
das carteiras são adquiridos por UUID em ordem crescente antes das reservas. Um índice
parcial único impede duas reservas ACTIVE no mesmo leilão. Reservar/liberar não gera
movimento contábil nem altera balanceCents. Captura e SettlementService/Worker ainda
não estão implementados. A auditoria existente recebe os lances na mesma transação.

## Exemplos no CMD

Após login de BIDDER, substitua TOKEN pelo accessToken:

```bat
curl http://localhost:3000/wallet -H "Authorization: Bearer TOKEN"
curl -X POST http://localhost:3000/wallet/deposits -H "Authorization: Bearer TOKEN" -H "Content-Type: application/json" -H "Idempotency-Key: demo-deposit-1" -d "{\"amountCents\":\"10000\"}"
curl "http://localhost:3000/wallet/transactions?limit=30&skip=0" -H "Authorization: Bearer TOKEN"
```

## Arquivos e validação

Novos arquivos:

- `src/modules/wallets/contracts/wallets.ts`
- `src/modules/wallets/contracts/reservations.ts`
- `src/modules/wallets/controllers/wallet-controller.ts`
- `src/modules/wallets/repositories/drizzle-wallet-repository.ts`
- `src/modules/wallets/services/wallet-service.ts`
- `src/modules/wallets/index.ts`
- `src/modules/ledger/contracts/ledger.ts`
- `src/modules/ledger/repositories/drizzle-ledger-repository.ts`
- `src/modules/ledger/services/balance.ts`
- `tests/wallets-ledger.test.js`
- `tests/integration/wallets.test.js`
- `docs/wallets-ledger.md`
- `docs/superpowers/plans/2026-10-23-wallets-ledger.md`

Modificados: `src/app.ts`, `src/server.ts` e `src/shared/database/client.ts`.

Execute `npm test`, `npm run test:db`, `npm run lint`, `npm run typecheck` e
`npm run build`. Integração usa PostgreSQL real do Docker, com schemas isolados
criados e removidos pelo helper existente; não altera o banco de desenvolvimento.

Resultados em 2026-10-23: npm test 24/24; npm run test:db 65/65 (21 financeiros);
lint, typecheck e build concluídos com código 0. Revisão independente sem defeitos
acionáveis; também verificou os testes financeiros com timezone America/Sao_Paulo.
