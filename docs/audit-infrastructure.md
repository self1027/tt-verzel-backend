# Infraestrutura de auditoria pública

**Patch01:** novos leilões usam hashVersion2 para vincular vendedor e snapshot;
v1 mantém suas garantias originais com cobertura limitada explícita. O formato v1
descrito nas seções históricas abaixo não foi reescrito. Consulte
[Compromissos v2 e operação de legados](cryptographic-binding-v2.md) para regras
atuais de criação, settlement, recibos e rollback.

Este guia descreve a implementação em `src/modules/audit`, seus limites e a operação da testemunha externa. A infraestrutura não constitui um deploy de produção: a ancoragem externa em produção ainda não está configurada. Sem testemunha configurada e acessível, a aplicação deve responder `VERIFICATION_UNAVAILABLE`, nunca simular `VERIFIED`.

## Escopo atual e requisitos

O PDF exige consulta anônima do histórico, identificação de alterações, inserções e remoções feitas diretamente no banco, preservação dos dados pessoais e uma página pública de auditoria. As sete páginas foram lidas visualmente nesta revisão. Os endpoints JSON fornecem a infraestrutura de consulta; uma interface React pública e o deploy obrigatório continuam sendo entregas separadas. O seed atual cria usuários, carteiras e contas contábeis; ainda falta o lote publicado com lances abertos exigido na página 5.

Criação, edição, cancelamento e [lances aceitos](bids.md) registram eventos na mesma transação da alteração operacional. BidService também faz reservas/liberações; captura, liquidação e comprovante continuam pendentes. A auditoria compara a projeção das tabelas de lotes, lances e liquidações; não prova o dinheiro liquidado no ledger, saldos ou reservas. `receiptHash` compromete o token do comprovante, sem publicar esse token; não verifica o conteúdo de uma página de comprovante nem a transferência contábil.

## Componentes e dependências

| Componente | Responsabilidade |
| --- | --- |
| `contracts/audit.ts` | Portas de escrita/leitura e compromissos públicos tipados. |
| `domain/cryptography.ts` | Canonicalização, whitelist, hashes, pseudônimos e continuidade. Não depende de Express ou Drizzle. |
| `repositories/drizzle-audit-appender.ts` | Append vinculado à transação de negócio e criação da outbox. |
| `repositories/drizzle-audit-repository.ts` | Snapshot consistente, páginas, pendências e confirmação CAS. |
| `auctions/repositories/drizzle-auction-audit-reader.ts` | Converte registros operacionais em compromissos públicos, dentro do módulo proprietário. |
| `services/operational-integrity.ts` | Reconstitui compromissos e compara a projeção operacional. |
| `services/audit-verifier.ts` | Consulta o head externo e classifica o snapshot local. |
| `services/anchor-worker.ts` | Publica pendências após commit e confirma recibos. |
| `infrastructure/http-anchor-provider.ts` | HTTP, limites, timeout e validação Ed25519 com chave pública fixada. |
| `witness/*` | Serviço independente, journal durável, CAS e assinaturas. |
| `controllers/audit-controller.ts` | Endpoints públicos somente de leitura. |

`AuditAppender.append(AuditInput)` devolve o evento persistido. `AuditRepository` oferece `snapshot`, `page`, `pending` e `confirm`. `AnchorVerifier.latest(auctionId)` consulta a testemunha independente, nunca `audit_anchors`; `AnchorPublisher.publish(checkpoint, previous)` publica uma transição CAS. `Checkpoint` contém `auctionId`, `sequence` decimal e `hash`.

`OperationalState` contém `{auction: AuctionCommitment, bids: BidCommitment[], settlement: SettlementCommitment | null}`. `AuditSnapshot` contém `{auctionId, events: AuditEvent[], operational: OperationalState}`. `PendingAnchor` contém `{id, auctionId, sequence: bigint, hash}`. As assinaturas da porta de repositório são `snapshot(auctionId): Promise<AuditSnapshot | null>`, `page(auctionId, after: bigint, limit): Promise<AuditEvent[]>`, `pending(limit): Promise<PendingAnchor[]>` e `confirm(id, reference, at, expected?: PendingAnchor): Promise<void>`. O worker fornece o checkpoint esperado: a confirmação exige também igualdade de lote, sequência e hash, além de referência ainda nula. Os compromissos de lote/lance/liquidação estão detalhados na tabela de payloads; o payload do lance acrescenta `endsAt` ao `BidCommitment`.

