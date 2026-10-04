# Serviços em homologação

Aplicação local não produtiva: Node.js >=22.13, npm, SQLite nativo e HTML/CSS/JS.
O Node 22 pode emitir aviso experimental do SQLite. O `.env` permanece SANDBOX, sem chamadas externas.
O provider BravoPay está implementado para PIX conforme a documentação fornecida. Nenhuma cobrança real foi executada nesta implementação.

## Executar

```sh
npm ci
npm run env:init
npm start
```

Abra http://127.0.0.1:3000. `env:init` gera segredos e nunca sobrescreve `.env` existente.
Valores em centavos BRL: CONSULTA=3000 (R$30), ABERTURA=5000 (R$50).
API `/api/*` é contrato interno deste protótipo, não um contrato institucional ou BravoPay.

## Pagamento sandbox

Crie uma solicitação na interface. Copie o identificador de pagamento e execute no servidor:

```sh
npm run sandbox:event -- sandbox_IDENTIFICADOR PAID
npm run sandbox:event -- sandbox_IDENTIFICADOR REFUNDED
```

Atualize a situação na interface. FAILED pode substituir PAID no primeiro evento.
O simulador envia POST `/api/webhooks/sandbox` com JSON contendo `eventId`, `paymentId`, `status`, `amount`, `currency`.
Assinatura exclusiva deste sandbox: HMAC-SHA256 de `timestamp + '.' + corpo bruto`, usando SANDBOX_WEBHOOK_SECRET.
Headers: `X-Sandbox-Timestamp` (Unix segundos, tolerância de 300s) e `X-Sandbox-Signature` (hex).
Nunca reutilizar esse contrato como se fosse documentação BravoPay.
O mesmo eventId/corpo é aceito sem reprocessamento; conteúdo divergente é rejeitado.
Estados: PENDING → PAID ou FAILED; PAID → REFUNDED. Eventos fora de ordem não reabrem estados finais.
Sem endpoint de confirmação disponível ao navegador. Simulação exige segredo do backend.

## Persistência e proteção

Banco em `DATABASE_PATH`, esquema versionado (user_version=2, migração aditiva da versão 1).
CPF, nome, descrição e resultados: AES-256-GCM com nonce aleatório e contexto por registro.
Não trocar DATA_ENCRYPTION_KEY sem migrar dados; backup deve preservar banco e chave separadamente.
Fingerprint dos dados é HMAC; token de acesso é armazenado somente como hash no banco.
Sessão é capacidade aleatória por aba, não identidade autenticada institucional. sessionStorage guarda token, ID e chave/digest da operação pendente; nenhum estado de pagamento é considerado confiável. Dados pessoais não são persistidos pelo frontend.
Idempotência UNIQUE(owner,idem), pagamentos e resultados únicos por serviço; transações BEGIN IMMEDIATE.
No sandbox, conclusão fictícia e evento são gravados na mesma transação. BravoPay confirma somente pagamento; não cria resultados fictícios nem executa serviços institucionais.
Auditoria local não armazena CPF, tokens, assinatura ou payloads. Ainda requer armazenamento imutável e regras de retenção para produção.
Limite local por IP (120/min), com buckets separados para webhooks e aplicação; limite de corpo, validação, consultas parametrizadas, CSP e rejeição de origens externas. X-Forwarded-For não é confiado.
Não expor este sandbox publicamente como serviço oficial. Proxy, TLS, identidade, autorização institucional e limites distribuídos dependem do ambiente oficial.

## BravoPay e produção

Fonte exclusiva: documentação API v1 fornecida pelo usuário nesta etapa.
`src/bravoPayProvider.js`: createPayment, getPaymentStatus e verifyWebhook implementados; refundPayment permanece INTEGRATION_PENDING (nenhuma rota de reembolso foi documentada).
O simulador tem consulta e criação locais; refundPayment informa explicitamente que o reembolso se simula por webhook server-to-server.
PAYMENTS_MODE=SANDBOX seleciona somente o simulador, cuja implementação foi preservada.
PAYMENTS_MODE=BRAVOPAY seleciona somente BravoPay: sem BASE_URL, SECRET_KEY ou WEBHOOK_SECRET, encerra com `BravoPay provider is not configured.`.
BRAVOPAY_BASE_URL deve ser HTTPS; a base documentada é `https://bravopay.club/api/v1`.
BRAVOPAY_SECRET_KEY recebe a API key `bp_live_...` e vai somente no header `Authorization: Bearer ...`.
BRAVOPAY_WEBHOOK_SECRET recebe o secret `whsec_...` do Dashboard. PUBLIC_KEY permanece reservada, sem envio ou obrigatoriedade inventada.
Não há fallback entre modos. HTTP usa timeout de 4 segundos por chamada, sem retries automáticos de POST e sem seguir redirects.
APP_ENV continua restrito a homologation. `.env` permanece SANDBOX. Credenciais nunca entram no catálogo ou frontend.

### Pontos de conexão revisados

Contrato **interno**, com adaptação somente para campos/rotas documentados:

