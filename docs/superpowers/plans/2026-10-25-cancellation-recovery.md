# Cancelamento e recuperação financeira

Execução na raiz solicitada, sem commits, push, deploy ou mudanças de tema.
Especificação: requisitos 1–8 do pedido de 25/10/2026.

## Checkpoints e aceite

1. Persistir incidente TAMPERED antes de tentar recuperação. Bloquear novos lances,
   reservas/capturas e settlement sob o mesmo lock de auctions. PENDING_ANCHOR e
   VERIFICATION_UNAVAILABLE não iniciam recuperação. Testar os três estados.
2. Reutilizar releaseReservation, em transação, mantendo ordem auction → wallets
   em UUID → reservas. Persistir prazo-alvo detectedAt + 180 segundos, tentativas,
   próxima tentativa e falhas. Reprocessar no servidor após reinício. Testar
   concorrência, idempotência, rollback parcial e reconciliação de saldo.
3. Registrar cancelamento após liberação confirmada, sem apagar/adicionar eventos
   à cadeia comprometida. Preservar evidências originais em registro de incidente
   separado. CAPTURED/settlement existente mantém registros e exige compensação.
4. Expor recuperação e resultado financeiro no detalhe e auditoria. Não expor
   carteiras ou evidências privadas. Ocultar cancelados da lista pública no SQL,
   mantendo GET por ID e a lista do proprietário. Testar contratos e interface.
5. Rodar testes afetados/integrados, lint, typecheck e build nos dois projetos.

## Arquivos e desenho

- auctions/infrastructure/recovery.schema.ts + migration: incidente persistente,
  evidência imutável de detecção e estado financeiro; não substitui a cadeia audit.
- auctions/services/recovery-service.ts: detecção, transação de liberação e retry.
- audit-verifier/settlement-proof: encaminhar somente TAMPERED à recuperação.
- repositories de auction, bid e settlement: consulta ao bloqueio com lock pai.
- servidor: ciclo persistente de recuperação junto ao worker existente.
- contratos OpenAPI e frontend: motivo, estado, datas e totais agregados confirmados.

O prazo é alvo, não promessa: indisponibilidade ou inconsistência financeira mantém
o saldo comprometido e o incidente pendente. Liberação não depende da integridade
da cadeia adulterada e não a repara. Nenhum estorno de captura será implementado.

## Progresso

- Leitura e checkpoints definidos antes das alterações de produto.
- Checkpoint 1 concluído: incidente persistente, bloqueios sob lock pai, estados não
  confirmados preservados. Inclui corrupção no worker de âncoras e no comprovante.
- Checkpoint 2 concluído: liberação transacional, fila persistente, alvo 180s,
  retentativas e compensação específica para capturas; evidência original preservada.
- Checkpoint 3 concluído depois do backend: contratos e aviso em detalhe, auditoria
  e painel do leiloeiro, sem modificar o dark mode finalizado pelo outro agente.
- Revisão independente corrigiu duas omissões de detecção; segunda revisão sem
  achados importantes. Validação final e manifesto no relatório de implementação.
