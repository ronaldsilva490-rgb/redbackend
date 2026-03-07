# 🚀 INSTRUÇÕES DE EXECUÇÃO - TAREFA 7

## 📋 Pré-Requisitos
- ✅ Acesso ao Supabase (projeto RED)
- ✅ PostgreSQL 12+ (via Supabase)
- ✅ Python 3.8+ (backend)
- ✅ Flask 3.0.3+ (já instalado)

---

## ⚡ PASSO 1: Executar Schema no Supabase (5 minutos)

### 1.1 Abrir Supabase
```
1. Navegue para: https://app.supabase.com
2. Faça login com suas credenciais
3. Selecione projeto "red-commercial" ou similar
```

### 1.2 Acessar SQL Editor
```
1. No menu lateral esquerdo, procure "SQL Editor"
2. Clique em "New query" ou "+"
3. Uma nova abra va se abrir
```

### 1.3 Copiar SQL
```
1. Abra arquivo: COMPLETE_SCHEMA.sql
   Localização: C:\Users\Ronyd\Documents\myrepos\backend\redbackend\COMPLETE_SCHEMA.sql

2. Selecione TODO o conteúdo (Ctrl+A)

3. Copie (Ctrl+C)

4. Cole no SQL Editor do Supabase (Ctrl+V)
```

### 1.4 Executar
```
1. Clique no botão "Run" ou pressione Ctrl+Enter
2. Aguarde 10-30 segundos
3. Verá mensagem: "Query executed successfully"
```

### ✅ Validação
```sql
-- No mesmo SQL Editor, copie e execute:

SELECT tablename FROM pg_tables 
WHERE schemaname = 'public' 
ORDER BY tablename;
```

**Resultado esperado:**
```
categories
clients
estoque_movimentacoes
products
tenant_config
tenant_users
tenants
transactions
```

---

## ⚡ PASSO 2: Verificar Estrutura (2 minutos)

### 2.1 Verificar Índices
```sql
SELECT indexname FROM pg_indexes 
WHERE schemaname = 'public' 
ORDER BY indexname LIMIT 10;
```

**Resultado esperado:** 8+ índices criados

### 2.2 Verificar Views
```sql
SELECT viewname FROM pg_views 
WHERE schemaname = 'public' 
ORDER BY viewname;
```

**Resultado esperado:**
```
clientes_inadimplentes
produtos_estoque_baixo
```

### 2.3 Verificar Funções
```sql
SELECT routine_name FROM information_schema.routines 
WHERE routine_schema = 'public' 
ORDER BY routine_name;
```

**Resultado esperado:** update_updated_at (função) + triggers

---

## ⚡ PASSO 3: Criar Dados de Teste (10 minutos)

### 3.1 Inserir Tenant (Restaurante)
```sql
INSERT INTO tenants (
  slug, 
  nome, 
  tipo, 
  cnpj, 
  email, 
  telefone,
  cidade,
  estado,
  ativo
) VALUES (
  'rest-exemplo',
  'Restaurante Exemplo', 
  'restaurante',
  '10.123.456/0001-78',
  'contato@rest.com.br',
  '11 99999-9999',
  'São Paulo',
  'SP',
  true
);
```

**✅ Resultado:** 1 tenant criado

### 3.2 Criar Categorias
```sql
INSERT INTO categories (
  tenant_id, 
  nome, 
  descricao,
  ativo
) VALUES 
  ((SELECT id FROM tenants WHERE slug = 'rest-exemplo'), 'Bebidas', 'Bebidas diversas', true),
  ((SELECT id FROM tenants WHERE slug = 'rest-exemplo'), 'Pratos Principais', 'Prato do dia', true),
  ((SELECT id FROM tenants WHERE slug = 'rest-exemplo'), 'Sobremesas', 'Doces', true);
```

### 3.3 Inserir Produtos
```sql
INSERT INTO products (
  tenant_id,
  nome,
  sku,
  categoria_id,
  preco_custo,
  preco_venda,
  estoque,
  estoque_minimo,
  unidade,
  ativo
) VALUES (
  (SELECT id FROM tenants WHERE slug = 'rest-exemplo'),
  'Refrigerante 2L',
  'REF-001',
  (SELECT id FROM categories WHERE nome = 'Bebidas' LIMIT 1),
  2.50,
  5.99,
  50,
  10,
  'un',
  true
);
```

### 3.4 Inserir Clientes
```sql
INSERT INTO clients (
  tenant_id,
  nome,
  email,
  telefone,
  cpf_cnpj,
  grupo_cliente,
  limite_credito,
  dias_pagamento,
  ativo
) VALUES (
  (SELECT id FROM tenants WHERE slug = 'rest-exemplo'),
  'João Silva',
  'joao@email.com',
  '11 9 8765-4321',
  '123.456.789-10',
  'VIP',
  1000.00,
  30,
  true
);
```

**✅ Resultado:** Dados de teste prontos

---

## ⚡ PASSO 4: Testar Backend (15 minutos)

### 4.1 Iniciar servidor
```bash
# Terminal na pasta backend
cd C:\Users\Ronyd\Documents\myrepos\backend\redbackend

# Ativar virtual env (se tiver)
# . venv/Scripts/activate  (Windows)

# Iniciar Flask
python main.py
# ou
flask run
```

