-- ═══════════════════════════════════════════════════════════════════════════════
-- SCHEMA UNIVERSAL RED COMMERCIAL v5.0
-- Estrutura otimizada para suportar múltiplos tipos de negócio
-- Execute este arquivo completo no Supabase SQL Editor
-- ═══════════════════════════════════════════════════════════════════════════════

-- ─────────────────────────────────────────────────────────────────────────────
-- TABELA: TENANTS (Empresas/Negócios)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tenants (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug            TEXT NOT NULL UNIQUE,
  nome            TEXT NOT NULL,
  tipo            TEXT NOT NULL,  -- restaurante, concessionaria, comercio, farmacia, etc
  descricao       TEXT,
  logo_url        TEXT,
  
  -- Dados comerciais
  cnpj            VARCHAR(18) UNIQUE,
  inscricao_estadual TEXT,
  razao_social    TEXT,
  
  -- Contato
  telefone        VARCHAR(15),
  email           TEXT,
  website         TEXT,
  
  -- Localização
  endereco        TEXT,
  numero          VARCHAR(10),
  complemento     TEXT,
  bairro          TEXT,
  cidade          TEXT,
  estado          VARCHAR(2),
  cep             VARCHAR(9),
  latitude        NUMERIC(10, 8),
  longitude       NUMERIC(11, 8),
  
  -- Configurações
  ativo           BOOLEAN DEFAULT true,
  moeda           VARCHAR(3) DEFAULT 'BRL',
  fuso_horario    TEXT DEFAULT 'America/Sao_Paulo',
  config          JSONB DEFAULT '{}',  -- Configurações personalizadas
  
  -- Auditoria
  criado_em       TIMESTAMPTZ DEFAULT now(),
  atualizado_em   TIMESTAMPTZ DEFAULT now(),
  criado_por      UUID
);

CREATE INDEX IF NOT EXISTS idx_tenants_slug        ON tenants(slug);
CREATE INDEX IF NOT EXISTS idx_tenants_tipo        ON tenants(tipo);
CREATE INDEX IF NOT EXISTS idx_tenants_ativo       ON tenants(ativo);
CREATE INDEX IF NOT EXISTS idx_tenants_cnpj        ON tenants(cnpj);

-- ─────────────────────────────────────────────────────────────────────────────
-- TABELA: TENANT_USERS (Usuários por Empresa)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tenant_users (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id         UUID NOT NULL,
  username        TEXT,
  papel           TEXT NOT NULL,  -- dono, gerente, vendedor, garcom, cozinheiro, etc
  ativo           BOOLEAN DEFAULT true,
  ultima_atividade TIMESTAMPTZ,
  criado_em       TIMESTAMPTZ DEFAULT now(),
  UNIQUE(tenant_id, user_id),
  UNIQUE(tenant_id, username)
);

CREATE INDEX IF NOT EXISTS idx_tenant_users_tenant   ON tenant_users(tenant_id);
CREATE INDEX IF NOT EXISTS idx_tenant_users_user     ON tenant_users(user_id);
CREATE INDEX IF NOT EXISTS idx_tenant_users_papel    ON tenant_users(papel);

-- ─────────────────────────────────────────────────────────────────────────────
-- TABELA: CLIENTES
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS clients (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  
  -- Dados principais
  nome            TEXT NOT NULL,
  email           TEXT,
  telefone        VARCHAR(15),
  cpf_cnpj        VARCHAR(18) UNIQUE,
  data_nascimento DATE,
  sexo            VARCHAR(1),  -- M, F, O
  
  -- Endereço
  endereco        TEXT,
  numero          VARCHAR(10),
  complemento     TEXT,
  bairro          TEXT,
  cidade          TEXT,
  estado          VARCHAR(2),
  cep             VARCHAR(9),
  
  -- Comercial
  tipo            TEXT DEFAULT 'pessoa_fisica',  -- pessoa_fisica, pessoa_juridica
  referencia_id   TEXT,  -- ID externo do cliente em outro sistema
  grupo_cliente   TEXT,  -- VIP, Normal, Comum, etc
  limite_credito  NUMERIC(12, 2) DEFAULT 0,
  dias_pagamento  INTEGER DEFAULT 0,  -- Dias de prazo para pagamento
  
  -- Status e preferências
  ativo           BOOLEAN DEFAULT true,
  preferencias    JSONB DEFAULT '{}',  -- {alergia, preferencias_contato, etc}
  
  -- Auditoria
  criado_em       TIMESTAMPTZ DEFAULT now(),
  atualizado_em   TIMESTAMPTZ DEFAULT now(),
  criado_por      UUID
);

