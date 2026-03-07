# TAREFA 7: Schema do Banco de Dados - Guia Completo

## 📊 Resumo das Mudanças

Este arquivo documenta a **reestruturação completa do schema do banco de dados** para suportar uma arquitetura multi-tenant escalável, com suporte a 12+ tipos de negócio.

### Status
- **Status**: Pronta para execução
- **Arquivo SQL**: `COMPLETE_SCHEMA.sql`
- **Compatibilidade**: PostgreSQL 12+ (Supabase)
- **Tabelas**: 9 novas + referências às existentes

---

## 🏗️ Arquitetura do Schema

### Camadas de Dados

```
┌───────────────────────────────────────────────────────┐
│              CAMADA ADMINISTRATIVA                     │
│  (admin_users, admin_logs, system_metrics, etc)       │
└───────────────────────────────────────────────────────┘
           ↓             ↓             ↓
┌──────────────────────────────────────────────────────┐
│           CAMADA MULTI-TENANT (tenants)              │
│  - Empresa e suas configurações                       │
│  - Isolamento completo de dados                       │
└──────────────────────────────────────────────────────┘
           ↓             ↓             ↓
┌──────────────┬──────────────┬──────────────────────┐
│  OPERACIONAL │   FINANCEIRO │   ESTOQUE & PRODUTOS │
├──────────────┼──────────────┼──────────────────────┤
│ • Vendas     │ • Transações │ • Produtos           │
│ • Pedidos    │ • Pagamentos │ • Categories         │
│ • Clientes   │ • Faturas    │ • Movimentações      │
└──────────────┴──────────────┴──────────────────────┘
```

---

## 📋 Tabelas Criadas

### 1. **tenants** - Empresas/Negócios
Tabela principal que representa cada negócio no sistema.

```sql
CREATE TABLE tenants (
  id UUID PRIMARY KEY,
  slug TEXT UNIQUE,                    -- URL-friendly identifier
  nome TEXT NOT NULL,                  -- Nome da empresa
  tipo TEXT NOT NULL,                  -- Tipo de negócio
  cnpj VARCHAR(18) UNIQUE,            -- Registro fiscal
  ...
)
```

**Campos Principais**:
- `slug`: Identificador único para URL (ex: `meu-restaurante`)
- `tipo`: Uma das 12 categorias (restaurante, farmacia, etc)
- `config`: JSONB para configurações personalizadas
- Índices: slug, tipo, ativo, cnpj

**Casos de Uso**:
- Isolamento de dados por empresa
- Busca rápida por slug ou CNPJ
- Filtragem por tipo de negócio

---

### 2. **tenant_users** - Usuários por Empresa
Associação de usuários com suas empresas e papéis.

```sql
CREATE TABLE tenant_users (
  id UUID PRIMARY KEY,
  tenant_id UUID REFERENCES tenants,
  user_id UUID,
  papel TEXT,                          -- dono, gerente, vendedor, etc
  ultima_atividade TIMESTAMPTZ
)
```

**Campos Principais**:
- `papel`: Define permissões no sistema (veja matriz abaixo)
- `ultima_atividade`: Para análise de engajamento

**Papéis Suportados**:
| Papel | Permissões | Exemplo |
|-------|-----------|---------|
| dono | Acesso total, config, pagamentos | Dono do restaurante |
| gerente | Vendas, estoque, relatórios, config | Gerente da loja |
| vendedor | Criar vendas, consultando estoque | Vendedor de PDV |
| garcom | Ver cardápio, registrar pedidos | Garçom |
| cozinheiro | Ver pedidos pendentes | Cozinheiro |
| almoxarife | Gerenciar estoque | Pessoa responsável |
| farmacêutico | Vendas com receita, logs | Farmácia |

---

### 3. **clients** - Cliente
Dados de clientes que compram na empresa.

```sql
CREATE TABLE clients (
  id UUID PRIMARY KEY,
  tenant_id UUID REFERENCES tenants,
  nome TEXT NOT NULL,
  email TEXT,
  cpf_cnpj VARCHAR(18),
  telefone VARCHAR(15),
  grupo_cliente TEXT,                  -- VIP, Normal, Comum
  limite_credito NUMERIC(12, 2),
  ...
)
```

