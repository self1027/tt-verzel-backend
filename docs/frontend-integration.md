# Guia de integração com o frontend

O backend oferece HTTP e Socket.IO na mesma origem. Endereços locais padrão:
`http://localhost:3000` para a API e `http://localhost:5173` para o frontend Vite.
O frontend e sua hospedagem não fazem parte deste repositório. O contrato HTTP
mantido pelo projeto está em [`openapi.yaml`](openapi.yaml) e no Swagger UI em
`/docs/`.

Configure `VITE_API_URL=http://localhost:3000` no frontend e
`CORS_ORIGINS=http://localhost:5173` no backend. `CORS_ORIGINS` aceita uma lista
separada por vírgulas de origens HTTP(S) exatas. Na Vercel, configure a origem real
do frontend no backend e o endereço HTTPS do backend no frontend. Inclua origens
de pré-visualização quando necessário; essas configurações não fazem o deploy.

Envie `POST /auth/login` com `{ "email": "bidder1@verzel.local", "password": "..." }`.
Use a senha configurada no seed e envie `Authorization: Bearer <accessToken>` nas
rotas protegidas. A resposta de login contém `accessToken`, `tokenType`, `expiresIn`
e `user`. `GET /auth/me` recupera o usuário autenticado. Resposta 401 indica que
a sessão precisa ser renovada; 403 indica que o papel não pode realizar a operação.
Não há cadastro nem endpoint de administrador.

| Tela/ação | Endpoint e acesso |
| --- | --- |
| Consultar/buscar catálogo | GET `/catalog/external`, `/catalog/external/search?q=...`, `/catalog/categories`; Bearer |
| Importar produto | POST `/catalog/import/{externalNumericId}`; `AUCTIONEER`; corpo vazio |
| Produtos armazenados | GET `/catalog/products`, `/catalog/products/{snapshotUuid}`; Bearer |
| Leilões e detalhes públicos | GET `/auctions`, `/auctions/{uuid}`; público |
| Leilões próprios | GET `/auctions/mine`; `AUCTIONEER` |
| Publicar/editar/cancelar | POST `/auctions`, PATCH `/auctions/{uuid}`, POST `/auctions/{uuid}/cancel`; proprietário `AUCTIONEER` |
| Saldo/histórico | GET `/wallet`, `/wallet/transactions`; Bearer |
| Depósito simulado | POST `/wallet/deposits`; `BIDDER`; header `Idempotency-Key` e `{ "amountCents": "10000" }` |
| Lance/histórico | POST ou GET `/auctions/{uuid}/bids`; POST exige `BIDDER`, chave e valor; GET é público |
| Próprios lances | GET `/auctions/bids/mine`; `BIDDER` |
| Auditoria | GET `/auctions/{uuid}/audit`, `/auctions/{uuid}/audit/events`; público |
| Compartilhar comprovante | GET `/auctions/{uuid}/receipt`; público após liquidação financeira |

Centavos e sequências são enviados como strings decimais. Use `BigInt` nos cálculos
e converta o resultado de volta para string antes de serializar JSON. Formate a
moeda sem converter valores grandes de centavos em `Number`. Gere uma chave de
idempotência por depósito ou lance pretendido, reutilize-a nas tentativas da mesma
requisição e use outra chave para um valor diferente. Depósitos e lances bem-sucedidos
retornam 201, inclusive em repetição idempotente. Use `error.code` nas respostas de
erro e apresente mensagens claras para erros de validação e conflitos financeiros.

A busca de leilões aceita `q`, `lifecycleState`, `minPriceCents`, `maxPriceCents`,
`sort`, `limit` e `page` (baseado em um) ou `skip` legado. Exemplo:
`/auctions?q=mascara&lifecycleState=LIVE&minPriceCents=1000&sort=price_asc&limit=10&page=1`.
Chaves desconhecidas ou repetidas e o uso simultâneo de `page` e `skip` falham na
validação. A busca pelo título é literal e não diferencia maiúsculas de minúsculas,
incluindo `%`, `_` e barra invertida. O preço corresponde ao lance atual do leilão
ou ao valor inicial. Os limites são inclusivos e usam strings BIGINT não negativas
canônicas. As ordens aceitas são `price_asc`, `price_desc`, `endsAt_asc` e
`endsAt_desc`; empates usam UUID crescente. A ordem padrão é `createdAt` decrescente
e UUID crescente, incluindo lotes encerrados. A resposta é
`{ auctions, total, limit, skip, asOf }`.