CREATE INDEX IF NOT EXISTS idx_clients_tenant       ON clients(tenant_id);
CREATE INDEX IF NOT EXISTS idx_clients_nome         ON clients(nome);
CREATE INDEX IF NOT EXISTS idx_clients_cpf_cnpj     ON clients(cpf_cnpj);
CREATE INDEX IF NOT EXISTS idx_clients_email        ON clients(email);
CREATE INDEX IF NOT EXISTS idx_clients_ativo        ON clients(ativo);
CREATE INDEX IF NOT EXISTS idx_clients_grupo        ON clients(grupo_cliente);

-- ─────────────────────────────────────────────────────────────────────────────
-- TABELA: PRODUTOS
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS products (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  
  -- Dados principais
  nome            TEXT NOT NULL,
  descricao       TEXT,
  sku             TEXT NOT NULL,
  codigo_barras   TEXT UNIQUE,
  categoria_id    UUID REFERENCES categories(id) ON DELETE SET NULL,
  
  -- Preços
  preco_custo     NUMERIC(12, 2) DEFAULT 0,
  preco_venda     NUMERIC(12, 2) DEFAULT 0,
  preco_promocial NUMERIC(12, 2),
  margem_percentual NUMERIC(5, 2) GENERATED ALWAYS AS (
    CASE WHEN preco_custo = 0 THEN 0 
    ELSE ((preco_venda - preco_custo) / preco_custo) * 100 
    END
  ) STORED,
  
  -- Estoque
  estoque         NUMERIC(12, 4) DEFAULT 0,
  estoque_minimo  NUMERIC(12, 4) DEFAULT 0,
  localizacao     TEXT,  -- Prateleira, posição, etc
  
  -- Detalhes
  unidade         VARCHAR(10) DEFAULT 'un',  -- un, kg, l, ml, m, etc
  peso            NUMERIC(10, 3),  -- em kg
  dimensoes       JSONB,  -- {altura, largura, profundidade}
  imagens         TEXT[],  -- URLs de imagens
  
  -- Metadados
  ativo           BOOLEAN DEFAULT true,
  precisa_receita BOOLEAN DEFAULT false,  -- Para farmácias
  controlado      BOOLEAN DEFAULT false,  -- Tarja vermelha, etc
  tags            TEXT[],
  
  -- Auditoria
  criado_em       TIMESTAMPTZ DEFAULT now(),
  atualizado_em   TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_products_tenant      ON products(tenant_id);
CREATE INDEX IF NOT EXISTS idx_products_sku         ON products(sku);
CREATE INDEX IF NOT EXISTS idx_products_barcode     ON products(codigo_barras);
CREATE INDEX IF NOT EXISTS idx_products_categoria   ON products(categoria_id);
CREATE INDEX IF NOT EXISTS idx_products_estoque     ON products(estoque);

-- ─────────────────────────────────────────────────────────────────────────────
-- TABELA: CATEGORIAS
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS categories (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  nome            TEXT NOT NULL,
  descricao       TEXT,
  ativo           BOOLEAN DEFAULT true,
  criado_em       TIMESTAMPTZ DEFAULT now(),
  UNIQUE(tenant_id, nome)
);

CREATE INDEX IF NOT EXISTS idx_categories_tenant    ON categories(tenant_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- TABELA: TRANSACOES (Financeiro)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS transactions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  
  -- Tipo
  tipo            TEXT NOT NULL,  -- receita, despesa, transferencia
  categoria       TEXT NOT NULL,
  descricao       TEXT NOT NULL,
  
  -- Valores
  valor           NUMERIC(12, 2) NOT NULL,
  
  -- Datas
  data_criacao    TIMESTAMPTZ DEFAULT now(),
  data_vencimento DATE,
  data_pagamento  DATE,
  
  -- Status
  pago            BOOLEAN DEFAULT false,
  referencia_tipo TEXT,  -- venda, pedido, compra, etc
  referencia_id   UUID,
  
  -- Auditoria
  criado_por      UUID,
  pago_por        UUID,
  observacoes     TEXT
);

CREATE INDEX IF NOT EXISTS idx_transactions_tenant  ON transactions(tenant_id);
CREATE INDEX IF NOT EXISTS idx_transactions_tipo    ON transactions(tipo);
CREATE INDEX IF NOT EXISTS idx_transactions_pago    ON transactions(pago);
CREATE INDEX IF NOT EXISTS idx_transactions_data    ON transactions(data_vencimento);

-- ─────────────────────────────────────────────────────────────────────────────
-- TABELA: ESTOQUE_MOVIMENTACAO
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS estoque_movimentacoes (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  produto_id      UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  
  -- Movimento
  tipo            TEXT NOT NULL,  -- entrada, saida, ajuste, devolucao
  quantidade      NUMERIC(12, 4) NOT NULL,
  motivo          TEXT,
  
  -- Referência
  referencia_tipo TEXT,  -- venda, compra, ajuste, etc
  referencia_id   UUID,
  
  -- Auditoria
  criado_em       TIMESTAMPTZ DEFAULT now(),
  criado_por      UUID,
  observacoes     TEXT
);

CREATE INDEX IF NOT EXISTS idx_movimentacoes_tenant ON estoque_movimentacoes(tenant_id);
CREATE INDEX IF NOT EXISTS idx_movimentacoes_produto ON estoque_movimentacoes(produto_id);
CREATE INDEX IF NOT EXISTS idx_movimentacoes_tipo   ON estoque_movimentacoes(tipo);
CREATE INDEX IF NOT EXISTS idx_movimentacoes_criado ON estoque_movimentacoes(criado_em DESC);

-- ─────────────────────────────────────────────────────────────────────────────
-- TABELA: CONFIGURACOES DO TENANT
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tenant_config (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL UNIQUE REFERENCES tenants(id) ON DELETE CASCADE,
  
  -- Comportamento
  mostrar_estoque BOOLEAN DEFAULT true,
  permitir_estoque_negativo BOOLEAN DEFAULT false,
  exigir_nota_fiscal BOOLEAN DEFAULT false,
  
  -- Impressoras
  impressora_cozinha TEXT,
  impressora_fiscal TEXT,
  
  -- Timings
  tempo_preparacao_min INTEGER DEFAULT 15,  -- minutos
  
  -- Configurações por tipo
  config_especifica JSONB DEFAULT '{}',
  
  criado_em       TIMESTAMPTZ DEFAULT now(),
  atualizado_em   TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_config_tenant        ON tenant_config(tenant_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- TABLE: SYSTEM_LOGS (Já criada em ADMIN_SCHEMA.sql - apenas referência)
-- ─────────────────────────────────────────────────────────────────────────────

-- ─────────────────────────────────────────────────────────────────────────────
-- FUNÇÕES UTILITÁRIAS
-- ─────────────────────────────────────────────────────────────────────────────

-- Atualizar timestamp de atualização
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.atualizado_em = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Criar trigger para tenants
CREATE TRIGGER tenants_update_timestamp
BEFORE UPDATE ON tenants
FOR EACH ROW
EXECUTE FUNCTION update_updated_at();

-- Criar trigger para clients
CREATE TRIGGER clients_update_timestamp
BEFORE UPDATE ON clients
FOR EACH ROW
EXECUTE FUNCTION update_updated_at();

-- Criar trigger para products
CREATE TRIGGER products_update_timestamp
BEFORE UPDATE ON products
FOR EACH ROW
EXECUTE FUNCTION update_updated_at();

-- ─────────────────────────────────────────────────────────────────────────────
-- VIEWS ÚTEIS
-- ─────────────────────────────────────────────────────────────────────────────

-- Produtos com estoque baixo
CREATE OR REPLACE VIEW produtos_estoque_baixo AS
SELECT 
  p.id,
  p.nome,
  p.tenant_id,
  p.estoque,
  p.estoque_minimo,
  (p.estoque_minimo - p.estoque) as deficit
FROM products p
WHERE p.estoque < p.estoque_minimo
  AND p.ativo = true
ORDER BY deficit DESC;

-- Clientes inadimplentes
CREATE OR REPLACE VIEW clientes_inadimplentes AS
SELECT 
  c.id,
  c.nome,
  c.tenant_id,
  COUNT(t.id) as transacoes_pendentes,
  SUM(t.valor) as valor_devido,
  MAX(t.data_vencimento) as ultimo_vencimento
FROM clients c
LEFT JOIN transactions t ON c.id::uuid = t.referencia_id 
  AND t.referencia_tipo = 'cliente'
  AND t.pago = false
  AND t.data_vencimento < CURRENT_DATE
WHERE c.ativo = true
GROUP BY c.id, c.nome, c.tenant_id
HAVING SUM(t.valor) > 0
ORDER BY valor_devido DESC;

-- ═══════════════════════════════════════════════════════════════════════════════
-- VERIFICAÇÃO FINAL
-- ═══════════════════════════════════════════════════════════════════════════════

SELECT 
  schemaname,
  tablename
FROM pg_tables
WHERE schemaname = 'public'
ORDER BY tablename;
