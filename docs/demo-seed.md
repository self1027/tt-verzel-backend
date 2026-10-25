# Dados de demonstração

`npm run db:seed` preserva o seed básico e acrescenta seis cenários v3. O básico
continua exportado em `seed.ts` para testes que precisam de carteiras zeradas.
Não há exclusão, reset de senhas, alteração de lotes anteriores ou adulteração no
seed padrão. Produtos locais incluem o exemplo público exigido do DummyJSON;
nenhuma consulta ao catálogo externo é necessária.

## Contas

| E-mail | Papel | Senha padrão no Compose |
| --- | --- | --- |
| auctioneer@verzel.local | Leiloeiro | AuctioneerDemo2026! |
| bidder1@verzel.local | Licitante | BidderOneDemo2026! |
| bidder2@verzel.local | Licitante | BidderTwoDemo2026! |

Fora do Compose, use `SEED_AUCTIONEER_PASSWORD`, `SEED_BIDDER1_PASSWORD` e
`SEED_BIDDER2_PASSWORD` de `.env.example`. Senhas de contas existentes são
preservadas. Cada licitante recebe R$ 1.000,00 simulados somente se a carteira
estiver zerada e sem histórico financeiro/reservas. Dinheiro gasto não é reposto.
Depósitos e lances usam as chaves de idempotência dos serviços existentes.

## Cenários

| Identificação na interface | Comportamento na primeira execução |
| --- | --- |
| lote agendado | SCHEDULED, início em 24 horas |
| disputa aberta | LIVE após aguardar início real; duração de 24 horas |
| disputa com lances | LIVE; lance real de R$ 50,00 de bidder1 e reserva ativa |
| liquidação automática | Lance real de R$ 50,00 de bidder2; prazo de 150 segundos e posterior SETTLED |
| encerramento sem lances | Prazo real curto; CLOSED_NO_BIDS após verificação independente |
| cancelamento voluntário | CANCELLED pelo serviço do proprietário, sem lances |

O identificador descreve a finalidade da demonstração, não afirma um estado
financeiro. O status exibido e os comprovantes vêm do backend. Cancelados estão
fora da vitrine; use o link impresso pelo seed ou o painel do leiloeiro.

## Execução

```sh
npm run db:migrate
npm run db:seed
# Com witness independente configurado e publicável:
npm run db:seed -- --wait-for-settlement
# Dentro do Compose já em execução:
docker compose exec api npm run db:seed -- --wait-for-settlement
```

A opção de espera pode levar cerca de dois minutos e meio na primeira execução.
Ela aguarda o relógio real do PostgreSQL; não injeta datas históricas ou provas
fabricadas. O prazo evita a extensão anti-sniping normal de dois minutos. Sem a
opção, o seed retorna rapidamente; o worker liquida depois, ou uma reexecução do
seed pode concluir o lote vencido. Reexecutar não renova prazos de lotes antigos.

O Compose configura o witness. Fora dele, configure `AUDIT_WITNESS_*` conforme
[auditoria](audit-infrastructure.md). Somente cabeças íntegras dos seis lotes v3
são publicadas, pelo provedor existente. O seed não publica eventos de terceiros.
Sem witness/prova disponível, o lote permanece LIVE ou FINALIZING conforme o
relógio; o resumo informa `INDEPENDENT_WITNESS_REQUIRED` ou pendência. Não é gravado
SETTLED/CLOSED_NO_BIDS artificialmente. O seed não sobrepõe saldo ou histórico
inconsistente e não deposita mais dinheiro para forçar um lance.

Snapshots fixos `d3b80003-34ef-4000-8000-000000000001` a `...000006` identificam a
versão atual; UUIDs dos leilões são produzidos pelo serviço e impressos no resumo.
Um lock transacional serializa somente a criação. Reexecuções, inclusive
concorrentes, reutilizam os mesmos lotes e operações financeiras. Progresso parcial
é persistido e pode ser retomado. Lotes/snapshots antigos, inclusive demonstrações
adulteradas de versões anteriores, não são apagados ou reparados por este seed.

## Adulteração e recuperação opcionais, isoladas

PowerShell, usando o banco de testes local (nunca `DATABASE_URL` como fallback):

```powershell
$env:NODE_ENV = 'test'
$env:TEST_DATABASE_URL = 'postgresql://verzel:verzel_dev@localhost:5432/verzel_auction_test'
npm run demo:recovery:isolated
```

O comando recusa produção, hosts remotos e nomes de banco sem test/demo/sandbox.
Cria e migra um schema UUID novo, cria os dados pelos serviços, adultera apenas o
hash de um evento desse schema e executa verificação/recuperação reais. Confirma
TAMPERED, RELEASED e CANCELLED, exibindo reservado/liberado/capturado. Não consulta
nem publica no witness compartilhado e não usa sua configuração. A prova deste
ataque é o hash local inválido; não se afirma ancoragem externa.

O cenário é efêmero: remove somente o schema que acabou de criar. Dados existentes
permanecem intactos. O resultado fica no terminal, não na interface compartilhada.
Para persistência/consulta histórica na aplicação, use os fluxos normais; não
injete adulterações no banco compartilhado. Veja [garantias de recuperação](auction-recovery.md).

## Testes

```powershell
$env:TEST_DATABASE_URL = 'postgresql://verzel:verzel_dev@localhost:5432/verzel_auction_test'
node --import tsx --test tests/integration/seed.test.js tests/integration/demo-scenarios.test.js tests/demo-recovery.test.js
# Teste opt-in de liquidação: witness assinado efêmero + espera real de 150 segundos:
$env:DEMO_TEST_SETTLEMENT_WAIT = '1'
node --import tsx --test tests/integration/demo-scenarios.test.js
```