A representação do leilão expõe `currentBidId`; consulte
`GET /auctions/{uuid}/bids` para obter `currentBid`, `endsAt`, status e `asOf`.
O lance mínimo é `startingBidCents` quando não há líder; caso contrário, é o valor
atual mais `minIncrementCents`. O líder não pode dar outro lance. Um lote está
`LIVE` quando `startsAt <=` horário do servidor `< endsAt` e o status é `PUBLISHED`.
Um lance aceito nos dois minutos finais acrescenta dois minutos ao prazo existente.
Considere as respostas do servidor como definitivas, inclusive `endsAt` atualizado;
calcule a contagem regressiva a partir de `asOf` e atualize após conflitos.

Use o cliente Socket.IO v4 com a origem da API e o caminho padrão `/socket.io`:

```js
import { io } from 'socket.io-client';
const api = import.meta.env.VITE_API_URL;
const socket = io(api);
const refresh = () => Promise.all([
  fetch(`${api}/auctions/${auctionId}`).then(r => r.json()),
  fetch(`${api}/auctions/${auctionId}/bids`).then(r => r.json()),
]); // Atualize a interface; busque também a carteira protegida quando houver sessão.
socket.on('connect', () => {
  socket.emit('auction:join', { auctionId }, ack => {
    if (ack.ok) void refresh();
  });
});
for (const name of ['bid:accepted', 'auction:extended', 'auction:ended',
  'auction:settled', 'auction:cancelled', 'auction:integrity-warning']) {
  socket.on(name, () => { void refresh(); });
}
// Ao sair da tela: socket.emit('auction:leave', { auctionId }, ack => {});
// Depois, remova os listeners ou desconecte o socket dessa tela.
```

Defina `api` como a URL base da API e `auctionId` como o UUID do lote atual.
As inscrições são públicas e normalizadas para UUID minúsculo. O servidor usa a sala
`auction:<uuid>`; emita `auction:join` com o objeto acima, sem enviar o nome da sala.
A confirmação é `{ ok: true }` ou `{ ok: false, error: 'INVALID_AUCTION' | 'ROOM_LIMIT' }`.
Cada conexão pode entrar em até 100 salas diferentes; saia das salas sem uso.
A reconexão inicia um novo ciclo de inscrição: entre na sala novamente e busque
os dados REST em cada evento `connect`. Mantenha uma consulta periódica moderada
como alternativa enquanto a tela estiver visível.

Os eventos Socket.IO são avisos públicos emitidos após o commit e incluem `auctionId`.
Não substituem o histórico da carteira nem um comprovante durável. Eventos podem ser
perdidos durante a reconexão e não há adaptador Redis para múltiplas instâncias.
Agrupe atualizações e ignore respostas de buscas antigas que chegarem atrasadas.
Credenciais e dados da carteira devem trafegar apenas pelas rotas HTTP autenticadas.

Quando um lote chega a `FINALIZING`, o worker de liquidação aguarda uma prova de
auditoria verificada independentemente e volta a conferi-la sob bloqueios financeiros.
A ancoragem pendente ou a indisponibilidade do witness podem atrasar o pagamento;
não indique que o vencedor pagou só porque a contagem regressiva terminou. Lotes sem
lances viram `CLOSED_NO_BIDS`; lotes com vencedor viram `SETTLED`. Não existe endpoint
para liquidar manualmente pela API.

`/audit` retorna `VERIFIED`, `PENDING_ANCHOR`, `TAMPERED` ou
`VERIFICATION_UNAVAILABLE` (HTTP 503 quando a verificação está indisponível).
`VERIFIED` significa que a cadeia local e a reprodução do estado operacional
correspondem à última confirmação independente do witness. Pendente não significa
verificado. `/audit/events` usa `after` como cursor exclusivo de sequência e marca
páginas bem-sucedidas como `EVENT_PAGE_ONLY`; receber hashes de uma página não comprova
a verificação pelo witness. Um alerta de adulteração deve abrir um estado de incidente
na interface, nunca acionar estorno ou cancelamento automático pelo vendedor.

A resposta do comprovante contém `{ receipt }`, com snapshot do leilão/produto, valor
canônico, `endsAt`, `settledAt`, `settlementId`, `winningBid` pseudonimizado, `auditUrl`
e `receiptUrl`. Retorna 404 antes da liquidação financeira, inclusive para leilões
encerrados sem lances, e 409 para registros financeiros inconsistentes. Resolva links
relativos usando a origem da API. O comprovante público não revela e-mail, ID do
licitante, IDs de carteira ou token interno do comprovante. Sua existência é distinta
do estado de verificação pelo witness.

O vendedor só pode cancelar lotes `PUBLISHED` ainda não encerrados e sem lances.
Não há opção para desfazer um lance vencedor, fluxo administrativo de cancelamento
com estorno ou cancelamento automático de um incidente `TAMPERED`. O seed opcional
cria um lote inicialmente `LIVE` e depósitos simulados para carteiras sem histórico;
reinicializações preservam datas e saldos existentes. Consulte [`demo-seed.md`](demo-seed.md).