## Transação e bloqueios

O repositório de lotes recebe uma fábrica de `AuditAppender` ligada ao mesmo `DatabaseTransaction`. Após a escrita operacional, registra a projeção pública. O appender valida e copia a entrada, bloqueia primeiro a linha de `auctions` com `FOR UPDATE`, lê a cadeia em sequência, valida o prefixo e insere o novo evento e a pendência em `audit_anchors`.

O bloqueio do lote serializa appends concorrentes do mesmo lote, inclusive quando ainda não existe evento. O índice único `(auction_id, sequence)` é uma defesa adicional. A ordem global existente permanece: lote; carteiras em ordem crescente de UUID; reservas; escritas de ledger e auditoria. O appender readquire o lock já mantido pelo chamador, sem inversão da ordem. Não há chamada de rede dentro dessa transação. Uma falha na gravação do evento ou da outbox faz rollback da alteração do lote.

O snapshot de verificação usa uma transação `REPEATABLE READ`, somente leitura. O verificador consulta primeiro a testemunha e depois abre o snapshot do banco, evitando comparar um head recém-publicado a um snapshot local iniciado antes dele. A testemunha pode avançar depois da consulta; a resposta representa o head observado naquela consulta, sem prometer que continuará sendo o mais recente.

Cada lote suporta até 10.000 eventos e 10.000 registros de lance na leitura integral. O appender rejeita um append acima do limite. Uma leitura que ultrapassa o limite fica indisponível e não recebe sucesso parcial. A paginação de eventos não remove o limite da verificação integral.

## Contratos públicos e validação

Um `AuditInput` contém exatamente `auctionId`, `eventType`, `payload` e `createdAt`. Um evento acrescenta `id`, `sequence`, `previousHash`, `eventHash` e `hashVersion`.

| Evento | Campos exatos de `payload` |
| --- | --- |
| `AUCTION_CREATED` | `productSnapshotId`, `startingBidCents`, `minIncrementCents`, `startsAt`, `endsAt`, `status`, `currentBidId` |
| `AUCTION_UPDATED` | Mesmos campos completos do lote. |
| `AUCTION_CANCELLED` | Mesmos campos completos do lote, com `status: CANCELLED`. |
| `BID_ACCEPTED` | `bidId`, `bidderRef`, `amountCents`, `bidSequence`, `createdAt`, `endsAt` após eventual prorrogação. |
| `AUCTION_SETTLED` | `settlementId`, `winningBidId`, `ledgerTransactionId`, `amountCents`, `settledAt`, `receiptHash` |
| `AUCTION_CLOSED_NO_BIDS` | Objeto vazio `{}`. |

UUIDs são strings em minúsculas. Valores monetários são strings decimais positivas sem sinal, espaços ou zeros à esquerda, limitadas a `9223372036854775807`. Sequências seguem o mesmo intervalo positivo; cursores podem ser zero. A sequência interna do evento é `bigint` e vira string na resposta JSON. `hashVersion` interno/público é o número `1`.

Datas têm formato exato `YYYY-MM-DDTHH:mm:ss.sssZ`, em UTC, e devem existir no calendário. `startsAt` deve anteceder `endsAt`. Criação/edição usam `PUBLISHED`, cancelamento usa `CANCELLED`; liquidação e encerramento são transições próprias no replay. `currentBidId` é UUID ou `null`. Referências e hashes são 64 caracteres hexadecimais minúsculos.

Campos extras são rejeitados. Nome, e-mail, documento, UUID original do licitante e token do comprovante não pertencem ao payload público. Não adicionar um objeto genérico de metadados que permita contornar a whitelist.

## Hash v1 e canonicalização