| Operação | Chamada e fronteira |
| --- | --- |
| createPayment(data) | `Services.createBravoOperation` → paymentProvider → POST /transactions. amount_cents definido no backend, method=pix, customer.name/cpf e external_reference=serviceId. Idempotency-Key derivada por sessão/operação e persistida antes da chamada. Resposta de criação deve ser PENDING. Em timeout, reconcilia por GET antes de retornar. |
| getPaymentStatus(paymentId) | `Services.refresh` → paymentProvider → GET /transactions?external_reference=...&limit=100, com cursor quando necessário. Valida ID, referência, valor, moeda e estado. Não utiliza GET /transactions/{id}: há apenas menção no quickstart, sem contrato de resposta. |
| verifyWebhook(headers, body) | POST /api/webhooks/payment → Services.webhook → paymentProvider. HMAC-SHA256 de timestamp + ponto + Buffer bruto, headers BravoPay-Signature e X-Bravopay-Signature, timingSafeEqual e janela ±300s. Envelope e correlação validados antes da gravação. Webhook BravoPay não chama a API externa; processamento local curto. |
| refundPayment(paymentId, amount) | Contrato reservado no provider, sem rota pública e sem execução real. Reembolso sandbox por evento autenticado; API oficial e idempotência de reembolso aguardam documentação. |

`src/paymentProvider.js` seleciona o adaptador. `src/bravoPayProvider.js` é o único ponto que conhece a API BravoPay.
`src/config.js` lê BRAVOPAY_BASE_URL, BRAVOPAY_PUBLIC_KEY, BRAVOPAY_SECRET_KEY e BRAVOPAY_WEBHOOK_SECRET no servidor.
Nenhuma rota importa o adaptador BravoPay ou conhece seus headers, endpoints ou autenticação.
Erros externos, incluindo 400/401/403/404/409/422/429/500/502/503/504, são normalizados sem retornar payload, CPF, secrets ou stack trace ao navegador.
GET confirma PAID somente após resposta autenticada server-to-server validada; uma query string do navegador nunca define o estado.
Mapeamento: PENDING, PAID, FAILED, EXPIRED, REFUNDED mantêm seus nomes; CHARGEBACK → FAILED, preservando provider_status=CHARGEBACK.
transaction.receipt_uploaded e eventos withdrawal são ignorados após autenticação e jamais confirmam pagamento.
transaction.failed permanece pendente: seu data não está entre os payloads documentados.

### Limites constatados na revisão

- Migração somente aditiva em payments: provider, provider_payment_id UNIQUE por provider, amount_cents, created_at, payment_state, provider_status, idempotency_key, operation_state e instructions criptografadas. Mantém todas as linhas/constraints legadas.
- EXPIRED é exposto pelo payment_state aditivo e espelhado como FAILED nas colunas status legadas, sem reconstruir tabelas. webhook_events.id já é a chave UNIQUE que guarda exatamente o provider_event_id; não é necessário duplicar a coluna.
- CPF continua AES-256-GCM autenticado por contexto; logs registram apenas código fixo e horário, sem payload/segredo/CPF. Auditoria mantém apenas IDs, ações fixas e datas.
- Frontend envia tipo e dados cadastrais de teste; backend rejeita amount/status e decide o preço. URL, storage e PATCH não promovem PAID.
- Idempotência cobre tentativas com a mesma chave na mesma sessão. Uma nova chave representa nova solicitação; não se deduplica por CPF.
- Operações sandbox continuam síncronas. Em BravoPay, SUBMITTING é persistido antes do POST e nenhum lock SQLite permanece durante rede. Timeout, JSON inválido ou erro inconclusivo mantêm a operação para reconciliação. Retentativas da mesma chave consultam apenas GET, inclusive após restart e após o TTL de 24h da idempotência do fornecedor; nunca enviam novo POST automaticamente. Se a API não encontrar a cobrança, retorna PAYMENT_RECONCILIATION_PENDING para revisão/reconciliação posterior.
- O sistema rejeita múltiplas transações para a mesma external_reference. Outbox/fila institucional continua pendente; confirmação de pagamento não executa consulta/abertura oficial.
- Rate limit é por processo; reinício zera contadores. Limite distribuído, proxy confiável, armazenamento imutável de auditoria e rotação/retenção/backup ficam para o ambiente oficial.

Pendências: endpoint/contrato oficial de reembolso e payload de transaction.failed; credenciais reais e registro da URL do webhook;
asset oficial, endpoints/contratos/regras institucionais, implantação e autorização de produção.
A interface continua sendo o protótipo sandbox: apresentação de PIX real e textos de produção ficam para a etapa de ativação.
Nenhum teste de refund sucesso/duplicado foi declarado aprovado: sem endpoint documentado, testamos duas chamadas que falham explicitamente sem acesso à rede.

## Verificações

```sh
npm run quality:verify
npm run lint
npm test
npm run test:e2e
```

Sem build/typecheck: frontend estático e JavaScript nativo, sem bundler/TypeScript.
Testes de navegador usam Edge instalado; alternativamente instale Chromium com `npx playwright install chromium`
e remova `channel: 'msedge'` da configuração. O servidor E2E usa banco e segredos temporários.
Os testes cobrem desktop/celular, teclado e axe-core WCAG 2.1 AA; a avaliação humana de acessibilidade continua necessária.
Quality gates do vibe-coding-toolkit, origem registrada em scripts/quality-install-reference.md;
três arquivos .cjs preservados. MAX_LINES=350, includeTests=true. Arquivos upstream têm exceções próprias do toolkit.
no-direct-console nos fontes (scripts CLI liberados). Frontend bloqueia imports de Node/backend;
no-direct-data-access do toolkit não se aplica a HTML estático sem camada ORM na apresentação.
