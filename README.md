# Inventário Móvel

Sistema web para controle das linhas móveis da empresa e análise de consumo das faturas.

- **Front:** React + Vite (SPA) — `src/`
- **API:** Netlify Functions (TypeScript) em `/api/*` — `netlify/`
- **Banco:** Neon (PostgreSQL) — `db/schema.sql`
- **Auth:** senha + código MFA por e-mail (SMTP) → JWT (HS256, 8 h) em cookie `HttpOnly; Secure; SameSite=Strict`

## Perfis

| Perfil | Pode |
|---|---|
| Administrador | Tudo: cadastrar/editar/excluir linhas, importar CSV, gerenciar usuários, subir faturas e consultar consumo |
| Equipe | Ver as linhas e alterar **somente** o usuário e a data de entrega |

Cada linha tem um único usuário (campo "Usuário"; vazio = linha livre) e o número da conta da operadora. Toda alteração fica no histórico da linha e na **Auditoria** (somente administradores).

## Consumo

Em **Consumo** o administrador sobe a fatura (PDF, CSV ou XLSX, até ~4 MB). O sistema mostra uma prévia
(com a opção de ajustar as colunas em CSV/XLSX), o admin confirma operadora, número da conta e mês de referência (uma fatura por operadora, conta e mês) e o consumo
por linha (voz em minutos, dados em MB, valor) é gravado. Cada linha guarda quem era o usuário/projeto
**naquele mês**. A consulta é por período, operadora e projeto, com detalhamento mensal por linha e exportação CSV.

> Leitura de PDF é heurística (os layouts variam por operadora). Prefira o detalhamento em CSV/XLSX quando
> disponível e sempre confira a prévia antes de salvar. PDFs com mais de 500 páginas são recusados: use o
> CSV/XLSX exportado do portal da operadora. Valores ilegíveis ou fora de faixa bloqueiam o salvamento.

## Rodando localmente

```bash
npm install
cp .env.example .env      # preencha DATABASE_URL, JWT_SECRET, ADMIN_PASSWORD...
npm run migrate           # cria as tabelas e o primeiro admin
npm run dev               # netlify dev: front + functions em http://localhost:8888
```

Para validar o SMTP: `npm run mail:test -- destino@exemplo.com`.

Em `netlify dev` sem SMTP/Resend configurado, o código MFA é impresso no terminal.

```bash
npm test                  # parser + API completa contra um Postgres em memória (PGlite)
npm run build             # typecheck + build de produção
```

## Variáveis de ambiente (Netlify → Site configuration → Environment variables)

| Variável | Descrição |
|---|---|
| `DATABASE_URL` | Connection string do Neon |
| `JWT_SECRET` | ≥ 32 caracteres aleatórios |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS` | Servidor SMTP que envia o código MFA (porta 587 = STARTTLS, 465 = TLS) |
| `MAIL_FROM` | Remetente, ex.: `Inventário Móvel <usuario@seudominio.com.br>` |
| `RESEND_API_KEY` | Opcional: alternativa ao SMTP |
| `ALLOWED_EMAIL_DOMAINS` | Domínios de e-mail aceitos ao criar usuários (padrão `rttshop.com.br`) |

**Escopo no Netlify:** deixe `DATABASE_URL`, `JWT_SECRET`, `SMTP_USER` e `SMTP_PASS` disponíveis apenas para *Functions* e *Runtime*; o build não precisa deles.

## Segurança

- Senhas com bcrypt (custo 12); 10 a 72 bytes; senhas comuns são recusadas; usuários novos trocam a senha temporária no 1º acesso.
- Limite de tentativas atômico (por IP, por e-mail+IP e por conta) com resposta idêntica para conta existente ou não; falhas de MFA são cumulativas; no máximo 10 e-mails de código por hora por usuário.
- Sessões revogáveis (`token_version`): logout, troca/reset de senha, desativação e mudança de papel encerram sessões antigas.
- Criar usuário e mudar papel/status/senha exigem a senha do administrador; sempre resta um administrador ativo (gatilho no banco).
- Trilha de auditoria somente de inserção (`audit_log`), que sobrevive à exclusão de dados.
- CSRF: `SameSite=Strict` + cabeçalho `X-Requested-With` + Fetch Metadata; exportação CSV neutraliza fórmulas.
- Cabeçalhos de segurança e CSP (sem `unsafe-inline`) em `netlify.toml` e nas respostas da API.
- CI em `.github/workflows/ci.yml` (tipos, testes, build e `npm audit` informativo), sem ações de terceiros.

### Atualizando um banco existente

As mudanças de esquema são idempotentes. **Antes de publicar uma nova versão**, rode `npm run migrate` apontando para o banco
(ele cria `rate_limits`, `audit_log`, `users.token_version`, `invoices.account`, o gatilho de administrador e o índice único de faturas).
As sessões ativas são encerradas na troca de versão (todos entram de novo).

### Publicando

`npx netlify-cli@27.11.2 deploy --build --prod` (a ferramenta não é mais dependência do projeto; fixe a versão).
