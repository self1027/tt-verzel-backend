# Lances, reservas e repetição de requisições

O módulo aceita lances com saldo previamente depositado na carteira. Um lance aceito
reserva integralmente seu valor, libera a reserva do líder anterior e registra o novo
líder, a auditoria e o recibo de idempotência em uma única transação PostgreSQL.

## API

| Método e rota | Acesso | Resultado |
| --- | --- | --- |
| `POST /auctions/:auctionId/bids` | Bearer token de `BIDDER` | `201`, recibo imutável do lance |
| `GET /auctions/:auctionId/bids` | Público | Histórico paginado e estado atual do leilão |
| `GET /auctions/bids/mine` | Bearer token de `BIDDER` | Somente os lances do usuário autenticado |

O identificador do participante vem da autenticação. O corpo do POST aceita somente
`amountCents`; campos como `userId`, `walletId`, `sequence` e `createdAt` são rejeitados.

```http
POST /auctions/11111111-1111-4111-8111-111111111111/bids
Authorization: Bearer <token>
Content-Type: application/json
Idempotency-Key: lance-cliente-42

{"amountCents":"15000"}
```

```json
{
  "bid": {
    "id": "22222222-2222-4222-8222-222222222222",
    "auctionId": "11111111-1111-4111-8111-111111111111",
    "bidderRef": "<SHA256 hexadecimal de 64 caracteres>",
    "amountCents": "15000",
    "sequence": "1",
    "createdAt": "2026-10-24T12:00:00.000Z",
    "endsAt": "2026-10-24T13:00:00.000Z"
  }
}
```

Valores monetários e sequências são strings decimais no JSON para preservar a precisão
de `BIGINT`, inclusive acima de `Number.MAX_SAFE_INTEGER`. O valor enviado deve ser
positivo, sem sinal, espaços, casas decimais ou zeros à esquerda, até
`9223372036854775807`. Datas retornadas usam UTC com milissegundos.

### Idempotência

O POST exige exatamente um cabeçalho `Idempotency-Key`. A chave tem de 1 a 128
caracteres e segue `^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$`. Cabeçalhos duplicados,
chaves vazias e valores com espaços ou vírgulas são rejeitados.

A identidade da operação é `(usuário, leilão, chave)`. A mesma chave pode ser usada
por outro usuário ou em outro leilão sem compartilhar resultados. Dentro desse
escopo, o fingerprint SHA256 vincula a chave ao valor canônico do lance e à versão
do formato de PlaceBid. O armazenamento fica em `bid_operations`, separado das
operações de depósito e do ledger.

Repetir a chave com o mesmo valor retorna `201` e o mesmo recibo, inclusive seu
`createdAt`, sua sequência e seu `endsAt`. Isso continua válido depois de outro
participante assumir a liderança, de o prazo mudar ou de o leilão deixar de estar
ao vivo. A autenticação e o papel atual do usuário continuam obrigatórios. A
repetição é resolvida antes das validações do estado atual do negócio.

Reutilizar a chave com outro valor retorna `409 IDEMPOTENCY_CONFLICT`. Requisições
concorrentes com a mesma chave são serializadas pelo lock do leilão; o índice único
do banco também impede duas operações com o mesmo escopo. Cada lance pode estar
vinculado a apenas uma operação persistida.

O recibo representa a aceitação original. Para consultar o prazo e o líder mais
recentes, use o GET do histórico. Uma repetição bem-sucedida não cria outro lance,
reserva, evento de auditoria ou checkpoint da outbox.

### Consultas e privacidade

As duas consultas aceitam somente `limit` e `skip`, com padrões `30` e `0`.
`limit` deve estar entre `1` e `100`; `skip`, entre `0` e `2147483647`.
Parâmetros desconhecidos ou repetidos e valores fora dos limites retornam `400`.

O histórico público retorna `bids`, `total`, `limit`, `skip`, `currentBid`, `endsAt`,
`status` e `asOf`. A página ordena os lances por sequência crescente.
`currentBid` informa o líder de todo o histórico, mesmo quando ele está fora da
página solicitada. Sem lances, `bids` é vazio e `currentBid` é `null`.

