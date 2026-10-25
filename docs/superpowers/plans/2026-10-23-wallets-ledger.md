# Plano de implementação de carteiras e ledger

> Executar diretamente com TDD e preservar a arquitetura modular existente.

**Objetivo:** depósitos simulados, histórico da própria carteira, conciliação e contratos para reservas futuras.

**Arquitetura:** controller/service/repository de carteira; adaptador do ledger vinculado à transação Drizzle chamadora. As restrições únicas existentes para carteira/conta/chave são suficientes. Sem mudança de schema ou novas dependências.

**Restrições:** valores monetários como strings na API, aritmética bigint, identidade autenticada, depósitos exclusivos de BIDDER, ledger somente de acréscimo e bloqueios PostgreSQL; sem implementar lances ou liquidação.

## Tarefas

- [x] Escrever testes financeiros de integração e confirmar a falha das rotas de carteira ausentes (404 em vez de 401).
- [x] Definir contratos de carteira, ledger e reserva vinculada à transação antes das classes.
- [x] Implementar provisionamento atômico, bloqueio de carteira, idempotência persistente com escopo e lançamentos equilibrados no ledger.
- [x] Adicionar rotas HTTP autenticadas, histórico e conciliação interna.
- [x] Testar limites, tentativas simultâneas, depósitos independentes, rollback, isolamento e saldos corrompidos em PostgreSQL real.
- [x] Documentar ordem dos bloqueios, comprovantes, pré e pós-condições de reservas e trabalho da próxima etapa.
- [x] Executar npm test (24), npm run test:db (65), lint, typecheck e build; todos terminaram com código 0. Revisão independente e somente de leitura não encontrou defeitos que exigissem ação.

## Pontos de revisão

Uma repetição após depósitos posteriores deve retornar o comprovante original; detectar estouro antes de gravar; contas ausentes em carteiras financiadas não podem ocultar perda contábil; a conciliação deve usar snapshot consistente; rejeitar headers duplicados e campos extras.

## Decisões

- O comprovante contém transactionId, amountCents e createdAt; nunca um saldo que muda.
- Armazenar `deposit:<UUID autenticado>:<chave do cliente>` na chave única de idempotência existente, o ID da carteira em referenceId e o valor nos lançamentos do ledger.
- Exigir a conta de compensação criada pelo seed; não criar contas alternativas durante requisições.
- Reserva/liberação/captura ficam como contratos para a próxima etapa; esta fase não tem fluxo executável de reserva ou liquidação.
- Bloqueios futuros: primeiro a linha do leilão, depois carteiras em ordem de UUID, linhas de reserva e, por fim, gravações no ledger. Depósitos bloqueiam somente sua carteira.
