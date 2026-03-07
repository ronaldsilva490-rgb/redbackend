# ⚡ QUICK REFERENCE: DATABASE & APIS

## 🗄️ Schema Overview (COMPLETE_SCHEMA.sql)

```
tenants (raiz)
├─ tenant_users (quem pode acessar)
├─ tenant_config (preferências)
├─ clients (clientes)
│  └─ transactions (pagamentos)
├─ categories (tipos de produto)
├─ products (itens)
│  └─ estoque_movimentacoes (histórico)
└─ transactions (receitas/despesas)
```

---

## 🔌 API Endpoints

### **Estoque** (`/api/inventory`)
| Method | Endpoint | Descrição |
|--------|----------|-----------|
| GET | `/movimentacoes` | Listar movimentações |
| POST | `/movimentar` | Registrar movimento |
| GET | `/estoque-baixo` | Produtos com estoque baixo |
| GET | `/resumo` | Total de estoque |

### **Finanças** (`/api/finance`)
| Method | Endpoint | Descrição |
|--------|----------|-----------|
| GET | `/transacoes` | Listar transações |
| POST | `/transacao` | Criar transação |
| PUT | `/transacao/:id` | Atualizar transação |
| POST | `/transacao/:id/pagar` | Marcar como pago |
| GET | `/relatorio` | Relatório período |
| GET | `/dashboard` | Dashboard rápido |

### **Clientes** (`/api/clients`)
| Method | Endpoint | Descrição |
|--------|----------|-----------|
| GET | `/` | Listar clientes |
| GET | `/:id` | Obter cliente |
| POST | `/` | Criar cliente |
| PUT | `/:id` | Atualizar cliente |
| PUT | `/:id/credito` | Atualizar limite crédito |
| POST | `/:id/desativar` | Desativar cliente |

### **Produtos** (`/api/products`)
| Method | Endpoint | Descrição |
|--------|----------|-----------|
| GET | `/` | Listar produtos |
| POST | `/` | Criar produto |
| PUT | `/:id` | Atualizar produto |

---

## 💾 Dados de Teste

### Criar Tenant
```python
POST /api/tenants/
{
  "slug": "rest-paulista",
  "nome": "Restaurante Paulista",
  "tipo": "restaurante",
  "cnpj": "10.123.456/0001-78",
  "email": "contato@rest.com"
}
```

### Criar Categoria
```python
POST /api/products/categories
{
  "tenant_id": "uuid-tenant",
  "nome": "Bebidas",
  "descricao": "Bebidas diversas"
}
```

### Criar Produto
```python
POST /api/products/
{
  "tenant_id": "uuid-tenant",
  "nome": "Refrigerante 2L",
  "sku": "REF001",
  "categoria_id": "uuid-cat",
  "preco_custo": 2.50,
  "preco_venda": 5.99,
  "estoque": 50,
  "estoque_minimo": 10,
  "unidade": "un",
  "ativo": true
}
```

### Criar Cliente
```python
POST /api/clients/
{
  "tenant_id": "uuid-tenant",
  "nome": "João Silva",
  "email": "joao@email.com",
  "telefone": "11999999999",
  "cpf_cnpj": "123.456.789-10",
  "grupo_cliente": "VIP",
  "limite_credito": 1000.00,
  "dias_pagamento": 30
}
```

### Vender Produto (Estoque + Transação)
```python
# 1. Movimentar estoque
POST /api/inventory/movimentar
{
  "tenant_id": "uuid-tenant",
  "produto_id": "uuid-produto",
  "tipo": "saida",
  "quantidade": 1,
  "motivo": "Venda balcão",
  "referencia_tipo": "venda",
  "referencia_id": "venda-uuid"
}

# 2. Registrar receita
POST /api/finance/transacao
{
  "tenant_id": "uuid-tenant",
  "tipo": "receita",
  "categoria": "Vendas",
  "descricao": "Venda Refrigerante",
  "valor": 5.99,
  "pago": true,
  "referencia_tipo": "venda",
  "referencia_id": "venda-uuid"
}
```

---

## 📊 Queries Úteis (SQL)