A consulta `mine` retorna `bids`, `total`, `limit`, `skip` e `asOf`; cada lance inclui
também `isLeading`, `status` e o `endsAt` atual do respectivo leilão. A ordenação é
por `createdAt` decrescente, com UUID do lance crescente como desempate. O filtro
é sempre o usuário autenticado; enviar `userId` na query é inválido.

`isLeading` indica apenas se o ponteiro atual do leilão aponta para aquele lance.
Esse campo não comprova pagamento, captura de fundos ou liquidação. `status` é o
estado administrativo persistido (`PUBLISHED`, `CANCELLED`, `SETTLED` ou
`CLOSED_NO_BIDS`); o prazo deve ser considerado para distinguir um leilão publicado
ao vivo de um leilão cujo horário terminou.

As consultas usam uma transação de leitura `REPEATABLE READ` para manter página,
contagem, ponteiro e prazo no mesmo snapshot. `asOf` informa o relógio do banco
obtido nessa consulta; uma chamada posterior pode observar alterações.

O público recebe `bidderRef`, derivado de usuário e leilão, sem UUID do usuário,
nome, e-mail ou dados da carteira. A referência é estável dentro do leilão e muda
entre leilões. Chaves de idempotência e dados internos de reservas não aparecem
nas respostas públicas.

### Erros

Os erros têm o formato `{"error":{"code":"...","message":"..."}}`.
Erros de validação podem incluir `details` com caminho e código de cada campo.

| HTTP | Situação ou códigos relevantes |
| --- | --- |
| `400` | JSON, UUID, corpo, valor, chave ou paginação inválidos; `VALIDATION_ERROR`, `INVALID_JSON` |
| `401` | Token ausente/inválido ou usuário removido; `UNAUTHENTICATED` |
| `403` | Papel diferente de `BIDDER`; `BIDDER_REQUIRED` ou recusa da autorização |
| `404` | `AUCTION_NOT_FOUND`, `WALLET_NOT_FOUND` |
| `409` | `AUCTION_NOT_LIVE`, `ALREADY_LEADING`, `BID_TOO_LOW`, `INSUFFICIENT_FUNDS`, `BID_LIMIT`, `IDEMPOTENCY_CONFLICT` |
| `409` | Inconsistência interna: `BID_HISTORY_CORRUPT`, `INVALID_WALLET_STATE`, `RESERVATION_CONFLICT`, `INVALID_BID_OPERATION`, `AUDIT_STATE_CONFLICT` |
| `500` | Falha inesperada, com resposta genérica `INTERNAL_ERROR` |

Falhas deixam a transação sem efeitos parciais. Erros de integridade exigem
investigação do estado persistido; trocar a chave não corrige o problema.

## Regras de aceitação e prazo

Um novo lance exige leilão publicado com `startsAt <= agora < endsAt`, participante
com papel `BIDDER` e saldo disponível suficiente. O líder atual não pode aumentar
seu próprio lance. O primeiro valor deve alcançar `startingBidCents`; os seguintes
devem alcançar o último valor mais `minIncrementCents`. A sequência começa em `1`,
é contígua e não pode ultrapassar o limite de `BIGINT`.

A decisão usa o relógio PostgreSQL. Depois de esperar pelos locks das carteiras e
reservas, o serviço lê novamente esse relógio e revalida se o leilão está ao vivo.
Uma requisição que chegou antes do fim pode ser rejeitada se a espera consumiu o
prazo.

Se o tempo restante for positivo e menor ou igual a `120000` ms, o novo prazo é
**o prazo anterior mais `120000` ms**. Por exemplo, um leilão que termina às 13:00
e aceita um lance às 12:59:30 passa a terminar às 13:02. Outro lance aceito às
13:01 amplia esse novo prazo para 13:04. Fora dessa janela, o prazo permanece
igual. Lances rejeitados não prorrogam o leilão.

## Transação, locks e reservas

`BidService` depende de contratos de domínio; `DrizzleBidRepository` fornece um
contexto ligado à transação `READ COMMITTED` do chamador. A ordem de aquisição é:

1. Leilão com `FOR UPDATE`.
2. Carteiras envolvidas, uma a uma, em ordem crescente dos UUIDs reais das carteiras.
3. Reservas ativas do leilão com `FOR UPDATE`.

