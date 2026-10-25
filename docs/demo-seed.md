# Seed de demonstração opcional

Execute primeiro o seed básico e depois chame `seedDemonstration(db)` em
`src/shared/database/demo-seed.ts`. O seed básico permanece independente; testes e
instalações que precisam de carteiras zeradas podem continuar usando somente ele.
O seed de demonstração não acessa a rede e não altera senhas.

Na primeira execução, ele cria 24 snapshots locais de produtos e 24 lotes, mantendo
os mesmos três usuários básicos:

| Cenário | Quantidade | Estado inicial |
| --- | ---: | --- |
| Ativos | 14 | `PUBLISHED`, já iniciados, com prazos escalonados |
| Agendados | 4 | `PUBLISHED`, início entre 1 e 4 dias |
| Encerrados legítimos | 3 | `CLOSED_NO_BIDS`, eventos de criação e encerramento coerentes |
| Encerrados adulterados | 3 | `CLOSED_NO_BIDS`, inconsistências deliberadas detectadas pela auditoria |

Os cenários encerrados não possuem lances, vendas, comprovantes ou transferências
financeiras. Datas históricas de criação, início, fim e encerramento seguem ordem
cronológica. Valores iniciais e incrementos mínimos variam no catálogo.

Os três ataques deliberados são aplicados somente ao criar os respectivos lotes,
após registrar um encerramento válido na auditoria:

| Sufixo do UUID do lote | Cenário | Adulteração |
| --- | --- | --- |
| `000000000044` | `tampered-price` | Valor inicial alterado sem evento de auditoria |
| `000000000046` | `tampered-dates` | Prazo alterado sem evento de auditoria |
| `000000000048` | `tampered-event` | Conteúdo do evento de encerramento alterado sem recalcular seu hash |

Os exemplos adulterados devem retornar `TAMPERED`. Os exemplos legítimos permanecem
`PENDING_ANCHOR` até que o witness independente os confirme; o seed não forja
confirmações. Com o witness configurado e disponível, o worker de ancoragem pode
levá-los ao estado `VERIFIED`.

`attributes.demoScenario` identifica o cenário como metadado descritivo. O verificador
detecta as inconsistências reais sem confiar nesse rótulo. Os exemplos adulterados
fazem parte do conjunto de demonstração e não são corrigidos em reexecuções.

O snapshot original é uma lista de campos públicos copiada de
`tests/fixtures/dummyjson/product_1.json`, com origem `dummyjson-demo-fixture`.
Os outros 23 produtos são registros locais de demonstração definidos em
`src/shared/database/demo-products.ts`, com origem `local-demo-catalog`. Incluem
beleza, fragrâncias, móveis e alimentos, com descrições, categorias, SKUs e URLs de
imagem. O seed não consulta a rede; exibir imagens requer acesso ao host remoto.
Não são importados reviews, identidades de avaliadores ou preços externos. A origem
fica registrada em `attributes.demoProvenance`. Os dados estão em `src`, portanto
a imagem Docker compilada não precisa das fixtures de teste.

Os IDs usam o prefixo `d3b80001-34ef-4000-8000-`: sufixos ímpares de snapshot vão
de 1 a 47; sufixos pares de lote vão de 2 a 48, preenchidos até 12 dígitos.
O snapshot (`...000001`) e o lote (`...000002`) originais mantêm seus IDs.

Cada licitante recebe um depósito simulado de 100000 centavos somente se sua carteira
estiver com saldo e reservas zerados, sem lançamentos no ledger nem histórico de
reservas. O `WalletService` cria lançamentos equilibrados com a chave
`deposit:<userId>:demo-bootstrap-v1`. Se houver saldo ou histórico, o crédito é
ignorado; valores gastos não são repostos ao reiniciar. Trata-se de crédito de
simulação, não de integração de pagamentos.

Um bloqueio consultivo transacional serializa execuções simultâneas. Carteiras são
bloqueadas em ordem crescente de UUID antes da criação de lotes; transações do serviço
de carteira usam savepoints dentro da transação externa. Crédito, snapshots, lotes,
adulterações deliberadas e eventos de auditoria são confirmados juntos ou revertidos
juntos.

Reexecuções preservam lotes existentes, datas, estados finais e histórico de auditoria.
Cenários ausentes são acrescentados mesmo quando o lote original já existe, permitindo
atualizar o seed antigo de um único lote sem limpar o banco. Prazos não são estendidos,
lotes não são reabertos e adulterações não são reaplicadas a lotes existentes. Execute
`npm run db:seed` depois das migrations; a inicialização da API pelo Docker já faz isso.
`seed(db, config)`, o seed básico, permanece inalterado.
