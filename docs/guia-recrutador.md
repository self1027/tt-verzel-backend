# Guia do recrutador: requisitos, demonstração e testes

Este guia reúne frontend e backend da Verzel Auction House. A referência é o
[requirements.pdf](../requirements.pdf), com sete páginas. Os códigos R01–R17 e
O01–O05 abaixo foram criados para facilitar a avaliação; o PDF não numera cada regra.

A proposta é simples: você pode percorrer a aplicação, repetir uma jornada com
dois licitantes ou conferir as regras mais delicadas em testes isolados de banco.
Cada verificação abaixo diz o que observar e resume como a funcionalidade funciona.

## Comece por aqui

O projeto tem dois repositórios independentes:

- [Backend — tt-verzel-backend](https://github.com/self1027/tt-verzel-backend).
- [Frontend — tt-verzel-frontend](https://github.com/self1027/tt-verzel-frontend).

Este guia unificado é mantido no repositório do backend e referenciado pelo README
do frontend. Os repositórios podem ser clonados em quaisquer diretórios; não há
dependência de uma pasta pai compartilhada. Os serviços se comunicam por HTTP e
Socket.IO, pelos endereços configurados.

Com Node.js 22.12+ e Docker Compose, em um terminal para o backend:

```sh
git clone https://github.com/self1027/tt-verzel-backend.git
cd tt-verzel-backend
npm ci
docker compose up -d --build
```

Em outro terminal, no diretório que preferir para o frontend:

```sh
git clone https://github.com/self1027/tt-verzel-frontend.git
cd tt-verzel-frontend
npm ci
npm run dev
```

Abra [a aplicação](http://localhost:5173) e, se desejar explorar diretamente as
requisições, [o Swagger](http://localhost:3000/docs/).
O endereço padrão da API é `http://localhost:3000`; pode ser configurado com
`VITE_API_BASE_URL` em `.env.local` no frontend. O backend precisa permitir essa
origem em `CORS_ORIGINS`. Não existe endpoint `/health`; use `GET /auctions?limit=1`.

| Conta de demonstração | Senha padrão | O que testar |
| --- | --- | --- |
| `auctioneer@verzel.local` | `AuctioneerDemo2026!` | Buscar/importar produto, publicar, editar e cancelar lote sem lances, ver resultados. |
| `bidder1@verzel.local` | `BidderOneDemo2026!` | Depositar, dar o primeiro lance e acompanhar sua posição. |
| `bidder2@verzel.local` | `BidderTwoDemo2026!` | Superar o primeiro licitante e acompanhar o arremate. |

São credenciais públicas de demonstração. Se as senhas foram personalizadas,
configure `SEED_AUCTIONEER_PASSWORD`, `SEED_BIDDER1_PASSWORD` e
`SEED_BIDDER2_PASSWORD` também no terminal dos testes de frontend.

O seed prepara seis cenários: agendado, aberto, aberto com lance, liquidação,
encerramento sem lances e cancelado. Cada licitante recebe R$ 1.000,00 simulados
na carteira inicial sem histórico. O seed preserva os dados quando é reexecutado:
não repõe dinheiro gasto nem reabre lotes vencidos. Para conhecer seus links ou
aguardar os cenários curtos, execute no backend já iniciado:

```sh
docker compose exec api npm run db:seed -- --wait-for-settlement
```

Na primeira execução, essa espera leva aproximadamente 150 segundos. O witness
deve estar disponível. Consulte [o seed](demo-seed.md) se o ambiente já tiver
dias de uso e todos os lotes ativos tiverem vencido.

## Três comandos de avaliação

| Comando | Onde executar | O que verifica | Tempo aproximado |
| --- | --- | --- | --- |
| `npm run test:recruiter:mcp` | frontend | Varredura pública com o **Playwright MCP da Microsoft**: vitrine, login, sala, auditoria, comprovante disponível e largura de 375px. | 10s |
| `npm run test:recruiter` | frontend | Três jornadas com API real: filtros/temas/mobile; busca e importação externa + gestão pela UI; disputa entre dois usuários até a liquidação. | 3min |
| `npm run test:requirements` | backend | Suíte de integração PostgreSQL em série: autorização, catálogo, lances, concorrência, carteiras, liquidação, privacidade, adulteração e recuperação. | 1–2min |

O frontend e a API precisam estar em execução para os dois primeiros comandos.
Instale Microsoft Edge ou configure `PLAYWRIGHT_CHANNEL` e, se necessário,
`PLAYWRIGHT_EXECUTABLE_PATH` com o executável do navegador instalado.
A jornada real usa o relógio e o worker da aplicação: a espera pelo encerramento
é intencional. Não há respostas REST simuladas nessas três jornadas de frontend.
A busca/importação de um produto novo exige acesso do backend ao DummyJSON.

**Efeito da jornada real:** cria lotes próprios, cancela os que não recebem lances,
deposita R$ 10,00 simulados em cada licitante e liquida um arremate de R$ 1,10.
Esses registros permanecem para inspeção; não há reset do seed nem exclusão do histórico.
Se a execução falhar após um lance, o lote e sua reserva seguem o ciclo normal do
worker. Repetir a execução cria outra demonstração com outros identificadores.
Use as contas de demonstração sem interagir em paralelo durante a medição dos saldos.

Para o backend, configure um **banco de testes**, com permissão de criar schemas.
O Compose cria `verzel_auction_test` na primeira inicialização do volume:

```powershell
# Terminal na raiz do repositório do backend
$env:TEST_DATABASE_URL='postgresql://verzel:verzel_dev@localhost:5432/verzel_auction_test'
npm run test:requirements
# Atalhos para a avaliação focada:
npm run test:requirements:rules
npm run test:requirements:audit
```

Os helpers criam schemas aleatórios, aplicam as migrations e removem esses schemas
ao finalizar. Os ataques de adulteração acontecem somente nessas fixtures.
Nenhum desses testes precisa adulterar o banco da demonstração. Para executar
também o teste lento opcional do seed, no mesmo terminal do backend:

```powershell
$env:DEMO_TEST_SETTLEMENT_WAIT='1'
node --import tsx --test --test-name-pattern='settled and closed scenarios' tests/integration/demo-scenarios.test.js
Remove-Item Env:DEMO_TEST_SETTLEMENT_WAIT
```

Esse cenário leva mais 150 segundos e usa uma testemunha assinada isolada.

O Playwright abre um relatório legível com cada etapa e os identificadores dos
lotes em anexos sem credenciais:

```sh
# Terminal na raiz do repositório do frontend
npm run test:recruiter:report
```

O relatório fica em `playwright-report/recruiter/`; o MCP grava `report.json`,
snapshots de acessibilidade, console, rede e captura mobile em
`test-results/recruiter-mcp/`. Esses diretórios são ignorados pelo Git.
O preenchimento da senha não inclui seu valor nos títulos dos passos; traces
foram desativados para evitar a gravação das requisições de autenticação.
As senhas públicas padrão continuam documentadas no código e nos READMEs.
Os testes antigos de `npm run test:e2e` continuam separados e usam APIs simuladas.

Para endereços locais diferentes, configure `RECRUITER_FRONTEND_URL` e
`RECRUITER_API_URL`; o endereço da API usado pelo Vite deve ser o mesmo.

## Matriz de requisitos

“Validado” significa que houve uma verificação executada nesta curadoria. Quando
um teste usa uma fixture de serviço ou uma falha provocada em schema isolado,
isso é indicado; não se afirma que foi provocado um incidente no ambiente principal.

| ID e página do PDF | Como avaliar / resultado esperado | Como foi implementado e evidência |
| --- | --- | --- |
| **R01 · p2/p5 — dois papéis e autenticação** | Entre com cada conta. O vendedor vê seu painel; licitantes veem carteira e arremates. Requisições privadas sem sessão retornam 401; licitante criando lote ou vendedor dando lance recebe 403. | JWT, senha Argon2 e autorização no servidor, além das rotas por papel no React. Validado pela jornada real e `tests/integration/auth.test.js`. |
| **R02 · p2/p4 — produto de API pública e resiliência** | No painel, escolha “Buscar na API externa”, pesquise `phone`, importe um resultado. Consulte “Produtos importados”. Lotes já publicados, auditoria e comprovantes devem continuar consultáveis sem buscar o produto novamente. | DummyJSON fornece o catálogo; a importação guarda um snapshot local imutável. Busca/importação reais passaram pela UI; indisponibilidade, timeout e preservação do snapshot são exercitados em `catalog.test.js` e `auctions.test.js`, com provedor controlado. Imagens remotas continuam dependentes do CDN. |
| **R03 · p2/p3 — painel do leiloeiro** | Selecione produto, informe lance inicial, incremento, início/fim futuros e publique. Antes de iniciar, edite. Sem lances, cancele; o lote sai da vitrine. Outro usuário não pode gerenciá-lo. | Formulário React e validações de propriedade, datas e ausência de lances no serviço. Jornada real publica, edita e cancela via UI; `auctions.test.js` cobre também acessos e transições recusadas. |
| **R04 · p3 — vitrine por situação** | Alterne Ao vivo, Agendados, Em encerramento, Finalizados e Encerrados sem lances. Confira que um lote cancelado não aparece e que o detalhe público continua acessível por link. | O backend calcula o ciclo com o relógio do banco e filtra os estados; a vitrine consulta esses filtros. MCP + jornada real e `auction-filters.test.js`. |
| **R05 · p3 — meus arremates e resultados do vendedor** | Após a disputa, abra Meus arremates no vencedor e veja o link do comprovante. No vendedor, confira o lote e o total recebido em liquidações. | Consultas privadas de lances e extrato, com comprovante para lotes liquidados. Jornada real; testes de `receipts.test.js` e `settlements.test.js`. |
| **R06 · p2/p3 — carteira e depósito simulado** | Deposite R$ 10,00. O total aumenta exatamente esse valor e o extrato registra o depósito. Compare total, reservado e disponível antes/depois de liderar. | Ledger em centavos inteiros, carteira transacional e chaves de idempotência. Depósitos pela UI real; `wallets.test.js`, `reservations.test.js` e `bid-idempotency.test.js`. |
| **R07 · p4 — regras de lance** | Primeiro lance ≥ inicial; seguinte ≥ atual + incremento. Recuse valor abaixo do mínimo, líder cobrindo a si mesmo, falta de saldo, lote agendado, encerrado ou cancelado. | O serviço decide dentro da transação, com locks e horário do banco. A jornada real cobre os principais erros; `bids-flow.test.js` e `bids-concurrency.test.js` cobrem fronteiras de horário e disputas simultâneas. |
| **R08 · p3 — feedback de recusas** | Informe R$ 0,99 num lote de R$ 1,00: aparece orientação sobre o mínimo. Falta de saldo é explicada; para o líder ou lote fechado, a interface informa sua posição e bloqueia novo envio. | Validação local e tradução dos códigos da API. Jornada real valida o aviso de mínimo e as recusas da API; `e2e/bidding.spec.ts` cobre mensagens simuladas e componentes. Algumas recusas são prevenidas pelo formulário desabilitado. |
| **R09 · p4 — comprometimento/liberação** | Em duas janelas independentes, primeiro licitante dá R$ 1,00 e o segundo R$ 1,10. A reserva do primeiro é liberada; só o líder fica com R$ 1,10 reservado. Total não muda só por dar lance. | Reserva, troca de líder e liberação fazem parte da mesma transação. Conferido na API real após cliques dos dois usuários; testes de reservas e concorrência verificam os saldos e rollback. |
| **R10 · p4 — anti-sniping** | Um lance aceito com até 120s restantes acrescenta 120s ao prazo vigente. Compare `endsAt` antes/depois, inclusive no detalhe sem recarga. Uma recusa não prorroga o lote. | A regra atualiza o prazo na transação do lance. A jornada real compara a diferença exata de 120000ms; `bids-flow.test.js` cobre 120000/120001ms, recusas e reenvios. |
| **R11 · p4 — liquidação e fechamento sem vencedor** | Aguarde o lote curto: vencedor perde R$ 1,10, vendedor recebe R$ 1,10, reserva é capturada e surge comprovante. Sem lances, encerra sem vencedor e sem transferência. | Worker automático, ledger e captura atômicos, com proteção a tentativas repetidas e prova de integridade. Transferência real pela jornada; `settlements.test.js`, `settlement-concurrency.test.js` e `reservation-capture.test.js` exercitam também fechamento sem lances e múltiplos workers. |
| **R12 · p2/p3/p4 — histórico e detecção de adulteração** | Abra Auditoria pública sem login. Deve mostrar histórico e estado explícito. Execute `test:requirements:audit` para alteração, exclusão e inserção posterior: espera-se `TAMPERED`, sem confiar nos dados adulterados. | Eventos encadeados por hash e compromissos do lote/lances são comparados a checkpoints assinados por witness independente. `audit-adversarial.test.js` e `cryptographic-binding.test.js` atacam o histórico, vendedor e produto em schemas isolados. A UI foi validada com estado verificado real. |
| **R13 · p2/p3/p4 — comprovante compartilhável e privacidade** | Abra `/auctions/:id/receipt` em janela anônima. Há produto, valor, referência pseudônima do vencedor e link para auditoria; nenhum e-mail, senha ou nome privado do licitante. | Endpoint público e serialização permitida de campos, com pseudônimo do participante. Jornada real verifica comprovante e ausência de campos privados nas respostas públicas; `audit-public.test.js` e `receipts.test.js`. |
| **R14 · p3 — sala e atualizações sem recarregar** | Mantenha os dois licitantes na sala. Ao superar, a primeira tela mostra “Você foi superado”; a segunda mostra “Você está ganhando”. Há valor, histórico e contagem regressiva. | Eventos Socket.IO após commit invalidam consultas REST; atualização periódica e reconexão recompõem o estado. A mudança real sem reload passou; `notifications.test.js` prova eventos após commit e ausência de eventos em rollback. A atualização visual sozinha também pode vir do polling. |
| **R15 · p5 — dados de teste prontos** | Acesse as três contas e identifique cenários ativos/agendados/encerrados. Reexecute o seed e confira preservação do histórico. | Seed idempotente cria usuários, snapshots, saldos simulados e cenários pelos serviços existentes. `seed.test.js` e `demo-scenarios.test.js`. O horário avança normalmente; dados antigos não são reabertos. |
| **R16 · p5 — tecnologias e documentação** | Confira os READMEs, contratos e os comandos acima. React no frontend, Node.js no backend e PostgreSQL persistente. | React/Vite/TypeScript, Express/Drizzle/PostgreSQL. `lint`, `typecheck`, testes e build foram executados; as particularidades deste ambiente estão nas evidências. |
| **R17 · p2/p5/p7 — deploy, prazo e envio** | A entrega exige URL pública, repositório(s), contato e relato de uso de IA. Prazo: sete dias do recebimento. | **Não certificado por uma execução local.** Esta curadoria não publica a aplicação, não envia formulário e não permite confirmar a data de recebimento. Complete esses dados antes da entrega. |

Os testes backend citados sem caminho estão em [tests/integration/](../tests/integration/).
No repositório do frontend, consulte a
[jornada real](https://github.com/self1027/tt-verzel-frontend/blob/main/e2e-live/requirements.spec.ts)
e a [varredura MCP](https://github.com/self1027/tt-verzel-frontend/blob/main/scripts/recruiter-mcp.mjs).

## Roteiro manual sugerido

1. Sem login, percorra a vitrine, abra um lote e sua auditoria. Abra um lote já
   finalizado e seu comprovante em uma janela anônima.
2. Entre como vendedor. Pesquise `phone` na API externa ou escolha um produto
   já importado. Publique um lote de R$ 1,00, incremento R$ 0,10, com início
   futuro. Edite antes do início. Cancele um lote sem lances e confirme sua saída da vitrine.
3. Crie outro lote para a disputa. Use dois perfis de navegador ou uma janela
   normal e uma anônima, com um licitante em cada. Deposite saldo simulado.
4. Dê R$ 1,00 como primeiro licitante. Confira “Você está ganhando” e o reservado.
   Como segundo, dê R$ 1,10. Sem atualizar a primeira página, confira
   “Você foi superado” e a liberação da reserva anterior.
5. Para anti-sniping, dê um lance nos últimos dois minutos e compare o prazo.
   Não continue dando lances se quiser observar o encerramento: cada nova
   aceitação nessa janela pode acrescentar mais dois minutos.
6. Aguarde a liquidação. Confira carteiras, extratos, Meus arremates, total
   recebido no painel e link público do comprovante. O formulário usa horário
   local; os dados da API usam UTC.
7. Execute os testes de auditoria para ver adulteração e recuperação financeira.
   Não é necessário editar SQL no ambiente da demonstração.

## Opcionais do PDF, p6

| ID | Situação e teste |
| --- | --- |
| **O01 — busca e filtros** | Implementado: título, situação, valores, ordenação e paginação. Jornada real valida filtros por estado, busca vazia e resposta filtrada; `auction-filters.test.js` cobre faixas, ordenação e paginação. |
| **O02 — cancelamento com estorno automático** | **Parcial.** Cancelamento voluntário só é permitido sem lances. Adulteração confirmada abre recuperação persistente, bloqueia lances e libera reservas ainda não capturadas. Depois da captura, marca necessidade de compensação; não faz estorno genérico. `recovery.test.js` valida o comportamento. Não há papel administrador para cancelamento com estorno arbitrário. |
| **O03 — Docker Compose** | Configuração de PostgreSQL, API e witness presente em `compose.yaml`, com migrations/seed. Os serviços locais estavam disponíveis; o comando de inicialização não foi reexecutado nesta curadoria porque o sandbox não tem acesso ao daemon Docker. |
| **O04 — testes automatizados** | Comandos de integração, unitários, componentes, navegador com API simulada e jornadas com API real. Não se misturam as evidências dessas camadas. |
| **O05 — dark mode** | Botão “Tema escuro”, tema claro/escuro e preferência persistida. Alternância, recarga e largura mobile passaram na jornada real; `e2e/theme.spec.ts` amplia a cobertura com respostas simuladas. |

## Comportamentos importantes para a avaliação

- A sessão fica em memória. Recarregar, abrir uma nova aba ou colar um link exige
  novo login para operações privadas; navegue pelos links do app após entrar.
  Auditoria, vitrine e comprovante continuam públicos.
- `VERIFIED`, `PENDING_ANCHOR`, `VERIFICATION_UNAVAILABLE` e `TAMPERED` são estados
  diferentes. Falta de rede/witness não deve ser apresentada como adulteração nem
  como confirmação de integridade. Sem prova independente, a liquidação pode
  permanecer em processamento (`FINALIZING`).
- Um hash encadeado sozinho não impede reescrever toda a base. A referência
  independente detecta divergências do histórico já ancorado. Um sufixo ainda
  não ancorado tem cobertura limitada e não é apresentado como verificado.
- O snapshot local preserva os dados do produto quando a API externa cai.
  As imagens ainda usam URLs remotas e podem ficar indisponíveis; isso não deve
  impedir leitura de informações, participação ou consulta dos comprovantes.
- A busca externa usa termos em inglês. Valores monetários são strings de centavos
  na API e reais no formulário. Lances e depósitos repetidos usam idempotência.
- Lotes antigos de auditoria v1 têm cobertura limitada; novos lotes usam v2.
  Veja [as garantias e limitações](cryptographic-binding-v2.md).
- Nota fiscal, revenda, app nativo e recuperação de senha estão dispensados no PDF.
  Não há cadastro; a avaliação usa os usuários do seed.

## Evidência desta curadoria

Execução local em **25/10/2026**, frontend `localhost:5173`, API `localhost:3000`,
Edge headless e PostgreSQL em banco de testes separado. O PDF da raiz e a cópia do
backend têm o mesmo SHA-256, conferido antes da matriz.

| Verificação | Resultado observado |
| --- | --- |
| Playwright MCP da Microsoft | Cinco páginas públicas percorridas e captura/medição mobile, com snapshots e relatório. Comprovante consultado sem login. |
| Playwright com API real | **3 jornadas aprovadas** na execução final, em 2,6min. Inclui dois usuários, depósitos, rejeições, troca de líder, liberação, +120s e liquidação de R$ 1,10 com comprovante e resultados vinculados ao lote atual; sem erros JavaScript observados na disputa. |
| Gestão pela UI e filtros/tema/mobile | Publicação, edição e cancelamento passaram; busca/importação DummyJSON também passaram na repetição da suíte. |
| Integração backend completa | **229 aprovados, 0 falhas, 1 ignorado** na suíte padrão. O cenário lento opcional do seed foi depois executado separadamente com `DEMO_TEST_SETTLEMENT_WAIT=1`: **1 aprovado, 0 falhas**, em 153s. |
| Unitários backend | **102 aprovados, 0 falhas, 1 ignorado**: verificação de symlink não aplicável no Windows. |
| Unitários/componentes frontend | **32 aprovados em 12 arquivos**. |
| Lint e tipos | Backend e frontend aprovados. |
| Build backend | Aprovado com `npm run build`. |
| Build frontend | O comando padrão encontrou `EPERM` ao limpar arquivos antigos em `dist/` deste sandbox. O build Vite para `test-results/build-verification/` passou, assim como a checagem TypeScript. |

Uma falha de login foi provocada com senha sintética para verificar o relatório:
seu valor não apareceu nos dados embutidos, anexos ou contexto do erro após o
ajuste do teste. Isso é uma verificação do próprio teste, não uma falha da aplicação.

O sandbox Windows também não resolve seu próprio usuário de sistema para o `tsx`.
As execuções backend acima usaram uma adaptação temporária do executor, oferecendo
fallback exclusivamente à consulta de usuário do sistema. Ela não é uma dependência
dos repositórios. As regras de negócio e os testes não foram alterados para contornar falhas.
Os comandos destinados ao recrutador usam `tsx` normalmente.

Os resultados descrevem esse ambiente e essa data. A execução não certifica
deploy público, carga de produção, disponibilidade futura do DummyJSON ou uma
auditoria integral de acessibilidade.

## Onde olhar no código

| Responsabilidade | Backend | Frontend |
| --- | --- | --- |
| Autenticação e papéis | [auth](../src/modules/auth/) | [auth](https://github.com/self1027/tt-verzel-frontend/tree/main/src/features/auth) |
| Catálogo e snapshots | [catalog](../src/modules/catalog/) | [ProductPicker.tsx](https://github.com/self1027/tt-verzel-frontend/blob/main/src/features/seller/ProductPicker.tsx) |
| Gestão e ciclo de vida | [auctions](../src/modules/auctions/) | [seller](https://github.com/self1027/tt-verzel-frontend/tree/main/src/features/seller) e [auctions](https://github.com/self1027/tt-verzel-frontend/tree/main/src/features/auctions) |
| Lances, reservas e dinheiro | [bids](../src/modules/bids/), [wallets](../src/modules/wallets/), [ledger](../src/modules/ledger/) | [BidForm.tsx](https://github.com/self1027/tt-verzel-frontend/blob/main/src/features/auctions/components/BidForm.tsx) e [wallet](https://github.com/self1027/tt-verzel-frontend/tree/main/src/features/wallet) |
| Liquidação e comprovante | [settlements](../src/modules/settlements/) | [ReceiptPage.tsx](https://github.com/self1027/tt-verzel-frontend/blob/main/src/features/audit/ReceiptPage.tsx) e [account](https://github.com/self1027/tt-verzel-frontend/tree/main/src/features/account) |
| Integridade e recuperação | [audit](../src/modules/audit/), [recovery-service.ts](../src/modules/auctions/services/recovery-service.ts) | [AuditPage.tsx](https://github.com/self1027/tt-verzel-frontend/blob/main/src/features/audit/AuditPage.tsx) |
| Tempo real | [realtime](../src/modules/realtime/) | [AuctionRealtime.tsx](https://github.com/self1027/tt-verzel-frontend/blob/main/src/features/auctions/components/AuctionRealtime.tsx) |

Contratos e detalhes adicionais estão no [OpenAPI](openapi.yaml), na
[arquitetura](architecture.md) e na [recuperação financeira](auction-recovery.md).
O MCP utilizado é o pacote já instalado
[@playwright/mcp da Microsoft](https://github.com/microsoft/playwright-mcp).

Para o campo sobre IA do formulário (p7), esta curadoria usou IA para relacionar
requisitos, escrever testes/guia e executar verificações. A declaração sobre o
desenvolvimento completo deve refletir o uso real do autor, incluindo o que foi
revisado e ajustado; não é inferida a partir desta etapa.