Ordenar UUIDs das carteiras, em vez de identificadores de usuários, mantém a mesma
ordem quando dois leilões disputam as mesmas carteiras. O lock da carteira também
serializa alterações com depósitos e reservas em outros leilões.

O serviço valida histórico, ponteiro, vínculo do líder e sua reserva exata. Para
cada carteira bloqueada, o total reservado deve ser não negativo, não ultrapassar
o saldo e corresponder à soma de suas reservas `ACTIVE`.

Ao substituir o líder, a reserva anterior é liberada antes de inserir a nova
reserva. Essa ordem atende ao índice parcial que permite apenas uma reserva
`ACTIVE` por leilão. O novo lance, sua reserva, o ponteiro, o prazo, a auditoria e
o recibo são gravados antes do commit da mesma transação. Qualquer falha desfaz
também a liberação do antigo líder.

`DrizzleReservationOperations` usa exclusivamente a transação recebida.
`reserveFunds` utiliza o UUID do lance como chave: repetir lance e termos de uma
reserva ativa retorna a reserva existente; mudar os termos ou tentar reutilizar
uma reserva terminal gera conflito. `releaseReservation` faz
`ACTIVE -> RELEASED` e desconta o reservado uma única vez; repetir uma liberação
é uma operação sem efeito adicional. Reservas capturadas não podem ser liberadas.

Reservar e liberar alteram somente `reservedCents` e o registro de reserva.
O saldo total e o ledger permanecem iguais. Captura de reserva e transferência
contábil pertencem ao futuro fluxo de liquidação; `captureReservation` permanece
um contrato e não é executado por PlaceBid.

## Auditoria e migração

O módulo reutiliza `DrizzleAuditAppender` para gravar `BID_ACCEPTED`, com referência
pseudônima do participante, valor, sequência, instante e prazo resultante. Depois
da gravação, relê toda a cadeia e o estado operacional dentro da mesma transação,
valida os hashes e reproduz os compromissos, incluindo a regra exata de prorrogação.
O limite local de auditoria é de 10000 eventos; não há validação de prefixo parcial
como se ele cobrisse todo o histórico.

Leilão sem o compromisso inicial ou com lances anteriores sem correspondência na
auditoria é rejeitado com `409 AUDIT_STATE_CONFLICT`. A operação não cria uma linha
de base retroativa silenciosa. A correção de dados legados requer investigação e
um procedimento explícito separado.

Os checkpoints da outbox `audit_anchors` são gravados atomicamente com os eventos.
O worker existente publica a âncora externa somente a partir de dados já
confirmados. Não há chamada externa enquanto PlaceBid mantém locks. Sem prova
externa, uma cadeia local consistente pode aparecer como `PENDING_ANCHOR`; um
commit do lance não representa confirmação externa da cadeia. As limitações do
sufixo ainda não ancorado continuam válidas.

A migração aditiva `drizzle/20261024203312_secret_talisman/migration.sql` cria
`bid_operations`, seus vínculos e índices, e o índice parcial único
`wallet_reservations_active_auction_unique`. Antes de migrar dados legados, esta
consulta identifica leilões com reservas ativas duplicadas:

```sql
SELECT auction_id, count(*) AS active_count
FROM wallet_reservations
WHERE status = 'ACTIVE'
GROUP BY auction_id
HAVING count(*) > 1;
```

Se houver duplicidades, a criação do índice falha. Investigue o líder, os vínculos,
os valores e os totais das carteiras antes de uma correção autorizada. A migração
não remove reservas nem escolhe automaticamente qual delas deve sobreviver.

## Verificação e escopo

Com PostgreSQL acessível e `TEST_DATABASE_URL` configurada, execute:

```sh
npm test
npm run test:db
npm run lint
npm run typecheck
npm run build
```

Os testes de integração usam schemas isolados e PostgreSQL real. As disputas
relevantes verificam bloqueios pelo banco, incluindo `pg_blocking_pids`, além das
respostas finais. Há cobertura de repetição, isolamento de escopo, perda de
liderança, prorrogação, saldo compartilhado e rollback de auditoria e recibo.

Esta implementação usa a infraestrutura existente, sem Redis ou novas
dependências. Publicação de sockets, captura, liquidação e deploy permanecem fora
do fluxo implementado.