`canonicalJson` ordena recursivamente as chaves dos objetos com a ordenação de strings do JavaScript, preserva a ordem de arrays e usa a representação JSON de strings. Aceita apenas dados JSON; números devem ser inteiros seguros e diferentes de `-0`. Rejeita ciclos, `undefined`, `bigint`, funções, símbolos, getters, propriedades ocultas, arrays esparsos e protótipos de classes. Objetos simples, inclusive com protótipo nulo, são permitidos. Não executa `toJSON`.

O compromisso é calculado com SHA-256 sobre os bytes UTF-8 abaixo; `\0` representa um byte NUL, não os dois caracteres barra e zero:

```text
eventHash = SHA256(
  "verzel:audit:event:v1\0" +
  canonicalJson({
    id, auctionId,
    sequence: sequence.toString(),
    eventType, payload, createdAt, previousHash,
    hashVersion: "1"
  })
)
```

O resultado é hexadecimal minúsculo. O UUID do próprio evento participa do hash. A sequência começa em `1`; `previousHash` do primeiro evento são 64 zeros. Cada evento seguinte deve referenciar o hash anterior e ter sequência contígua. IDs repetidos, versão diferente de 1 e hashes divergentes invalidam a cadeia.

O pseudônimo do licitante é:

```text
bidderRef = SHA256(
  "verzel:audit:bidder:v1\0" + canonicalJson([auctionId, bidderId])
)
```

Ele é estável dentro do lote e diferente em outros lotes. Não é autenticação do licitante nem substitui a autorização da API. Quem já conhece ambos os UUIDs pode recalcular a referência; a garantia é não divulgar o identificador original pelo histórico público.

## Verificação e alcance da prova

O replay exige uma criação inicial antes de alterações, respeita estados terminais e compara todos os compromissos ao snapshot operacional. Para lances, compara sequência, valor mínimo, alternância de líder, horário e fim prorrogado; para liquidação, vencedor, valor, horário e compromisso de comprovante. Anti-sniping exige exatamente o prazo anterior mais 120000ms quando restam até dois minutos; fora da janela, o prazo não muda. BidService valida o replay completo antes do commit. As reservas são validadas pelo módulo financeiro; captura e transferência do ledger continuam fora dessa projeção.

| Estado | Interpretação |
| --- | --- |
| `VERIFIED` | Cadeia e projeção consistentes, baseline registrado e head local igual ao head externo observado. |
| `PENDING_ANCHOR` | Não há head externo ou há um sufixo local ainda sem compromisso independente. |
| `TAMPERED` | Cadeia inválida, projeção divergente, head externo ausente localmente ou hash incompatível. |
| `VERIFICATION_UNAVAILABLE` | Testemunha ou snapshot indisponível, configuração ausente ou limite excedido. |

`externallyVerifiedSequence` delimita o prefixo confirmado. Por exemplo, `localSequence: "7"` e `externallyVerifiedSequence: "5"` deixam os eventos 6 e 7 pendentes. Acesso SQL pode reescrever esse sufixo sem que o hash encadeado isoladamente prove a fraude; ele nunca deve ser apresentado como integralmente verificado.

Se o atacante excluir todo o sufixo não ancorado e restaurar a projeção operacional ao último head externo, não há evidência independente de que esse sufixo existiu. Nesse caso o prefixo remanescente pode retornar `VERIFIED`, limitado à sequência externa informada. Há teste demonstrando essa limitação; `VERIFIED` não prova que jamais existiram operações posteriores ainda não publicadas.

Antes de converter datas SQL em `Date`, os leitores verificam precisão canônica de milissegundos. Assim, uma adulteração de um microssegundo não desaparece na conversão. Criação/edição/cancelamento são comparados aos horários permitidos e cancelamento não pode modificar termos do lote.

