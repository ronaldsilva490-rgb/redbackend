# GUIA DE OPERAÇÃO — RED Backend no Fly.io
## Como deployar, editar código e operar a partir de agora

---

## 1. ENTENDENDO A NOVA ARQUITETURA

```
ANTES (HuggingFace):
  Você editava na página "Files" do HF Space → ele reiniciava sozinho

AGORA (Fly.io + GitHub):
  Você (ou a IA) edita no GitHub → GitHub Action roda → Fly.io atualiza
```

**Dois repositórios no GitHub:**
| Repo | Hospedagem | URL |
|---|---|---|
| `ronaldsilva490-rgb/redbackend` | Fly.io | https://redbackend.fly.dev |
| `seu-usuario/seu-frontend` | Vercel | https://redcomercialweb.vercel.app |

---

## 2. SETUP INICIAL (faça UMA vez)

### Passo 1 — Adicionar o FLY_API_TOKEN no GitHub

```bash
# No terminal, gere o token do Fly.io:
fly tokens create deploy -x 999999h
```

Copie o token gerado. Depois:

1. Abra: https://github.com/ronaldsilva490-rgb/redbackend/settings/secrets/actions
2. Clique **New repository secret**
3. Nome: `FLY_API_TOKEN`
4. Valor: cole o token gerado
5. Salve

### Passo 2 — Confirmar que o arquivo fly-deploy.yml está no repo

O arquivo `.github/workflows/fly-deploy.yml` já está incluído no zip.
Faça upload dele junto com o resto do projeto no GitHub.

### Passo 3 — Adicionar variáveis de ambiente no Fly.io

No terminal (ou no dashboard fly.io/apps/redbackend):

```bash
fly secrets set SUPABASE_URL="https://xxxx.supabase.co"
fly secrets set SUPABASE_KEY="eyJ..."
fly secrets set SUPABASE_SERVICE_KEY="eyJ..."
fly secrets set SUPABASE_JWT_SECRET="seu-jwt-secret"
fly secrets set SECRET_KEY="sua-chave-segura"
fly secrets set SUPERADMIN_EMAIL="seu@email.com"
fly secrets set SUPERADMIN_SECRET="token-longo-secreto"
fly secrets set GITHUB_TOKEN="ghp_..."
fly secrets set GITHUB_REPO="usuario/repo-frontend"
fly secrets set GITHUB_BACKEND_REPO="ronaldsilva490-rgb/redbackend"
fly secrets set VERCEL_TOKEN="..."
fly secrets set VERCEL_PROJECT_ID="prj_..."
fly secrets set FLY_API_TOKEN="FlyV1_..."
fly secrets set FLY_APP_NAME="redbackend"
fly secrets set FLY_URL="https://redbackend.fly.dev"
fly secrets set FRONTEND_URL="https://redcomercialweb.vercel.app"
```

---

## 3. COMO VOCÊ FAZ DEPLOY AGORA

### Método 1 — Via GitHub (recomendado)

```
1. Edite qualquer arquivo no repo do GitHub
2. Commit + push na branch main
3. A GitHub Action detecta o push
4. Roda: flyctl deploy --remote-only
5. Fly.io atualiza em ~60 segundos
```

Para acompanhar o deploy:
- GitHub: https://github.com/ronaldsilva490-rgb/redbackend/actions
- Fly.io: https://fly.io/apps/redbackend

### Método 2 — Via terminal local (flyctl)

```bash
# Instalar o flyctl (se não tiver):
curl -L https://fly.io/install.sh | sh

# Login:
fly auth login

# Deploy direto:
fly deploy
```

### Método 3 — Via Superadmin (DeployControl)

O painel DeployControl do Superadmin tem o botão **"Status GitHub Backend"**
que mostra os últimos commits, e **"Status Fly.io"** que mostra as machines.

> ⚠️ O botão "Git Pull" agora apenas explica que no Fly.io o deploy é automático via GitHub.
> Não tente fazer git pull diretamente — não funciona assim no Fly.io.

---

## 4. COMO O AI AGENT FAZ DEPLOY

