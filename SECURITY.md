# 🔐 Segurança - Credenciais e Variáveis de Ambiente

## ⚠️ Nunca cometa credenciais no Git!

Se uma chave for exposta no repositório público:

1. **OpenRouter revogará automaticamente** a chave (por segurança)
2. **GitHub alertará** sobre a exposição
3. **Qualquer pessoa** pode acessar seus recursos

## ✅ Como configurar corretamente:

### Backend (Flask)

1. Crie um arquivo `.env` **NA RAIZ DO PROJETO** (não committar):

```bash
# .env (NUNCA fazer commit!)
OPENROUTER_KEY=sk-or-v1-sua-chave-aqui
SUPABASE_URL=https://...
SUPABASE_KEY=...
```

2. O arquivo `.gitignore` protege:
```
.env
.env.local
```

3. Use em `config.py`:
```python
OPENROUTER_KEY = os.getenv("OPENROUTER_KEY")
```

### Frontend (React/Vite)

1. Crie `.env.local`:
```bash
VITE_API_URL=https://redbackend.fly.dev
# Nunca armazene chaves aqui!
```

2. Use em components:
```javascript
const API_URL = import.meta.env.VITE_API_URL;
```

**⚠️ IMPORTANT**: Nunca armazene credenciais sensíveis no frontend! São sempre visíveis ao usuário!

## 🚀 Deploy no Fly.io

As variáveis são configuradas via `flyctl`:

```bash
# Adicionar secret
flyctl secrets set OPENROUTER_KEY=sk-or-v1-...

# Listar secrets
flyctl secrets list

# Remover secret
flyctl secrets unset OPENROUTER_KEY
```

## 🔍 Se uma chave vazar:

1. ⚠️ **Revogue imediatamente** no painel do serviço
2. ✅ **Gere uma nova chave**
3. ✅ **Atualize** em `.env` e `flyctl secrets set ...`
4. ✅ **Commit** o `.gitignore` atualizado para evitar futuras exposições

---

**Última atualização**: Mar 7, 2026
