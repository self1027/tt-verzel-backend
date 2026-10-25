# Matriz de rastreabilidade dos requisitos

> Registro histórico do backend. A avaliação atual de frontend e backend, os
> comandos reproduzíveis e as limitações estão no [guia unificado do recrutador](guia-recrutador.md).

Fonte: `requirements.pdf`, sete páginas revisadas visualmente durante o trabalho.
Esta matriz cobre o backend. Frontend e deploy estão fora do escopo deste repositório.
Os caminhos apontam para implementação e testes executáveis; a mera existência de um
arquivo não é apresentada como prova de atendimento ao requisito.

| Item do PDF | Estado inicial do backend | Estado final | Evidências de implementação e verificação |
| --- | --- | --- | --- |
| p1: contexto do desafio técnico | Backend TypeScript existente | Escopo do backend mantido | `src/server.ts`; `package.json`; exclusões de frontend/deploy abaixo |
| p2, p4: autenticação e papéis | Implementados | Completo: `AUCTIONEER`/`BIDDER` do seed, JWT e autorização no servidor | `src/modules/auth/`; `tests/integration/auth.test.js` |
| p2, p4: catálogo e snapshots locais importados | Implementados | Completo: lista permitida de campos; consulta de lotes importados sem rede externa | `src/modules/catalog/`; `tests/integration/catalog.test.js`; `tests/integration/auctions.test.js` |
| p3, p4: ciclo de vida e gestão dos leilões | Implementados | Completo nos dois papéis definidos: proprietário cria/edita, cancelamento seguro sem lances e ciclo público | `src/modules/auctions/`; `tests/integration/auctions.test.js`; `tests/integration/auctions-concurrency.test.js` |
| p4: lances, incremento mínimo e líder | Implementados | Completo: relógio validado do banco e histórico íntegro; líder atual não pode dar novo lance | `src/modules/bids/domain/bid-rules.ts`; `tests/integration/bids-flow.test.js`; `tests/integration/bids-concurrency.test.js` |
| p4: extensão anti-sniping | Implementada | Completo: lance aceito com tempo restante em `(0,120s]` estende o prazo atual em 120s | `src/modules/bids/domain/bid-rules.ts`; `tests/integration/bids-flow.test.js`; `tests/integration/bid-idempotency.test.js` |
| p4: reservas e liberação do líder superado | Implementadas | Completo: reserva transacional; saldo disponível exclui os valores reservados | `src/modules/wallets/`; `tests/integration/reservations.test.js`; `tests/integration/bids-concurrency.test.js` |
| p4: liquidação do vencedor e encerramento sem lances | Somente schema | Implementado: worker automático; revalidação da prova sob bloqueios; captura, ledger, estado e auditoria atômicos; novas tentativas com espera progressiva | `src/modules/settlements/services/settlement-service.ts`; `src/modules/settlements/workers/settlement-worker.ts`; `tests/integration/settlements.test.js`; `tests/integration/settlement-concurrency.test.js`; `tests/integration/reservation-capture.test.js` |
| p2, p3: comprovante público compartilhável | Ausente | Implementado: consistência financeira persistida; vencedor pseudonimizado; URL REST pública | `src/modules/settlements/services/receipt-service.ts`; `tests/integration/receipts.test.js` |
| p2, p3, p4: evidências públicas de adulteração sem PII | Implementadas | Estendidas: witness independente e reprodução completa do estado operacional; liquidação adiada sem prova verificada; `TAMPERED` informado sem ações financeiras automáticas inseguras | `src/modules/audit/`; `src/modules/settlements/infrastructure/settlement-proof.ts`; `tests/integration/audit-adversarial.test.js`; `tests/integration/audit-public.test.js`; `tests/integration/settlement-concurrency.test.js` |
| p3: atualizações em tempo real | Ausentes | Implementadas: seis avisos públicos Socket.IO após commit, isolamento de salas e recuperação via REST | `src/modules/realtime/auction-sockets.ts`; `src/shared/events/auction-events.ts`; `tests/realtime.test.js`; `tests/integration/notifications.test.js` |
| p5: usuários de demonstração e lote disponível | Apenas usuários e carteiras vazias | Implementado: snapshot offline opcional, lote auditado inicialmente ativo e depósitos simulados idempotentes para carteiras sem histórico; reexecuções preservam histórico e datas | `src/shared/database/demo-seed.ts`; `src/shared/database/demo-product.ts`; `tests/integration/demo-seed.test.js`; `docs/demo-seed.md` |
| p6 opcional: busca e filtros | Apenas ciclo de vida e `skip` | Completo: busca SQL por título, faixa de preço atual, quatro ordenações, `page`/`skip` legado e total consistente | `src/modules/auctions/controllers/auction-controller.ts`; `src/modules/auctions/repositories/drizzle-auction-repository.ts`; `tests/auction-filters.test.js`; `tests/integration/auction-filters.test.js`; `docs/auction-filters.md` |
| p6 opcional: cancelamento com estorno administrativo | Vendedor cancela apenas lotes sem lances; sem papel admin | Parcial: cancelamento seguro sem lances mantido; lotes com lances não podem ser cancelados; vendedor não pode desfazer resultado nem liberar reserva em cancelamento por incidente | `src/modules/auctions/services/auction-service.ts`; `tests/integration/auctions.test.js`; modelo de dois papéis em `src/modules/users/contracts/user-reader.ts` |
| p5: inicialização e documentação da API | Parcial | Atualizadas: especificação OpenAPI, integração frontend, instruções do seed e rastreabilidade | `docs/openapi.yaml`; `tests/openapi.test.js`; `docs/frontend-integration.md`; README |
| p2, p7: frontend React e deploy/entrega | Fora do backend | Pendente/fora do escopo: não há aplicação React nem frontend/backend hospedados | Orientações em `docs/frontend-integration.md`; relatório principal registra verificações e escopo |

Cancelar leilões com lances exige um modelo de administrador autorizado e uma política
auditável para reservas, efeitos no ledger, incidentes e estados finais. O papel de
vendedor atual não concede essa autoridade. `TAMPERED` bloqueia uma liquidação insegura,
mas não aciona cancelamento ou estorno automático.

A entrega em tempo real é de melhor esforço em um único processo, sem fila durável nem
adaptador Redis. Clientes devem entrar novamente nas salas e sincronizar os dados via
REST. A existência de comprovante indica liquidação financeira persistida; a verificação
independente da auditoria é um estado separado e ainda pode estar pendente ou indisponível.

O relatório principal registra os resultados finais dos comandos e as limitações
remanescentes. Esta matriz não fixa contagens de testes que podem mudar.