O AI Agent (na aba AIAgent do Superadmin) agora funciona assim:

```
EDITAR BACKEND:
  IA usa list_files("backend/")    → lista arquivos do repo redbackend
  IA usa read_file("backend/app/routes/auth.py")  → lê o arquivo
  IA usa patch_file("backend/app/routes/auth.py", old_str, new_str)
         → commita no GitHub
         → GitHub Action dispara automaticamente
         → Fly.io faz deploy em ~60s

EDITAR FRONTEND:
  IA usa list_files("src/")        → lista arquivos do repo frontend
  IA usa read_file("src/App.jsx")  → lê o arquivo
  IA usa patch_file("src/App.jsx", old_str, new_str)
         → commita no GitHub
         → Vercel redeploya automaticamente
```

### Exemplos de comandos para o AI Agent:

```
"Adicione validação de CPF no endpoint /api/clients"
→ IA lê backend/app/routes/clients.py, faz o patch, commita

"Mude a cor primária do sidebar para azul"
→ IA lê src/index.css, faz o patch, commita

"Liste os últimos erros no banco de tenants"
→ IA usa run_sql("SELECT * FROM tenants WHERE ativo=false")
```

---

## 5. DIFERENÇAS IMPORTANTES vs HuggingFace

| HuggingFace | Fly.io |
|---|---|
| Editava arquivos na página web do HF | Commita no GitHub → deploy automático |
| Deploy em ~30s após editar | Deploy em ~60s após commit |
| Reiniciava ao commitar (matava SSE) | Não tem esse problema — deploy via Action |
| HF_TOKEN + HF_SPACE | FLY_API_TOKEN + GITHUB_BACKEND_REPO |
| Arquivos do backend eram "do Space" | Arquivos do backend são do repo GitHub |

---

## 6. VARIÁVEIS DE AMBIENTE — RESUMO

### No Fly.io (fly secrets set ...)
Todas as variáveis sensíveis do backend: SUPABASE_*, SECRET_KEY, tokens, etc.

### No GitHub (Settings > Secrets > Actions)
Apenas: `FLY_API_TOKEN` (para a GitHub Action poder fazer o deploy)

### Na Vercel (Settings > Environment Variables)
Apenas: `VITE_API_URL=https://redbackend.fly.dev`

---

## 7. MONITORAMENTO

```bash
# Ver logs em tempo real:
fly logs --app redbackend

# Ver status das machines:
fly status --app redbackend

# SSH na machine (emergência):
fly ssh console --app redbackend

# Escalar memória se precisar:
fly scale memory 512 --app redbackend
```

---

## 8. CHECKLIST DE VERIFICAÇÃO

Após fazer o setup inicial, verifique:

- [ ] `FLY_API_TOKEN` adicionado nos Secrets do GitHub
- [ ] `.github/workflows/fly-deploy.yml` no repositório
- [ ] Todos os `fly secrets set ...` configurados
- [ ] `VITE_API_URL=https://redbackend.fly.dev` na Vercel
- [ ] `GITHUB_BACKEND_REPO=ronaldsilva490-rgb/redbackend` no Fly secrets
- [ ] Backend respondendo em: https://redbackend.fly.dev/
- [ ] Superadmin → SystemStatus mostrando todos os serviços verdes
- [ ] Superadmin → AIAgent → clicar "Testar Backend" retornando OK

---

## 9. FLUXO RESUMIDO (cola no seu bloco de notas)

```
VOCÊ QUER EDITAR O BACKEND:
  → Edite no GitHub (site ou VSCode) → push na main
  → OU peça para o AI Agent no Superadmin
  → Aguarde ~60s → deploy automático no Fly.io

VOCÊ QUER EDITAR O FRONTEND:
  → Edite no GitHub (site ou VSCode) → push na main
  → OU peça para o AI Agent no Superadmin
  → Vercel redeploya em ~30s

ALGO DEU ERRADO NO DEPLOY:
  → Cheque: github.com/ronaldsilva490-rgb/redbackend/actions
  → Cheque: fly.io/apps/redbackend (aba Monitoring > Logs)
  → fly logs --app redbackend
```
