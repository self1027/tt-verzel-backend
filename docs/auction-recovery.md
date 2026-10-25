# Cancelamento e recuperação após adulteração

O cancelamento voluntário preserva as regras: proprietário AUCTIONEER, PUBLISHED,
sem lances reais/currentBidId e antes de endsAt, sob lock de auctions. Reservas
ativas aplicáveis são liberadas na mesma transação do cancelamento/auditoria.
Repetição do endpoint continua retornando 409, sem repetir efeitos financeiros.

## Incidente persistente

Somente TAMPERED, produzido pelos verificadores existentes, inicia recuperação.
PENDING_ANCHOR e VERIFICATION_UNAVAILABLE não iniciam cancelamento/liberação.
GET audit, páginas de eventos inválidas, publicação de âncoras e a verificação de
settlement encaminham adulteração confirmada. A detecção ocorre no backend;
consultar o detalhe também consulta a auditoria. Não há varredura contínua de
todos os leilões já ancorados: a garantia começa quando a adulteração é detectada.

`auction_recoveries` é um registro de incidente e uma fila persistente por lote:

- PENDING: bloqueio persistido; a liberação ainda não está confirmada.
- RELEASED: reservas ativas liberadas e CANCELLED gravado na mesma transação.
- COMPENSATION_REQUIRED: existe captura/settlement; registros e estado liquidado
  preservados. Reservas ainda ativas podem ser liberadas, mas captura não é estorno.

O bloqueio usa o mesmo lock pai de lances e settlement. Reserve/capture também
consultam o incidente. Provas obtidas antes do bloqueio não autorizam captura
depois que ele foi persistido. Uma captura que já tenha sido confirmada antes da
detecção exige compensação específica, nunca reversão simplificada.

Primeiro se confirma a transação do incidente; depois ocorre tentativa imediata.
O worker existente de settlement executa recuperação antes de descobrir novos
settlements, inclusive na inicialização. A fila guarda nextAttemptAt e tentativas;
falhas fazem rollback financeiro e persistem nova tentativa para cinco segundos
depois. Instâncias concorrentes são serializadas pelo lock pai. targetAt é
detectedAt + 180 segundos do PostgreSQL. É prazo-alvo, não garantia: indisponibilidade,
inconsistência de carteira, backlog ou locks prolongados podem ultrapassá-lo.
O worker continua tentando depois do alvo; nenhuma liberação é afirmada por timeout.

## Evidências e consulta

Não se apaga, reescreve ou acrescenta evento à cadeia adulterada. O appender
existente continua recusando cadeias inválidas. O incidente guarda a verificação
que o originou, quando legível, e snapshot textual PostgreSQL com produto, lote,
lances, eventos, reservas e settlement, preservando BIGINT e microssegundos.
O SHA-256 do pacote detecta alterações acidentais; um trigger impede edição dos
campos de detecção/evidência pelo fluxo normal. O registro RELEASED e completedAt
documentam o cancelamento por adulteração separadamente da cadeia comprometida.
Esse registro não constitui nova prova independente nem repara a cadeia original;
um administrador irrestrito do banco pode remover triggers/reescrever dados.

GET /auctions/:id e /mine expõem recovery (sem evidências, identidades de carteiras
ou dados privados) e cancellationReason. remainingReservedCents é a soma das
reservas ACTIVE do lote; releasedCents é somente o que essa recuperação confirmou;
capturedCents é a soma das reservas CAPTURED. Esses valores são agregados do lote,
não o saldo pessoal disponível. A carteira continua sendo a referência pessoal.
Listagem pública exclui cancelados e incidentes antes da paginação/contagem;
consulta por ID e lista do proprietário mantêm acesso histórico.

O frontend apenas apresenta consultas ao servidor. O alvo exibido não inicia jobs
ou estornos. Os três estados de integridade continuam distintos. O aviso usa o
tema existente; detalhe, auditoria e painel do proprietário mostram a recuperação.

## Operação e validação

Aplicar a migration `20261025050827_clever_vivisector` antes de iniciar a API
atualizada. Ela foi executada apenas nos bancos/schemas de teste nesta tarefa.
Nenhum deploy ou modificação do banco da aplicação em execução foi realizado.

Testes novos em tests/integration/recovery.test.js cobrem detecção concorrente,
idempotência, preservação de evidências, estados não confirmados, rollback depois
da liberação, reconstrução do serviço, saldo inconsistente, captura direta,
settlement com prova anterior ao bloqueio e cancelamento voluntário. As suítes
existentes foram ajustadas para o novo comportamento de liberação e vitrine.
O pool das fixtures permite 23 concorrentes mais observação de locks; a suíte
completa de integração pode ser executada com `--test-concurrency=1` para limitar
conexões totais no PostgreSQL local.

Compensação de valores capturados exige fluxo específico futuro. Não existe
endpoint de edição/limpeza do incidente nem estorno nesta implementação.