`operationalCoverage` é `CONSISTENT`, `DIVERGENT`, `NOT_RECORDED` ou `UNAVAILABLE`. Lotes antigos sem baseline não ganham confiança retroativa. Sem eventos e sem histórico operacional que exija compromissos, ficam `NOT_RECORDED`, nunca `VERIFIED`. Se um lote antigo passar a receber eventos de atualização sem criação registrada, o replay acusa baseline ausente. A migração atribui `hash_version = 0` aos eventos antigos; a versão 0 é rejeitada. Não recriar uma cadeia histórica e apresentá-la como prova do passado.

A exclusão de uma linha local de `audit_anchors` não apaga o compromisso remoto: a consulta de verificação não usa essa tabela para descobrir o head. Uma alteração ou remoção em prefixo ancorado, inclusive uma reescrita de todos os hashes locais, diverge do head independente. A ausência de um lote que ainda possui head remoto retorna `TAMPERED`.

## Testemunha independente e protocolo

A testemunha deve funcionar sob operação e credenciais separadas, com journal e chave privada fora do banco, do container e do volume da aplicação. O backend possui apenas a chave pública fixada e a credencial de publicação. Hospedar o journal no mesmo volume administrável pelo atacante SQL elimina a separação pretendida.

Rotas da testemunha:

```text
GET  /v1/namespaces/:namespace/auctions/:auctionId/latest
POST /v1/namespaces/:namespace/auctions/:auctionId/checkpoints
```

GET é público: retorna o recibo assinado, ou `404 {"error":"NOT_FOUND"}`. POST exige `Authorization: Bearer <token>` e corpo exato:

```json
{
  "checkpoint": {
    "auctionId": "11111111-1111-4111-8111-111111111111",
    "sequence": "1",
    "hash": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  },
  "previous": null
}
```

Após o primeiro checkpoint, `previous` é `{ "sequence": "1", "hash": "..." }` com o head esperado. O CAS exige correspondência com o head atual e avanço de sequência; os checkpoints podem saltar sequências, pois comprometem o prefixo local validado pelo publicador. Concorrentes com heads incompatíveis recebem `409 CONFLICT`. A mesma sequência e hash devolvem o recibo original, preservando referência e data; a mesma sequência com hash diferente conflita. Um sucesso usa HTTP 201, inclusive em repetição idempotente.

`ExternalAnchor` contém `auctionId`, `sequence`, `hash`, `namespace`, `previousSequence`, `previousHash`, `reference`, `publishedAt` e `signature`. No primeiro recibo, `previousSequence` é `"0"` e `previousHash` são 64 zeros. A referência é `sha256:` mais SHA-256 de `"auction-audit-anchor-reference:v1\n" + canonicalJson(body)`, onde `body` exclui `reference` e `signature`. A assinatura Ed25519 em Base64 cobre `"auction-audit-anchor:v1\n" + canonicalJson({...body, reference})`.

O provider verifica chave Ed25519 fixada, namespace, lote, campos, formato, referência e assinatura; no POST verifica também o checkpoint solicitado e o predecessor. Não segue redirecionamentos e solicita leitura sem cache. Timeout padrão: 5 segundos, incluindo leitura do corpo; respostas têm limite de 16 KiB. A assinatura autentica o recibo, mas não prova que um recibo antigo ainda é o head mais recente: HTTPS com validação de certificado é necessário em produção para reduzir replay por interceptação. O provider rejeita HTTP fora de `localhost`, `127.0.0.1` e `[::1]`; a exceção atende desenvolvimento ou acesso por túnel local administrado.

## Outbox, retries e reinício

`audit_anchors.external_reference IS NULL` significa pendente. `anchored_at` inicialmente recebe a data do evento; não significa confirmação enquanto a referência estiver nula. Após publicação, a confirmação CAS grava referência e data do recibo. Se um head posterior já cobre o prefixo, a referência confirmada pode pertencer a esse checkpoint posterior. A tabela é uma outbox/registro operacional, não a fonte de verdade da prova.

`AnchorWorker.runOnce()` processa até 100 pendências por padrão. Para cada uma, consulta o head remoto, relê o snapshot, exige consistência e confere o hash da pendência. Se o head já compromete aquele prefixo, confirma localmente; caso contrário, publica via CAS. Falhas incrementam `failed` e deixam a linha pendente. O guard interno evita duas execuções simultâneas da mesma instância; múltiplas instâncias dependem do CAS remoto e da confirmação idempotente.

