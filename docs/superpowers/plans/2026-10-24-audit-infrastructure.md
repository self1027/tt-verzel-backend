# Plano de implementação da infraestrutura de auditoria

> Execução: agentes especializados trabalharam em paralelo; o agente principal integrou e revisou o resultado.

**Objetivo:** verificar publicamente os compromissos de cada leilão usando um witness independente e assinado.
**Especificação:** pedido do usuário e páginas 2, 3, 4 e 5 de requirements.pdf (as sete páginas foram lidas visualmente).
**Arquitetura:** portas de domínio, gravador Drizzle vinculado à transação, outbox durável em audit_anchors,
witness HTTP fora do banco auditado e verificação pública somente de leitura.
**Tecnologias:** TypeScript/Express/Drizzle/PostgreSQL existentes; SHA-256, Ed25519 e fetch nativos.

## Restrições e decisões

- Preservar o trabalho existente (somente temp/ estava sem rastreamento no início), sem push e até 500 linhas adicionadas/removidas por commit.
- Trabalhar no checkout fornecido; alterações compartilhadas, migrations e commits ficam sob responsabilidade do agente principal.
- Duas etapas de execução, pois o ambiente permite três agentes filhos além do principal.
- Não armazenar credenciais privadas nem dados/chaves do witness no banco ou volume do container da aplicação.
- O witness é um serviço HTTP operado independentemente, com API somente de acréscimo, diário durável e assinaturas Ed25519.
- O modelo de confiança não cobre comprometimento/reversão do witness nem comprometimento do runtime da aplicação ou das credenciais de publicação.
- Um atacante com acesso SQL pode reescrever um trecho ainda não ancorado; nunca classificá-lo como VERIFIED.
- Sem âncora de produção configurada, retornar VERIFICATION_UNAVAILABLE; não simular uma verificação bem-sucedida.
- Eventos existentes sem versão de hash recebem versão 0; o verificador os rejeita em vez de aprová-los silenciosamente.
- Leilões sem registro inicial são NOT_RECORDED; nunca preencher silenciosamente um estado histórico considerado confiável.
- Lances e liquidações usam payloads públicos tipados e estritos, com pseudônimos de licitante por leilão.

## Responsáveis e dependências

1. O agente principal define contracts/audit.ts e contracts/anchors.ts antes de delegar.
2. A: domain/ (JSON canônico, validação de evento, hash e validação da cadeia), tests/audit-domain.test.js.
3. B: repositories/ (gravador vinculado à transação, outbox/repositório de leitura),
   auctions/repositories/drizzle-auction-audit-reader.ts, tests/integration/audit-persistence.test.js.
   Usa as funções de domínio descritas abaixo. Sem alterar schema ou migrations.
4. C: infrastructure/http-anchor-provider.ts, witness/*, tests/audit-witness.test.js.
   Usa as portas de âncora; o provider HTTP verifica chave pública fixada, namespace e assinaturas.
5. Principal: schema/migration, services/verifier, services/anchor-worker, controller/composição/configuração;
   integrar gravadores de auditoria à persistência de leilões existente; testar verificação pública e ataques.
6. Segunda etapa: E revisa ataques de forma independente e adiciona testes adversariais; F revisa aderência ao PDF e documentação;
   A/B/C revisam os demais componentes quando liberados. O principal integra as correções.

## API compartilhada do domínio (A)

- canonicalJson(value: unknown): string; rejeitar dados não JSON, números inseguros/não inteiros, ciclos e protótipos.
- validateInput(input: AuditInput): void; campos estritos por tipo de payload e datas UTC canônicas em milissegundos.
- hashEvent(event: Omit<AuditEvent, 'eventHash'>): string; SHA-256 versionado e separado por domínio, incluindo ID.
- checkChain(auctionId: string, events: AuditEvent[]): { valid: boolean; reason: string | null }.
- GENESIS_HASH: 64 zeros. A sequência começa em 1, sem lacunas; hashVersion=1.
- bidderReference(auctionId: string, bidderId: string): string; pseudônimo SHA-256 exclusivo por leilão.
- payload do leilão: todos os campos AuctionCommitment no nível raiz.
- payload BID_ACCEPTED: campos BidCommitment e endsAt (após anti-sniping).
- payload AUCTION_SETTLED: campos SettlementCommitment.
- payload AUCTION_CLOSED_NO_BIDS: objeto vazio.

## Verificações e entrega

- [x] Registrar resultados de referência de npm test/test:db/lint/typecheck/build.
- [x] Cada pessoa implementadora escreve testes antes do código e registra os comandos red/green.
- [x] Validar canonicalização, continuidade da cadeia, privacidade, rollback e gravações concorrentes.
- [x] Testar publicação no witness independente, novas tentativas, perda de resposta, reinício e referências imutáveis.
- [x] Verificar alterações SQL diretas (update/insert/delete/truncamento/reescrita), mudanças de lances e endpoint sem login.
- [x] Validar gravações do leilão na mesma transação; sem acesso à rede antes do commit; bloquear primeiro o leilão.
- [x] Reexecutar as cinco verificações obrigatórias após integrar e registrar resultados exatos.
- [x] Escrever em português as seções A–H de docs/implementation-reports/audit-infrastructure.md.
- [x] Criar commits coesos somente após conferir até 500 linhas adicionadas/removidas preparadas; sem push.

## Pontos de revisão

- Nunca confiar em uma linha audit_anchors local apagada ou forjada para descobrir o último estado externo.
- Nunca retornar JSON adulterado bruto (pode conter PII injetada por atacante) em páginas públicas de eventos.
- Distinguir condições de corrida entre snapshot/provider de corrupção; reler o banco após consultar o estado externo.
- A outbox pendente sobrevive a falhas entre commit/publicação e publicação/confirmação.
- A confirmação usa compare-and-set; sequência externa duplicada com hash diferente gera conflito.
- A verificação completa tem limites; excedê-los retorna indisponível, nunca VERIFIED parcial.

## Avaliação adiada

A implementação de reservas é opcional após estabilizar a auditoria; não expandir para BidService ou
captura/liquidação sem evidências suficientes de integração. As portas de reserva existentes permanecem intactas.
