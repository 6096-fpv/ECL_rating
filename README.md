# ECL_rating

Avaliação de professores da Escola de Comércio de Lisboa — notas de clareza, apoio e justiça, comentários dos alunos e fórum da comunidade.

## O que existe

| Página | Descrição |
| --- | --- |
| `index.html` | Lista de professores com busca e filtro por função |
| `top.html` | Ranking (mínimo 3 avaliações para pontuar) |
| `forum.html` | Fórum: tópicos, comunidades, notificações |
| `teacher.html?id=N` | Perfil de um professor, histograma e avaliações |
| `perfil.html?id=U` | Perfil público de um utilizador |
| `auth.html` | Login / registo |
| `conta.html` | Conta do utilizador (papel, país, editar publicações) |
| `admin.html` | Painel de moderação (docentes, fórum, utilizadores, registo) |

## Stack

- **Frontend**: HTML + CSS + JavaScript puro (sem build). Runtime partilhado em `app.js` ( Supabase client, helpers, tema, notificações, cache).
- **Backend**: Supabase (Postgres + RPCs). O schema inteiro está em `setup.sql` (não versionado por segurança — ver `SECURITY.md`).
- **QA**: `qa/gate.mjs` — gate visual/funcional via puppeteer-core (dark + light). CI no GitHub Actions (`.github/workflows`).

## Deploy

O site é estático. Qualquer host que sirva os ficheiros na raiz funciona (GitHub Pages, Netlify, etc.). O `404.html` na raiz é usado pelo GitHub Pages para páginas em falta.

## Configurar

1. Cria um projecto Supabase.
2. Corre o `setup.sql` no editor SQL do Supabase (idempotente).
3. Coloca a URL e a anon key em `app.js` (constant `SUPABASE_URL` / `SUPABASE_KEY`).

Sem passo 2–3 o site mostra o aviso de configuração em falta.

## Desenvolvimento

```bash
# gate visual (usa fixtures locais + Chrome headless)
cd qa
node make-fixtures.mjs   # regenera fixtures depois de alterar qualquer .html/.js/.css
node gate.mjs            # dark
$env:ECL_THEME="light"; node gate.mjs   # light (PowerShell)

# verificações SQL (usa embedded-postgres)
cd qa/sql
node smoke.mjs
```

Regras da casa (resumidas):

- Textos do site em **português de Portugal**.
- Sem `alert`/`confirm`/`prompt` nativos — usar `ECL.askConfirm` / `ECL.toast`.
- Sem gradientes, blur nem cantos arredondados além de 6–10px do design system (`style.css`).
- Toda a feature nova precisa de checks no gate e gate verde nos dois temas antes do commit.

## Licença / segurança

Modelo de ameaças e decisões em [`SECURITY.md`](SECURITY.md).
