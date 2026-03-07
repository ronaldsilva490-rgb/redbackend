-- ═══════════════════════════════════════════════════════════════════════════════
-- SCHEMA UNIVERSAL DE VENDAS v2
-- Suporta todos os tipos de negócio
-- Execute no Supabase SQL Editor
-- ═══════════════════════════════════════════════════════════════════════════════

-- ─────────────────────────────────────────────────────────────────────────────
-- TABELA: VENDAS
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS vendas (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL REFERENCES tenants(id),
  numero_venda    TEXT NOT NULL,
  cliente_id      UUID REFERENCES clients(id) ON DELETE SET NULL,
  user_id         UUID,  -- Vendedor/Operador
  subtotal        NUMERIC(12, 2) DEFAULT 0,
  total_desconto  NUMERIC(12, 2) DEFAULT 0,
  total           NUMERIC(12, 2) DEFAULT 0,
  status          TEXT DEFAULT 'completa',  -- 'completa', 'cancelada', 'devolucao'
  itens           JSONB,  -- [{produto_id, quantidade, preco_unitario, desconto}]
  notas           TEXT,
  criado_em       TIMESTAMPTZ DEFAULT now(),
  cancelado_em    TIMESTAMPTZ,
  tags            TEXT[],  -- Para filtros x 'promocao', 'cliente_vip', etc
  UNIQUE(tenant_id, numero_venda)
);

CREATE INDEX IF NOT EXISTS idx_vendas_tenant        ON vendas(tenant_id);
CREATE INDEX IF NOT EXISTS idx_vendas_cliente       ON vendas(cliente_id);
CREATE INDEX IF NOT EXISTS idx_vendas_status        ON vendas(status);
CREATE INDEX IF NOT EXISTS idx_vendas_criado        ON vendas(criado_em DESC);
CREATE INDEX IF NOT EXISTS idx_vendas_numero        ON vendas(numero_venda);

-- ─────────────────────────────────────────────────────────────────────────────
-- TABELA: PAGAMENTOS_VENDA (Diferentes formas de pagamento por venda)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS pagamentos_venda (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  venda_id        UUID NOT NULL REFERENCES vendas(id) ON DELETE CASCADE,
  tenant_id       UUID NOT NULL REFERENCES tenants(id),
  tipo            TEXT NOT NULL,  -- 'dinheiro', 'cartao_credito', 'cartao_debito', 'pix', 'fiado', 'cheque'
  valor           NUMERIC(12, 2) NOT NULL,
  referencia      TEXT,  -- chave PIX, número cartão (últimos 4), cheque número, etc
  id_transacao    TEXT,  -- referência externa (gateway pagamento, banco, etc)
  status          TEXT DEFAULT 'completo',  -- 'completo', 'pendente', 'falhou'
  criado_em       TIMESTAMPTZ DEFAULT now(),
  processado_em   TIMESTAMPTZ,
  CONSTRAINT fk_pagamento_venda FOREIGN KEY (venda_id) REFERENCES vendas(id)
);

CREATE INDEX IF NOT EXISTS idx_pagamentos_venda_id    ON pagamentos_venda(venda_id);
CREATE INDEX IF NOT EXISTS idx_pagamentos_tipo        ON pagamentos_venda(tipo);
CREATE INDEX IF NOT EXISTS idx_pagamentos_status      ON pagamentos_venda(status);
CREATE INDEX IF NOT EXISTS idx_pagamentos_criado      ON pagamentos_venda(criado_em DESC);

-- ─────────────────────────────────────────────────────────────────────────────
-- TABELA: CUPONS_DESCONTO
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS cupons_desconto (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL REFERENCES tenants(id),
  codigo          TEXT NOT NULL UNIQUE,
  descricao       TEXT,
  tipo            TEXT DEFAULT 'percentual',  -- 'percentual' ou 'fixo'
  valor           NUMERIC(12, 2) NOT NULL,
  valor_minimo    NUMERIC(12, 2) DEFAULT 0,
  ativo           BOOLEAN DEFAULT true,
  data_inicio     TIMESTAMPTZ,
  data_fim        TIMESTAMPTZ,
  uso_maximo      INTEGER,  -- quantidade máxima de usos
  usos_atuais     INTEGER DEFAULT 0,
  criado_em       TIMESTAMPTZ DEFAULT now(),
  criado_por      UUID
);

