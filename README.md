# Inventário Móvel

Sistema web para controle das linhas móveis da empresa e análise de consumo das faturas.

- **Front:** React + Vite (SPA) — `src/`
- **API:** Netlify Functions (TypeScript) em `/api/*` — `netlify/`
- **Banco:** Neon (PostgreSQL) — `db/schema.sql`
- **Auth:** senha + código MFA por e-mail (Resend) → JWT (HS256, 8 h) em cookie `HttpOnly; Secure; SameSite=Strict`

## Perfis

| Perfil | Pode |
|---|---|
| Administrador | Tudo: cadastrar/editar/excluir linhas, importar CSV, gerenciar usuários, subir faturas e consultar consumo |
| Equipe | Ver as linhas e alterar **somente** o usuário e a data de entrega |

Cada linha tem um único usuário (campo "Usuário"; vazio = linha livre). Toda alteração fica no histórico da linha.

## Consumo

Em **Consumo** o administrador sobe a fatura (PDF, CSV ou XLSX, até ~4 MB). O sistema mostra uma prévia
(com a opção de ajustar as colunas em CSV/XLSX), o admin confirma operadora e mês de referência e o consumo
por linha (voz em minutos, dados em MB, valor) é gravado. Cada linha guarda quem era o usuário/projeto
**naquele mês**. A consulta é por período, operadora e projeto, com detalhamento mensal por linha e exportação CSV.

> Leitura de PDF é heurística (os layouts variam por operadora). Prefira o detalhamento em CSV/XLSX quando
> disponível e sempre confira a prévia antes de salvar.

## Rodando localmente

```bash
npm install
cp .env.example .env      # preencha DATABASE_URL, JWT_SECRET, ADMIN_PASSWORD...
npm run migrate           # cria as tabelas e o primeiro admin
npm run dev               # netlify dev: front + functions em http://localhost:8888
```

Em `netlify dev` sem `RESEND_API_KEY`, o código MFA é impresso no terminal.

```bash
npm test                  # parser + API completa contra um Postgres em memória (PGlite)
npm run build             # typecheck + build de produção
```

## Variáveis de ambiente (Netlify → Site configuration → Environment variables)

| Variável | Descrição |
|---|---|
| `DATABASE_URL` | Connection string do Neon |
| `JWT_SECRET` | ≥ 32 caracteres aleatórios |
| `RESEND_API_KEY` | API key do Resend |
| `MAIL_FROM` | Remetente, ex.: `Inventário Móvel <no-reply@seudominio.com.br>` (domínio verificado no Resend) |

## Segurança

- Senhas com bcrypt (custo 12); mínimo de 10 caracteres; usuários novos trocam a senha temporária no 1º acesso.
- Bloqueio de 15 min após 5 senhas erradas; código MFA expira em 10 min e invalida após 5 tentativas.
- Permissões sempre validadas no servidor; desativar um usuário derruba a sessão dele imediatamente.
- Cabeçalhos de segurança e CSP em `netlify.toml`.