Se ocorrer crash após commit e antes da publicação, a outbox continua pendente. Se a publicação foi persistida e a resposta se perdeu, o próximo ciclo consulta o head e recupera a confirmação. Crash depois do recibo e antes da confirmação segue o mesmo caminho. Reiniciar o worker não exige reconstruir eventos nem republicar uma cadeia inventada.

Não há contador de tentativas, backoff persistido, fila de falhas ou reparação automática de pendências apagadas por SQL. Monitorar idade e quantidade de linhas sem referência e os contadores `confirmed`/`failed` do ciclo. Um prefixo íntegro já ancorado continua verificável mesmo se suas linhas locais de confirmação forem apagadas; um sufixo com outbox removida não ganha prova por isso.

O journal da testemunha serializa gravações, grava um recibo JSON por linha e executa `fsync` antes de reconhecer o sucesso. Ao iniciar, revalida cada assinatura e transição. Há limite de 64 MiB por journal e rejeição de truncamento/corrupção; atingir o limite exige uma estratégia operacional de capacidade antes de continuar. Não existe rotação automática implementada.

O diretório é resolvido pelo caminho real e o journal/lock precisam ser arquivos regulares com uma única referência. A identidade por descritor e os links são conferidos antes de publicar; aliases inseguros falham fechados. Isso evita dois escritores por hardlink/junction, sem transformar armazenamento hostil sob controle do mesmo usuário em uma raiz confiável.

## Configuração e execução da testemunha

Na máquina independente da testemunha, forneça estas variáveis pelo gerenciador de processos/segredos. O `main.ts` da testemunha não carrega automaticamente um arquivo `.env`.

| Variável | Uso |
| --- | --- |
| `WITNESS_NAMESPACE` | Identificador do ambiente; até 128 caracteres de letras, números, `.`, `_`, `:`, `-`, começando por alfanumérico. |
| `WITNESS_JOURNAL_PATH` | Caminho absoluto persistente para o journal, em armazenamento independente. |
| `WITNESS_PRIVATE_KEY_FILE` | Arquivo PEM PKCS#8 com chave privada Ed25519. |
| `WITNESS_PUBLISH_TOKEN` | Segredo de publicação, mínimo de 16 caracteres; use valor aleatório forte. |
| `WITNESS_HOST` | Padrão `0.0.0.0`; preferir loopback atrás de proxy TLS quando aplicável. |
| `WITNESS_PORT` | Padrão `8081`, inteiro entre 1 e 65535. |

Crie o diretório de segredos e gere a chave exclusivamente nessa máquina. Exemplo com Node, após ajustar os caminhos para a instalação independente:

```js
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
const keys = generateKeyPairSync('ed25519');
writeFileSync('/srv/witness/secrets/private.pem', keys.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600, flag: 'wx' });
writeFileSync('/srv/witness/secrets/public.pem', keys.publicKey.export({ type: 'spki', format: 'pem' }), { mode: 0o644, flag: 'wx' });
writeFileSync('/srv/witness/secrets/publish-token', randomBytes(32).toString('hex'), { mode: 0o600, flag: 'wx' });
```

Distribua somente `public.pem` e a credencial de publicação necessária ao backend. A chave privada permanece na testemunha. Não versionar esses arquivos. O exemplo é de provisionamento; não foi executado como deploy nesta entrega.

Após configurar o ambiente e instalar as dependências:

```sh
npm run build
node dist/modules/audit/witness/main.js
```

Para desenvolvimento, `npm run audit:witness` executa o mesmo entrypoint com `tsx`, sem necessidade de build prévio. Mesmo na demonstração local, use diretório de journal e chave separados do volume do banco; isso não equivale à independência operacional de produção.

O backend carrega `.env` e valida sua configuração em `infrastructure/config.ts` por `readAuditConfig`:

| Variável da aplicação | Uso |
| --- | --- |
| `AUDIT_WITNESS_URL` | URL base HTTPS da testemunha; HTTP somente em loopback. |
| `AUDIT_WITNESS_NAMESPACE` | Mesmo namespace da testemunha; a configuração da aplicação restringe a 1–100 caracteres alfanuméricos, `_` ou `-`. |
| `AUDIT_WITNESS_PUBLIC_KEY_FILE` | Arquivo PEM SPKI com a chave pública Ed25519 previamente fixada. |
| `AUDIT_WITNESS_PUBLISH_TOKEN` | Opcional; mínimo de 16 caracteres. Sem token o backend apenas consulta e verifica. |
| `AUDIT_WITNESS_TIMEOUT_MS` | Padrão 5000, entre 1 e 30000 milissegundos. |
| `AUDIT_ANCHOR_POLL_MS` | Padrão 5000, entre 100 e 3600000 milissegundos. |

Exemplo de configuração da aplicação, com caminhos e serviço ilustrativos:

```dotenv
AUDIT_WITNESS_URL=https://witness.example.org
AUDIT_WITNESS_NAMESPACE=verzel-prod
AUDIT_WITNESS_PUBLIC_KEY_FILE=/run/config/witness-public.pem
# Injetar via gerenciador de segredos; omitir para modo somente leitura.
# AUDIT_WITNESS_PUBLISH_TOKEN=<segredo provisionado separadamente>
AUDIT_WITNESS_TIMEOUT_MS=5000
AUDIT_ANCHOR_POLL_MS=5000
```

URL ausente com namespace, chave pública ou token preenchidos é configuração parcial inválida e impede inicialização. Sem essas configurações, o módulo instala um provider indisponível. A presença da URL exige namespace e caminho da chave; arquivo ou chave inválidos também impedem inicialização.

O provider recebe `baseUrl`, `namespace`, `publicKey`, `publishToken` opcional e `timeoutMs` opcional. O módulo retorna `{router, verifier, worker}`. `src/server.ts` injeta o provider e sempre monta as rotas públicas, inclusive sem testemunha. Quando há token de publicação, dispara um ciclo imediatamente e agenda os seguintes pelo intervalo configurado. Sem token, não publica. Ao encerrar, cancela o timer e aguarda a publicação em andamento antes de fechar o pool do banco. Instanciar a testemunha dentro do backend ou usar uma confirmação em memória não constitui ancoragem independente.

## Recuperação de lock da testemunha

O journal cria `<journal>.lock` com abertura exclusiva e registra o PID. Encerramento normal fecha o journal e remove o lock. Um crash pode deixar o arquivo: a inicialização falha de propósito, sem apagá-lo automaticamente.

1. Pare o serviço/supervisor e confirme, inclusive em outras máquinas com acesso ao volume, que nenhum escritor anterior continua ativo. O PID sozinho não basta: ele pode ter sido reutilizado.
2. Faça uma cópia de preservação do journal e do lock e confirme namespace, caminho e chave privada corretos. Não crie um journal vazio para contornar o erro.
3. Somente após provar que não existe escritor, remova exclusivamente o arquivo `<journal>.lock` do caminho confirmado.
4. Reinicie uma única instância. A leitura integral deve validar o journal; erro de truncamento ou assinatura exige investigação/restauração de backup íntegro, não edição manual de recibos.
5. Consulte os heads esperados e confirme continuidade antes de liberar publicações. Restaurar um backup antigo pode constituir rollback da testemunha e perde a premissa de confiança; não tratar como uma recuperação transparente.

Não automatizar remoção por idade de lock. Proteja o diretório com permissões restritas e backups independentes. No Windows, a durabilidade do diretório depende do filesystem; o código sincroniza o arquivo e só executa `fsync` do diretório em plataformas POSIX.

## Endpoints públicos da aplicação

Quando montado na aplicação, o router expõe sem autenticação:

```sh
curl -i 'http://localhost:3000/auctions/11111111-1111-4111-8111-111111111111/audit'
curl -i 'http://localhost:3000/auctions/11111111-1111-4111-8111-111111111111/audit/events?after=0&limit=30'
```