### Estoque por Produto
```sql
SELECT nome, estoque, estoque_minimo, 
       preco_venda * estoque as valor_estoque
FROM products
WHERE tenant_id = 'uuid'
ORDER BY valor_estoque DESC;
```

### Receita Diária
```sql
SELECT DATE(data_criacao) as data, SUM(valor) as receita
FROM transactions
WHERE tenant_id = 'uuid' AND tipo = 'receita'
GROUP BY DATE(data_criacao)
ORDER BY data DESC;
```

### Top Clientes
```sql
SELECT c.nome, COUNT(t.id) as compras, SUM(t.valor) as total
FROM clients c
LEFT JOIN transactions t ON t.referencia_id = c.id
WHERE c.tenant_id = 'uuid'
GROUP BY c.id, c.nome
ORDER BY total DESC
LIMIT 10;
```

### Produtos Mais Vendidos
```sql
SELECT p.nome, SUM(em.quantidade) as vendido
FROM estoque_movimentacoes em
JOIN products p ON p.id = em.produto_id
WHERE em.tenant_id = 'uuid' AND em.tipo = 'saida'
GROUP BY p.id, p.nome
ORDER BY vendido DESC;
```

---

## 🔐 Headers Necessários

Todas as requisições devem incluir:

```
Authorization: Bearer seu_jwt_token
Content-Type: application/json
```

Token obtido em:
```bash
POST /api/auth/login
{
  "username": "seu_user",
  "password": "sua_senha"
}
```

---

## 🎯 Fluxos Comuns

### **Fluxo: Venda com Múltiplos Itens**
```
1. Obter produtos (GET /api/products/)
2. Para cada item:
   a. POST /api/inventory/movimentar (saida)
3. POST /api/finance/transacao (receita)
4. GET /api/finance/dashboard (atualizar UI)
```

### **Fluxo: Compra de Fornecedor**
```
1. POST /api/finance/transacao (despesa)
2. POST /api/inventory/movimentar (entrada)
3. Quando receber NF: verifica dados
4. Quando pagar: POST /api/finance/transacao/:id/pagar
```

### **Fluxo: Devolução de Cliente**
```
1. POST /api/finance/transacao (receita, valor negativo)
2. POST /api/inventory/movimentar (devolucao)
3. Atualizar cliente com novo saldo
```

---

## ⚙️ Configurações por Tipo de Negócio

### **Restaurante**
```json
{
  "tempo_preparacao_min": 15,
  "impressora_cozinha": "IP_PRINTER",
  "mostrar_estoque": false,
  "permitir_estoque_negativo": false,
  "campos_customizados": {
    "alergia": true,
    "mesa": true,
    "observacoes": true
  }
}
```

### **Farmácia**
```json
{
  "exigir_nota_fiscal": true,
  "controle_medicamentos": true,
  "campos_customizados": {
    "receita_necessaria": true,
    "tarja": true,
    "principio_ativo": true
  }
}
```

### **Comércio (Varejo)**
```json
{
  "codigo_barras": true,
  "permitir_estoque_negativo": false,
  "campos_customizados": {
    "tamanho": true,
    "cor": true,
    "marca": true
  }
}
```

---

## 🔍 Debugging

### Ver Logs de Movimentação
```bash
GET /api/inventory/movimentacoes?tenant_id=uuid&produto_id=uuid
```

### Ver Transações Pendentes
```bash
GET /api/finance/transacoes?tenant_id=uuid&pago=false
```

### Verificar Estoque Baixo
```bash
GET /api/inventory/estoque-baixo?tenant_id=uuid
```

---

## 📈 Performance Tips

1. **Sempre filtrar por tenant_id** - Reduz dados retornados
2. **Use limit/offset** - GET com 100 registros por padrão
3. **Índices automáticos** - Já aplicados via COMPLETE_SCHEMA.sql
4. **Cache de categorias** - Categorias mudam pouco, cache em frontend

---

**Arquivo**: [COMPLETE_SCHEMA.sql](../COMPLETE_SCHEMA.sql)  
**Documentação**: [TAREFA_7_SCHEMA.md](../TAREFA_7_SCHEMA.md)  
**Status**: ✅ Pronto para usar