**Esperado:**
```
 * Running on http://127.0.0.1:5000
 * Press CTRL+C to quit
```

### 4.2 Obter Token (necessário para testes)
```bash
curl -X POST http://localhost:5000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{
    "username": "seu_usuario",
    "password": "sua_senha"
  }'
```

**Resposta esperada:**
```json
{
  "token": "eyJhbGc....",
  "user": { "id": "...", "username": "..." }
}
```

**Salve o token em uma variável:**
```bash
# Salve o token aqui
TOKEN="eyJhbGc...."
```

### 4.3 Testar Endpoint de Estoque
```bash
curl -X GET "http://localhost:5000/api/inventory/resumo?tenant_id=TENANT_UUID" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json"
```

**Resposta esperada:**
```json
{
  "sucesso": true,
  "total_itens": 50,
  "valor_total": 299.50,
  "produtos_ativos": 1,
  "produtos_estoque_baixo": 0
}
```

### 4.4 Testar Endpoint de Finanças
```bash
curl -X GET "http://localhost:5000/api/finance/dashboard?tenant_id=TENANT_UUID" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json"
```

**Resposta esperada:**
```json
{
  "sucesso": true,
  "metricas": {
    "receita_hoje": 0,
    "receita_mes": 0,
    "contas_vencer": 0,
    "contas_vencidas": 0
  }
}
```

---

## ⚡ PASSO 5: Testar com Postman (10 minutos)

### 5.1 Importar Collection
```
1. Abra Postman
2. File → Import
3. Cole a URL: (ou importe manualmente os endpoints)
```

### 5.2 Criar Requisição: Listar Estoque Baixo
```
Method: GET
URL: http://localhost:5000/api/inventory/estoque-baixo
Params:
  tenant_id: (copie o UUID da seu tenant)
Headers:
  Authorization: Bearer $TOKEN
  Content-Type: application/json
```

Click "Send"

### 5.3 Criar Requisição: Registrar Movimentação
```
Method: POST
URL: http://localhost:5000/api/inventory/movimentar
Body (JSON):
{
  "tenant_id": "uuid-tenant",
  "produto_id": "uuid-produto",
  "tipo": "saida",
  "quantidade": 1,
  "motivo": "Venda PDV",
  "referencia_tipo": "venda"
}
Headers:
  Authorization: Bearer $TOKEN
  Content-Type: application/json
```

Click "Send"

---

## ⚡ PASSO 6: Verificar Dados (5 minutos)

### 6.1 Voltar ao Supabase
```
1. Abra SQL Editor novamente
2. Execute queries para verificar dados
```

### 6.2 Verificar Movimentações Registradas
```sql
SELECT * FROM estoque_movimentacoes 
WHERE tenant_id = (SELECT id FROM tenants WHERE slug = 'rest-exemplo')
ORDER BY criado_em DESC
LIMIT 5;
```

### 6.3 Verificar Produtos com Estoque Baixo
```sql
SELECT * FROM produtos_estoque_baixo 
WHERE tenant_id = (SELECT id FROM tenants WHERE slug = 'rest-exemplo');
```

---

## 📋 Troubleshooting

### Erro: "Table 'tenants' does not exist"
```
✗ Schema não foi executado no Supabase
✓ Volte ao PASSO 1 e execute COMPLETE_SCHEMA.sql
```

### Erro: "Unauthorized" (401) nos endpoints
```
✗ Token JWT inválido ou expirado
✓ Obtenha novo token em /api/auth/login
✓ Inclua "Authorization: Bearer TOKEN" no header
```

### Erro: "Tenant not found" ao criar estoque
```
✗ tenant_id inválido
✓ Monte um valid UUID:
   SELECT id FROM tenants LIMIT 1;
```

### Erro: "Foreign key violation"
```
✗ Produto não existe para o tenant
✓ Crie um produto primeiro em 3.3
```

---

## 🎯 Checklist Final

- [ ] COMPLETE_SCHEMA.sql executado no Supabase
- [ ] 8 tabelas criadas (verificar com SELECT * FROM pg_tables)
- [ ] 2 views criadas (produtos_estoque_baixo, clientes_inadimplentes)
- [ ] Tenant de teste criado
- [ ] Categorias inseridas
- [ ] Produtos inseridos
- [ ] Clientes criados
- [ ] Backend Flask iniciado
- [ ] Token JWT obtido
- [ ] Endpoint /api/inventory/resumo respondendo ✓
- [ ] Endpoint /api/finance/dashboard respondendo ✓
- [ ] Movimentação registrada com sucesso
- [ ] Dados aparecem no Supabase

---

## 🚀 Próximos Passos

Após completar este guia:

1. **Manter estrutura funcionando** - Use diariamente para testar
2. **Iniciar TAREFA 8** - LocalStorage → Database migration
3. **Implementar RLS** - Row Level Security policies
4. **Criar testes** - Unit tests para database.py

---

## 📞 Dúvidas?

Se algo não funcionar:
1. Verificar os logs do backend (`python main.py` mostra erros)
2. Verificar Supabase Status (https://status.supabase.com)
3. Validar JWT token gerado corretamente
4. Confirmar tenant_id está no formato UUID correto

---

**Tempo Total Estimado**: 45-60 minutos  
**Dificuldade**: ⭐⭐ (Intermediário)  
**Status**: ✅ Guia Completo