A consulta integral não aceita parâmetros. Responde HTTP 200 para `VERIFIED`, `PENDING_ANCHOR` e `TAMPERED`; HTTP 503 para `VERIFICATION_UNAVAILABLE`. Lote inexistente sem head remoto e com testemunha acessível retorna 404. Identificador ou query inválida segue o tratamento de validação da API. As respostas usam `Cache-Control: no-store`.

Exemplo de resposta com prefixo confirmado:

```json
{
  "auctionId": "11111111-1111-4111-8111-111111111111",
  "status": "PENDING_ANCHOR",
  "localSequence": "7",
  "externallyVerifiedSequence": "5",
  "externalHeadSequence": "5",
  "operationalCoverage": "CONSISTENT",
  "reason": null
}
```

Paginação usa `after` exclusivo, decimal canônico entre zero e BIGINT máximo, e `limit` entre 1 e 100, padrão 30. A página contém `auctionId`, `events`, `nextAfter`, `limit` e `proof: "EVENT_PAGE_ONLY"`. Cada evento usa `sequence` string, `hashVersion` número e datas UTC com milissegundos; centavos e sequências presentes no payload também são strings. Esse marcador não significa verificação integral. Consultar a rota `/audit` separadamente; páginas e verificação são leituras distintas e podem observar momentos diferentes. A página valida os campos e recalcula o hash de cada evento; rejeita metadados ou payloads públicos inválidos com `status: TAMPERED`, `reason: INVALID_PUBLIC_EVENT` e `events: []`, sem refletir conteúdo hostil. Ela não demonstra por si só continuidade entre páginas, ausência de remoções, projeção operacional ou ancoragem independente.

Consulta independente ao serviço externo:

```sh
curl -i 'https://witness.example.org/v1/namespaces/verzel-prod/auctions/11111111-1111-4111-8111-111111111111/latest'
```

O hostname é ilustrativo e não representa um serviço de produção configurado. Publicações devem usar o provider e o worker; não editar o journal nem marcar a outbox como confirmada manualmente.

## Modelo de ameaça e limites

O objetivo é detectar adulteração por acesso direto ao banco da aplicação quando existe compromisso independente correspondente. Alterar eventos e atualizar hashes/linhas locais de confirmação não permite substituir um head remoto confiável. Triggers e permissões do PostgreSQL podem complementar a proteção, mas não são a raiz da confiança.

Ficam fora da garantia: comprometimento ou rollback da testemunha, roubo de sua chave privada, comprometimento do runtime da aplicação e de suas credenciais de publicação, comprometimento da distribuição da chave pública e reescrita de um sufixo ainda não ancorado. O publicador autorizado pode comprometer dados falsos antes da ancoragem; a assinatura prova o compromisso publicado, não a verdade econômica do evento.

TLS, isolamento da rede, atualização de certificados, gestão de segredos e operação independente ainda precisam existir no deploy real. O token de publicação via HTTP pode ser interceptado. A chave pública fixada evita aceitar assinaturas de outra testemunha, mas não fornece, sozinha, disponibilidade, frescor ou proteção contra rollback. Troca de chave/namespace requer procedimento explícito de migração de confiança; não há rotação automática implementada.

## Verificações da fase de infraestrutura

Na fase de infraestrutura, `npm test` aprovou 55 cenários, com zero falhas e um cenário ignorado por privilégio de symlink no Windows. `npm run test:db` aprovou 93 cenários no PostgreSQL real. Lint, typecheck e build passaram. Os testes cobrem canonicalização, whitelist, encadeamento, replay, reescrita contra head remoto, exclusão de cauda, indisponibilidade, privacidade e protocolo da testemunha. Resultados atuais, incluindo lances reais, constam no [relatório BidService](implementation-reports/bid-service.md).

Este guia não afirma que foi realizado deploy, configurada ancoragem de produção, entregue a interface pública React ou provada a liquidação financeira. Consulte `docs/implementation-reports/audit-infrastructure.md` para as evidências finais e pendências da entrega.
