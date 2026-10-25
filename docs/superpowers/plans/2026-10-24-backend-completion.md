# Plano de conclusão do backend

**Especificação:** pedido atual do usuário e releitura visual das sete páginas de requirements.pdf antes das alterações.
**Objetivo:** concluir o backend existente, incluindo busca/filtros opcionais explícitos, sem frontend ou deploy.
**Arquitetura:** portas/adaptadores existentes e ledger/reservas/auditoria vinculados à transação; polling simples.
**Restrições:** no máximo 500 linhas adicionadas/removidas por commit; sem push, chaves privadas ou segredos reais versionados.

## Rastreabilidade inicial

| PDF | Requisito | Estado/evidência inicial | Ação necessária |
| --- | --- | --- | --- |
| p2,p4 | papéis/autenticação | middleware de autenticação e testes existentes | validar regressões e preservar |
| p2,p4 | snapshots locais de produtos/falha externa | adaptador de catálogo e testes | validar regressões |
| p3,p4 | ciclo de vida/administração de leilões | serviços e testes de leilão | preservar política de cancelamento |
| p4 | lances ao vivo/mínimo/líder/anti-sniping/reservas | serviço de lances e testes de concorrência PostgreSQL | validar em conjunto com a liquidação |
| p4 | liquidação/vencedor/sem lances | somente schema; sem captura | implementar serviço/worker/captura atômicos |
| p2,p3 | comprovante público compartilhável | ausente | implementar representação REST pública persistida |
| p2,p3,p4 | auditoria pública de adulteração/sem PII | witness/outbox implementados | verificação prévia e nova checagem sob bloqueios |
| p3 | atualizações ao vivo | ausentes | Socket.IO de melhor esforço após commit e recuperação via REST |
| p5 | usuários/lote de demonstração | seed apenas de usuários/carteiras | seed de demonstração separado, idempotente e auditado, sem repetição de lances |
| p6 opcional | busca/filtro | apenas ciclo de vida e skip | adicionar filtros/ordenação/paginação PostgreSQL em GET /auctions |
| p6 opcional | cancelamento/estorno | cancelamento somente sem lances; sem papel admin | manter fluxo seguro, rejeitar inconsistências e documentar limites de autoridade |
| p5 | README/instruções de execução | parcialmente atualizados | atualizar matriz, API, OpenAPI e guia de frontend |
| p2,p7 | React/deploy | fora deste repositório/pedido | registrar como pendente, sem deploy |

## Responsáveis e dependências

1. O agente de filtros fica responsável pelos contratos/controller/repositório de leilões e pela seção de documentação e testes de filtros.
2. O agente de captura fica responsável pelo adaptador de reservas da carteira e testes financeiros de captura, reutilizando o contrato existente.
3. O agente de frontend fica responsável por shared/http/cors.ts, realtime/*, integração de opções em app.ts e testes de CORS/socket.
4. O principal fica responsável por contratos/serviço/repositórios/worker/comprovante da liquidação, seed, servidor/composição e migrations.
5. Após a primeira etapa, os agentes testam independentemente concorrência/TOCTOU da liquidação e revisam documentação/requisitos.

Não editar arquivos compartilhados antes da liberação de responsabilidade. Máximo de três agentes além do principal. Testes PostgreSQL usam schemas com UUID.
A ausência local de TEST_DATABASE_URL causou falhas iniciais no banco; usar a URL explícita do banco descartável do Compose.

## Decisões

- Não há papel admin: não autorizar o vendedor a cancelar lance vencedor nem incidente TAMPERED.
- Verificar externamente antes de obter bloqueios financeiros. A prova vincula última sequência/hash, snapshot operacional canônico e identidade observada do vendedor.
- Após bloquear o leilão e aguardar bloqueios financeiros, reler relógio/estado/prova do banco; abortar/adiar se qualquer posição verificada mudou.
- Uma liquidação terminal existente pode ser repetida localmente sem exigir que seu novo evento já esteja ancorado.
- A captura usa a chave chamadora `settlement:<auctionId>` no ledger existente, referenceId=reservationId e lançamentos pareados exatos.
- Notificações públicas via AuctionEventSink (nova porta compartilhada); nunca acessar a rede dentro da transação; envio de melhor esforço, cliente deve buscar os dados REST novamente.
- Socket.IO é necessário: adicionar socket.io para execução e socket.io-client para testes. Sem broker/Redis.
- Preço de busca é o lance atual daquele leilão ou startingBidCents; filtros/contagem/ordem/deslocamento são executados no PostgreSQL.
- Manter skip legado; page baseado em um, rejeitar page+skip explícitos e preservar ordenação padrão.
- Manter o seed de demonstração separado do seed básico para preservar fixtures antigas e carteiras zeradas.

## Lista de execução

- [x] Executar testes unitários/PostgreSQL, lint, typecheck e build de referência; registrar falha de ambiente e execução corrigida.
- [x] Desenvolver filtros, captura e Socket/CORS em paralelo, sempre começando pelos testes.
- [x] Implementar bloqueio por prova verificada, liquidação com captura, encerramento sem lances e testes de concorrência/idempotência/rollback.
- [x] Implementar worker com novas tentativas/espera progressiva, incidentes e encerramento seguro; sem operações externas durante bloqueios.
- [x] Criar comprovante público, validação de consultas e verificações de consistência financeira.
- [x] Tratar motivo/evento de cancelamento seguro e invariantes nos papéis existentes; documentar limites de autorização.
- [x] Criar snapshot/lote de demonstração idempotente e depósitos simulados coerentes sem alterar usuários existentes.
- [x] Configurar workers e CORS/ambiente no Compose; testar lance/liquidação/comprovante/socket de ponta a ponta no Docker.
- [x] Manter/validar OpenAPI, matriz e relatório; executar verificações finais completas e revisão independente.
- [x] Criar commits locais com até 500 linhas, sem push; conferir contagem de linhas preparadas por commit.

Responsáveis finais: após a liberação inicial, o agente de frontend implementou comprovantes,
o agente de filtros implementou o seed e a documentação; o agente de captura adicionou testes adversariais e do worker.
O agente principal integrou o trabalho e um quarto revisor realizou uma revisão final somente de leitura.
Evidências: 94 testes unitários/HTTP/provider aprovados e um ignorado por privilégio do Windows; 195 testes PostgreSQL aprovados;
lint/typecheck/build e liquidação/recuperação real após indisponibilidade no Compose foram aprovados.