**Campos Principais**:
- `tipo`: pessoa_fisica ou pessoa_juridica
- `grupo_cliente`: Para ofertas e descontos específicos
- `limite_credito`: Para crédito automático
- `dias_pagamento`: Prazo padrão para pagamento
- `preferencias`: JSONB com alergias, preferências, etc

**Usa Casos**:
- Restaurante: Rastreamento de alergias
- Farmácia: Medicamentos contínuos
- Comércio: Histórico de compras
- E-commerce: Entrega e preferências

---

### 4. **products** - Produtos/Serviços
Itens que a empresa vende.

```sql
CREATE TABLE products (
  id UUID PRIMARY KEY,
  tenant_id UUID REFERENCES tenants,
  nome TEXT NOT NULL,
  sku TEXT NOT NULL,
  categoria_id UUID REFERENCES categories,
  preco_custo NUMERIC(12, 2),
  preco_venda NUMERIC(12, 2),
  estoque NUMERIC(12, 4),
  margem_percentual NUMERIC(5, 2) GENERATED ALWAYS AS ...
)
```

**Campos Especiais**:
- `margem_percentual`: Calculada automaticamente
- `codigo_barras`: Para varejo
- `peso`, `dimensoes`: Para e-commerce
- `precisa_receita`: Para farmácia
- `controlado`: Tarja vermelha, etc

**Flexibilidade**:
- Restaurante: pratos, bebidas
- Farmácia: medicamentos, posologia
- Academia: serviços, aulas
- Hotel: quartos, serviços

---

### 5. **categories** - Categorias de Produtos
Agrupamento de produtos.

```sql
CREATE TABLE categories (
  id UUID PRIMARY KEY,
  tenant_id UUID REFERENCES tenants,
  nome TEXT NOT NULL,
  descricao TEXT,
  ativo BOOLEAN DEFAULT true
)
```

**Exemplos por Tipo**:
- Restaurante: Entradas, Pratos Principais, Bebidas, Sobremesas
- Farmácia: Medicamentos, Higiene, Cosméticos
- Comércio: Eletrônicos, Roupas, Acessórios

---

### 6. **transactions** - Transações Financeiras
Registro de toda movimentação financeira.

```sql
CREATE TABLE transactions (
  id UUID PRIMARY KEY,
  tenant_id UUID REFERENCES tenants,
  tipo TEXT,                           -- receita, despesa, transferencia
  categoria TEXT,
  valor NUMERIC(12, 2),
  data_vencimento DATE,
  data_pagamento DATE,
  pago BOOLEAN,
  referencia_tipo TEXT,                -- venda, pedido, etc
  referencia_id UUID
)
```

**Tipos de Transações**:
- `receita`: Venda, serviço, devolução de fornecedor
- `despesa`: Custo, aluguel, folha de pagamento
- `transferencia`: Entre contas

**Relatórios Geraáos**:
- Fluxo de caixa
- Receitas vs despesas
- Inadimplência
- Previsão orçamentária

---

### 7. **estoque_movimentacoes** - Histórico de Estoque
Auditoria completa de todas as mudanças de estoque.

```sql
CREATE TABLE estoque_movimentacoes (
  id UUID PRIMARY KEY,
  tenant_id UUID REFERENCES tenants,
  produto_id UUID REFERENCES products,
  tipo TEXT,                           -- entrada, saida, ajuste, devolucao
  quantidade NUMERIC(12, 4),
  referencia_tipo TEXT,                -- venda, compra, etc
  criado_em TIMESTAMPTZ,
  criado_por UUID
)
```

**Rastreabilidade Completa**:
- Cada movimento é registrado
- Origem do movimento (venda, compra, ajuste)
- Quem fez a movimentação
- Quando foi feita

**Benefícios**:
- Auditoria completa
- Identificação de discrepâncias
- Análise de movimentação

---

### 8. **tenant_config** - Configurações por Empresa
Preferências específicas de cada tenant.

```sql
CREATE TABLE tenant_config (
  id UUID PRIMARY KEY,
  tenant_id UUID UNIQUE REFERENCES tenants,
  mostrar_estoque BOOLEAN,
  permitir_estoque_negativo BOOLEAN,
  exigir_nota_fiscal BOOLEAN,
  impressora_cozinha TEXT,
  config_especifica JSONB
)
```

**Uso**:
- Restaurante: Tempo de preparação, impressora cozinha
- Farmácia: Exigir receita, controle de medicamentos
- Hotel: Políticas de check-in/check-out
- Academia: Tipos de aula, agendamentos