CREATE INDEX IF NOT EXISTS idx_cupons_tenant        ON cupons_desconto(tenant_id);
CREATE INDEX IF NOT EXISTS idx_cupons_codigo        ON cupons_desconto(codigo);
CREATE INDEX IF NOT EXISTS idx_cupons_ativo         ON cupons_desconto(ativo);

-- ─────────────────────────────────────────────────────────────────────────────
-- TABELA: ITENS_VENDA (Detalhe de cada item da venda)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS itens_venda (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  venda_id        UUID NOT NULL REFERENCES vendas(id) ON DELETE CASCADE,
  produto_id      UUID REFERENCES products(id) ON DELETE SET NULL,
  quantidade      NUMERIC(12, 4) NOT NULL,
  preco_unitario  NUMERIC(12, 2) NOT NULL,
  desconto_item   NUMERIC(12, 2) DEFAULT 0,  -- em %
  subtotal        NUMERIC(12, 2) GENERATED ALWAYS AS (quantidade * preco_unitario) STORED,
  criado_em       TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_itens_venda_id      ON itens_venda(venda_id);
CREATE INDEX IF NOT EXISTS idx_itens_produto_id    ON itens_venda(produto_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- TABELA: DEVOLUCOES
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS devolucoes (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  venda_id        UUID NOT NULL REFERENCES vendas(id),
  tenant_id       UUID NOT NULL REFERENCES tenants(id),
  motivo          TEXT NOT NULL,  -- 'defeito', 'arrependimento', 'troca', 'outro'
  itens           JSONB,  -- [{item_id, quantidade, valor}]
  valor_total     NUMERIC(12, 2),
  reembolsado     BOOLEAN DEFAULT false,
  data_reembolso  TIMESTAMPTZ,
  criado_em       TIMESTAMPTZ DEFAULT now(),
  processado_por  UUID
);

CREATE INDEX IF NOT EXISTS idx_devolucoes_venda       ON devolucoes(venda_id);
CREATE INDEX IF NOT EXISTS idx_devolucoes_tenant      ON devolucoes(tenant_id);
CREATE INDEX IF NOT EXISTS idx_devolucoes_criado      ON devolucoes(criado_em DESC);

-- ─────────────────────────────────────────────────────────────────────────────
-- TABELA: META_VENDAS (Metas e comissões)
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS meta_vendas (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL REFERENCES tenants(id),
  responsavel_id  UUID,  -- Gerente, vendedor
  periodo         TEXT,  -- 'diaria', 'semanal', 'mensal'
  valor_meta      NUMERIC(12, 2),
  valor_atingido  NUMERIC(12, 2) DEFAULT 0,
  percentual_meta NUMERIC(5, 2) GENERATED ALWAYS AS (
    CASE 
      WHEN valor_meta = 0 THEN 0 
      ELSE (valor_atingido / valor_meta) * 100 
    END
  ) STORED,
  comissao_perc   NUMERIC(5, 2) DEFAULT 0,  -- % de comissão
  comissao_valor  NUMERIC(12, 2) GENERATED ALWAYS AS (
    valor_atingido * (comissao_perc / 100)
  ) STORED,
  data_inicio     DATE,
  data_fim        DATE,
  pago            BOOLEAN DEFAULT false,
  criado_em       TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_meta_tenant         ON meta_vendas(tenant_id);
CREATE INDEX IF NOT EXISTS idx_meta_responsavel    ON meta_vendas(responsavel_id);
CREATE INDEX IF NOT EXISTS idx_meta_periodo        ON meta_vendas(periodo);

-- ─────────────────────────────────────────────────────────────────────────────
-- VIEWS PARA RELATÓRIOS
-- ─────────────────────────────────────────────────────────────────────────────

-- View: Resumo diário de vendas
CREATE OR REPLACE VIEW vendas_por_dia AS
SELECT 
  DATE(criado_em) as data,
  tenant_id,
  COUNT(*) as total_vendas,
  SUM(total) as valor_total,
  AVG(total) as ticket_medio,
  SUM(total_desconto) as desconto_total
FROM vendas
WHERE status != 'cancelada'
GROUP BY DATE(criado_em), tenant_id
ORDER BY data DESC;

-- View: Vendas por forma de pagamento
CREATE OR REPLACE VIEW vendas_por_pagamento AS
SELECT 
  DATE(pv.criado_em) as data,
  pv.tenant_id,
  pv.tipo,
  COUNT(*) as total_transacoes,
  SUM(pv.valor) as valor_total
FROM pagamentos_venda pv
WHERE pv.status = 'completo'
GROUP BY DATE(pv.criado_em), pv.tenant_id, pv.tipo
ORDER BY data DESC, valor_total DESC;

-- View: Top 10 produtos mais vendidos
CREATE OR REPLACE VIEW top_produtos_vendidos AS
SELECT 
  p.id,
  p.nome,
  v.tenant_id,
  SUM(CAST((iv.value->>'quantidade') AS NUMERIC)) as quantidade_total,
  SUM(CAST((iv.value->>'quantidade') AS NUMERIC) * CAST((iv.value->>'preco_unitario') AS NUMERIC)) as valor_total
FROM vendas v, jsonb_each(v.itens) AS iv
JOIN products p ON p.id::text = (iv.value->>'produto_id')
WHERE v.status != 'cancelada'
GROUP BY p.id, p.nome, v.tenant_id
ORDER BY quantidade_total DESC
LIMIT 10;

-- ─────────────────────────────────────────────────────────────────────────────
-- FUNÇÃO: Calcular total de vendas do dia
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION total_vendas_hoje(p_tenant_id UUID)
RETURNS TABLE (
  total_vendas BIGINT,
  valor_total NUMERIC,
  ticket_medio NUMERIC
) AS $$
BEGIN
  RETURN QUERY
  SELECT 
    COUNT(*)::BIGINT,
    COALESCE(SUM(total), 0),
    COALESCE(AVG(total), 0)
  FROM vendas
  WHERE tenant_id = p_tenant_id 
    AND DATE(criado_em) = CURRENT_DATE
    AND status != 'cancelada';
END;
$$ LANGUAGE plpgsql;

-- ─────────────────────────────────────────────────────────────────────────────
-- FUNÇÃO: Gerar número de venda sequencial
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION gerar_numero_venda(p_tenant_id UUID)
RETURNS TEXT AS $$
DECLARE
  v_numero TEXT;
  v_ano TEXT;
  v_mes TEXT;
  v_seq INTEGER;
BEGIN
  v_ano := TO_CHAR(NOW(), 'YYYY');
  v_mes := TO_CHAR(NOW(), 'MM');
  
  -- Tenta incrementar sequência do mês
  SELECT COALESCE(MAX(CAST(SUBSTR(numero_venda, -6) AS INTEGER)), 0) + 1
  INTO v_seq
  FROM vendas
  WHERE tenant_id = p_tenant_id 
    AND numero_venda LIKE v_ano || v_mes || '%';
  
  v_numero := v_ano || v_mes || LPAD(v_seq::TEXT, 6, '0');
  
  RETURN v_numero;
END;
$$ LANGUAGE plpgsql;

-- ─────────────────────────────────────────────────────────────────────────────
-- TESTES E VERIFICAÇÃO
-- ─────────────────────────────────────────────────────────────────────────────

-- Verificar tabelas criadas
SELECT 
  'vendas' as tabela, COUNT(*) as registros FROM vendas
UNION ALL
SELECT 'pagamentos_venda', COUNT(*) FROM pagamentos_venda
UNION ALL
SELECT 'cupons_desconto', COUNT(*) FROM cupons_desconto
UNION ALL
SELECT 'itens_venda', COUNT(*) FROM itens_venda
UNION ALL
SELECT 'devolucoes', COUNT(*) FROM devolucoes
UNION ALL
SELECT 'meta_vendas', COUNT(*) FROM meta_vendas;
