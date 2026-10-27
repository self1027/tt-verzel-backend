# Verzel Auction House

Backend de leilões com Node.js 22+, TypeScript, Express 5, PostgreSQL 17 e Drizzle.
Inclui JWT, catálogo DummyJSON, lances concorrentes, carteiras, liquidação
automática, Socket.IO e auditoria com testemunha independente (witness).

Para avaliar o desafio, comece pelo [guia unificado do recrutador](docs/guia-recrutador.md):
ele relaciona os requisitos do PDF com passos, testes executáveis e uma breve
explicação da implementação, incluindo a jornada com o frontend real.
O [frontend tem seu próprio repositório](https://github.com/self1027/tt-verzel-frontend);
os dois projetos podem ser clonados em quaisquer diretórios e se integram pela URL da API.

## Deploys

- [Aplicação web](https://auctionverzel.murilod.dev/)
- [Documentação da API (Swagger UI)](https://api.auctionverzel.murilod.dev/docs/)

## Executar com Docker

Com Docker e Compose instalados:

```sh
docker compose up -d --build
```

A API fica em `http://localhost:3000`. O Compose inicia PostgreSQL e witness,
aplica migrations e executa o seed. Não é necessário criar `.env`.
Consulte os lotes em `GET /auctions` e o Swagger UI em `http://localhost:3000/docs/`.
O contrato é mantido em `docs/openapi.yaml`, sem anotações nas rotas, e servido em
`GET /openapi.yaml` e `GET /openapi.json`.

| Conta | Senha padrão |
| --- | --- |
| `auctioneer@verzel.local` | `AuctioneerDemo2026!` |
| `bidder1@verzel.local` | `BidderOneDemo2026!` |
| `bidder2@verzel.local` | `BidderTwoDemo2026!` |

O seed cria seis cenários legítimos: agendado, ativo, ativo com lances, liquidação,
encerramento sem lances e cancelamento voluntário. Nenhuma adulteração faz parte
do seed padrão. Encerramentos exigem prazo real e witness independente; veja os
[comandos e limites do seed](docs/demo-seed.md), incluindo `--wait-for-settlement`.
Cada licitante recebe R$ 1.000,00 simulados em uma carteira sem movimentação.
Reexecuções preservam senhas, saldos e prazos; não reabrem lotes vencidos.
Um `.env` pode sobrescrever `PORT` e as senhas `SEED_*`, sem alterar contas existentes.

Para parar: `docker compose down`. Os dados são preservados; `down -v` os apaga.
Para consultar erros: `docker compose logs --tail=50 api audit-witness`.

## Executar a API localmente

Requer Node.js 22+, npm e Docker Compose.

1. Execute `npm ci`.
2. Copie `.env.example` para `.env`.
3. Execute `docker compose up -d postgres`.
4. Execute `npm run db:migrate` e `npm run db:seed`.
5. Execute `npm run dev`.

Para executar compilado: `npm run build` e `npm start`.
O witness precisa de [configuração separada](docs/audit-infrastructure.md)
fora do Compose completo; sem ele, a auditoria fica indisponível e a liquidação é adiada.

## Usar e testar

Faça `POST /auth/login` com `email` e `password`; envie o token retornado em
`Authorization: Bearer <accessToken>`. Lances e depósitos exigem `Idempotency-Key`.
Valores monetários trafegam como strings de centavos, por exemplo `"2000"`.
Rotas, exemplos e respostas estão no [OpenAPI](docs/openapi.yaml).

```sh
npm test
npm run test:db
npm run test:requirements
npm run lint
npm run typecheck
npm run build
```

`test:db` e `test:requirements` exigem `TEST_DATABASE_URL` no ambiente ou `.env`, apontando para o banco
descartável `verzel_auction_test`, com permissão para criar e remover schemas.
O Compose cria esse banco na primeira inicialização do volume. A suíte
`test:requirements` executa os testes de integração em série. Para focar nas
regras de negócio ou na auditoria, use `npm run test:requirements:rules` ou
`npm run test:requirements:audit`, respectivamente.

## Limitações e comportamentos conhecidos

- **Provas legadas v1:** permanecem verificáveis com cobertura limitada. Lotes
  legados com lances ainda não liquidados ficam adiados com `LEGACY_INTEGRITY_UNBOUND`, pois
  não existe compromisso confiável do vendedor/produto original. Recibos com
  cadeia v1 válida continuam disponíveis com aviso; sem lances, o fechamento
  legado não transfere dinheiro e continua permitido. Novos leilões usam v2; veja
  [versionamento criptográfico](docs/cryptographic-binding-v2.md).

- **Sem cadastro:** use as contas do seed; não há perfil de administrador.
- **Adulteração confirmada:** `TAMPERED` bloqueia lances e liquidação e inicia
  recuperação persistente das reservas; capturas exigem compensação específica.
  Veja [recuperação financeira](docs/auction-recovery.md).
- **Encerramento pendente:** sem witness ou com ancoragem pendente, o lote pode
  ficar em `FINALIZING` até uma nova tentativa do worker.
- **Edição e cancelamento:** exigem ausência de lances; edição somente antes
  do início e cancelamento antes do encerramento. Não há cancelamento com estorno.
- **Dependências externas:** o catálogo usa DummyJSON e as imagens exigem acesso
  ao host remoto; o seed não consulta a API externa.
- **Busca em português:** a API externa pesquisa em inglês. Tradução automática
  da consulta e dos resultados fica registrada como débito técnico.

## Processo de desenvolvimento

O [vídeo do desenvolvimento](https://youtu.be/8orSPS_3zkE) contém capítulos para
navegar pelos tópicos. A [transcrição em JSON](docs/final.transcript.json) permite
pesquisar o conteúdo ou analisá-lo com ferramentas de IA.

## Documentação complementar

[Arquitetura](docs/architecture.md) · [Seed](docs/demo-seed.md) ·
[Auditoria e suas garantias](docs/audit-infrastructure.md) ·
[Integração frontend](docs/frontend-integration.md) ·
[Guia e cobertura unificada dos requisitos](docs/guia-recrutador.md)