---

## 🔗 Relacionamentos

```
tenants (raiz)
  ├─→ tenant_users (usuários da empresa)
  ├─→ tenant_config (configurações)
  ├─→ clients (clientes)
  │    └─→ transactions (pagamentos)
  ├─→ products (produtos)
  │    ├─→ categories
  │    └─→ estoque_movimentacoes
  └─→ transactions (receitas/despesas)
```

**Regra de Cascata**:
- Deletar tenant: deleta tenants_users, clients, products, etc
- Deletar product: deleta estoque_movimentacoes
- Deletar category: apenas SET NULL em products.categoria_id

---

## 🔄 Views (Consultas Prontas)

### 1. **produtos_estoque_baixo**
Produtos com estoque abaixo do mínimo.

```sql
SELECT p.nome, p.estoque, p.estoque_minimo, 
       (p.estoque_minimo - p.estoque) as deficit
FROM produtos_estoque_baixo
WHERE tenant_id = $1
ORDER BY deficit DESC;
```

**Uso**: Dashboard, alertas de reposição

### 2. **clientes_inadimplentes**
Clientes com contas vencidas.

```sql
SELECT c.nome, COUNT(*) as transacoes_pendentes,
       SUM(valor) as valor_devido
FROM clientes_inadimplentes
WHERE tenant_id = $1
ORDER BY valor_devido DESC;
```

**Uso**: Cobrança, análise de risco

---

## ⚡ Índices para Performance

| Índice | Tabela | Campo | Razão |
|--------|--------|-------|-------|
| `idx_tenants_slug` | tenants | slug | Busca por URL |
| `idx_tenants_tipo` | tenants | tipo | Filtro por tipo negócio |
| `idx_clients_tenant` | clients | tenant_id | Isolamento multi-tenant |
| `idx_clients_cpf_cnpj` | clients | cpf_cnpj | Validação de cadastro |
| `idx_products_barcode` | products | codigo_barras | Scanner PDV |
| `idx_estoque_movimentacoes_criado` | estoque_movimentacoes | criado_em DESC | Timeline |
| `idx_transactions_pago` | transactions | pago | Relatórios financeiros |

---

## 🚀 Passos para Execução

### 1. Execução no Supabase

```
1. Acesse: https://app.supabase.com
2. Selecione o projeto RED
3. SQL Editor → Novo Query
4. Cole o conteúdo de COMPLETE_SCHEMA.sql
5. Click "Run" (ou Ctrl+Enter)
6. Aguarde conclusão (~5-10 segundos)
```

### 2. Verificação

```sql
-- Verificar tabelas criadas
SELECT tablename FROM pg_tables 
WHERE schemaname = 'public' 
ORDER BY tablename;

-- Verificar índices
SELECT indexname FROM pg_indexes 
WHERE schemaname = 'public' 
GROUP BY indexname;

-- Verificar views
SELECT viewname FROM pg_views 
WHERE schemaname = 'public';
```

### 3. Dados de Teste (Opcional)

```sql
-- Inserir tenant de teste
INSERT INTO tenants (slug, nome, tipo, cnpj)
VALUES 
  ('rest-exemplo', 'Restaurante Exemplo', 'restaurante', '12.345.678/0001-90'),
  ('farm-exemplo', 'Farmácia Exemplo', 'farmacia', '98.765.432/0001-11');

-- Verificar
SELECT id, slug, nome, tipo FROM tenants;
```

---

## 🔒 Segurança

### Políticas RLS (Row Level Security)

Para implementar quando pronto:

```sql
-- Apenas usuários da tenant podem ver seus dados
CREATE POLICY "tenants_isolate_data"
ON clients FOR SELECT
USING (tenant_id IN (
  SELECT tenant_id FROM tenant_users 
  WHERE user_id = auth.uid()
));
```

---

## 📈 Próximos Passos

1. **Testes**: Executar scripts de inserção
2. **Validação**: Verificar índices e performance
3. **Migração**: Migrar dados das tabelas antigas (se houver)
4. **APIs**: Criar endpoints para CRUD de todas as tabelas
5. **RLS**: Implementar políticas de segurança

---

## 📞 Suporte

- Documentação Supabase: https://supabase.com/docs/guides/database
- PostgreSQL Docs: https://www.postgresql.org/docs/
- Chat para dúvidas sobre queries

