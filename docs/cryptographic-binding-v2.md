# Compromissos de vendedor/produto — hashVersion 2

Novos leilões criados por esta versão começam com eventos `hashVersion: 2`.
Históricos existentes não são reescritos, promovidos nem reancorados sob outro
significado. Não há alteração de tabelas: `hash_version` integer e `payload` JSON
existentes armazenam o formato novo. Migrations anteriores permanecem intactas.

## Formato e momento confiável

`AUCTION_CREATED` v2 inclui o payload de termos anterior e `binding`:

```json
{"binding":{"sellerRef":"<sha256 hex>","productHash":"<sha256 hex>"}}
```

O appender cria esse binding dentro da transação que insere o novo leilão, lendo
vendedor e snapshot sob locks. Não aceita binding fornecido pelo chamador e não o
atualiza nas edições. O momento confiável é a criação do leilão a partir do
snapshot importado; o fornecedor externo não é autenticado criptograficamente e
não existe testemunho da janela entre importação e criação do primeiro leilão.

- sellerRef: SHA256 de `verzel:audit:seller:v2\0` seguido do JSON canônico de
  `[auctionId,sellerId]`. Vincula o beneficiário sem publicar seu UUID nesse campo.
- productHash: SHA256 de `verzel:audit:product:v2\0` seguido do JSON canônico do
  objeto completo `id,externalId,source,title,description,imageUrl,attributes,capturedAt`.
  Os campos são exatamente os persistidos no snapshot; não inclui dados voláteis
  consultados no fornecedor. capturedAt usa UTC com seis casas de microssegundos,
  lidas como texto no PostgreSQL para não perder precisão em JavaScript Date.
- Evento v2: mesma estrutura lógica do envelope v1, com domínio
  `verzel:audit:event:v2\0` e `hashVersion:"2"` dentro do material canônico.
  `hashVersion:2` permanece número no DTO. Sequência é string no JSON público.

Objetos são ordenados por chave e arrays preservam ordem. O JSON de eventos
mantém a política anterior de números inteiros seguros. Somente o digest de
snapshot admite números fracionários finitos com magnitude <= MAX_SAFE_INTEGER;
usa a representação JSON de Number e rejeita -0/NaN/Infinity/valores de magnitude
insegura. É um compromisso dos valores JSON representáveis pela aplicação, não
dos bytes/decimal arbitrário do JSON original do fornecedor. Strings e valores
monetários autoritativos mantêm seu formato anterior e não usam esse modo.

`AUCTION_UPDATED` e `AUCTION_CANCELLED` continuam comprometendo termos, datas e
status pelas regras atuais. O binding original fica separado no replay, sem
redefinição por dados mutáveis. Produto é imutável no contexto de um leilão v2:
uma alteração legítima exige novo snapshot e novo leilão. Reimportar um ID já
importado continua retornando o snapshot existente, conforme contrato atual.

## Verificação, captura e recibo

Replay v2 compara binding original com um digest independente do estado atual.
Uma divergência retorna TAMPERED; não se cura a divergência gravando digest novo.
O gate consulta witness antes dos locks financeiros, depois a transação confere
novamente cadeia/estado/binding/proof. Auction UPDATE lock protege o vendedor;
product SHARE lock é mantido até commit da captura. Alteração de produto já
confirmada depois do gate causa DEFERRED/AUDIT_VERSION_CHANGED; uma escrita
concorrente enquanto há captura espera o lock e será detectada na leitura seguinte.

Todo receipt exige cadeia local existente, canônica e válida antes de escolher
cobertura v1/v2; alterar apenas hash_version para simular legado não pula essa
validação. Histórico ausente, versão não suportada ou cadeia corrompida retorna409.
Receipt v2 confere ainda replay, binding e dados financeiros no mesmo
snapshot REPEATABLE READ. Conteúdo adulterado produz409 RECEIPT_INCONSISTENT.
`integrityCoverage:SELLER_PRODUCT_V2` descreve os campos comprometidos, não afirma
que houve consulta ao witness durante a emissão do recibo. Sua presença continua
distinta de status VERIFIED: consultar `/auctions/:id/audit` para comparar o head
independente. Reescrever simultaneamente genesis/cadeia/snapshot pode enganar uma
conferência exclusivamente local, mas não o witness previamente ancorado.

## Legado e operação

- v1: hash/serialização/validação anteriores preservados; a cadeia continua v1
  em novos eventos desse histórico. Cadeias mistas são rejeitadas, sem upgrade
  silencioso. `VERIFIED + integrityCoverage:LEGACY_V1` significa somente cadeia,
  replay operacional antigo e head coincidente, sem vendedor/conteúdo do produto.
- Lotes legados ainda não liquidados com lances: DEFERRED/LEGACY_INTEGRITY_UNBOUND, sem captura
  ou crédito. Não existe evidência criptográfica do original para fazer upgrade
  automático seguro. Um operador precisa resolver esses lotes por processo
  confiável externo; não há comando de migração/revalidação introduzido aqui.
  Sem lances, o fechamento CLOSED_NO_BIDS continua permitido após verificação
  testemunhada e rechecks locais, sem transferência, mantendo eventos v1.
- Recibos v1 já emitidos continuam disponíveis com LEGACY_V1 e aviso no frontend.
  Não declarar que a política nova detecta alterações de campos omitidos de v1.
- v0 permanece formato não suportado para verificação forte. Recibos sem cadeia
  válida não são emitidos como legados; os registros permanecem no banco para análise.
- Witness assina os mesmos checkpoints opacos sequência/hash com Ed25519 e CAS.
  Protocolo, chaves, journal e assinaturas não mudam. Não reescrever seu histórico.

Atualizar leitores/verificadores antes de aceitar escrita v2. Um binário antigo
rejeita eventos v2; rollback sem leitor v2 interrompe a operação desses lotes,
mas não converte provas. Não há DDL a desfazer nem backfill que tente fabricar
compromissos originais. Registros v1 e suas assinaturas permanecem utilizáveis.

Os estados e regras financeiras não relacionados permanecem iguais. Limites da
fila de ancoragem/capacidade, rate limiting e estado stale do frontend pertencem
a outros achados e não são corrigidos neste patch.
