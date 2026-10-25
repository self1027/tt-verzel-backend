# Busca e filtros de leilões

`GET /auctions` é público. `GET /auctions/mine` aceita os mesmos parâmetros e
exige autenticação como `AUCTIONEER`; os resultados sempre pertencem a esse usuário.
A busca usa snapshots de produtos armazenados e não consulta o catálogo externo.

| Parâmetro | Significado |
| --- | --- |
| `q` | Trecho literal, sem distinção entre maiúsculas e minúsculas, do título do snapshot local. `%`, `_` e barra invertida são caracteres comuns. Texto vazio corresponde a todos os títulos. |
| `lifecycleState` | `SCHEDULED`, `LIVE`, `FINALIZING`, `CANCELLED`, `SETTLED` ou `CLOSED_NO_BIDS`. |
| `minPriceCents`, `maxPriceCents` | Limites inclusivos de preço atual, em strings decimais canônicas entre `0` e `9223372036854775807`. O mínimo não pode superar o máximo. |
| `sort` | `price_asc`, `price_desc`, `endsAt_asc` ou `endsAt_desc`; empates são resolvidos pelo UUID do leilão em ordem crescente. |
| `limit` | Tamanho da página entre 1 e 100; padrão 30. |
| `skip` | Deslocamento legado baseado em zero, entre 0 e 2147483647; padrão 0. |
| `page` | Página opcional baseada em um; o deslocamento é `(page - 1) * limit` e não pode superar 2147483647. Não pode ser usado com `skip`, nem mesmo `skip=0`. |

O preço atual é o valor do lance atual do próprio leilão ou, quando ele não existe,
o valor inicial. Um lance de outro leilão não altera o preço. Comparações e
ordenação são executadas no PostgreSQL com precisão BIGINT; clientes não devem
converter strings de centavos em `Number` do JavaScript. A resposta não inclui
um campo separado para o preço atual.

Exemplo:

```text
GET /auctions?q=phone&lifecycleState=LIVE&minPriceCents=10000&maxPriceCents=100000&sort=price_asc&limit=10&page=2
```

Os filtros são combinados com AND antes da paginação e da contagem. `total`
representa todas as linhas correspondentes. Linhas e total compartilham uma
transação somente de leitura em REPEATABLE READ e o mesmo `asOf` do banco para
avaliar o ciclo de vida.

A resposta mantém `{ auctions, total, limit, skip, asOf }`; `page` é convertido
em `skip` e não aparece na resposta. Sem ordenação explícita, a ordem é
`createdAt DESC, id ASC`. Sem filtro de ciclo de vida, os leilões encerrados também
são incluídos. Parâmetros desconhecidos ou repetidos, enums inválidos, valores
malformados, limites invertidos e deslocamentos fora do intervalo retornam HTTP 400
no formato de erro de validação existente.
