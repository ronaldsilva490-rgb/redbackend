-- TAREFA 8: USER_PREFERENCES TABLE
-- Armazena tudo que tava no localStorage

CREATE TABLE IF NOT EXISTS user_preferences (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id UUID NOT NULL,
  
  -- Tema
  theme TEXT DEFAULT 'dark',
  
  -- Notificações
  notify_updates BOOLEAN DEFAULT true,
  notify_sales BOOLEAN DEFAULT true,
  notify_stock BOOLEAN DEFAULT true,
  
  -- Moeda e formato
  currency VARCHAR(3) DEFAULT 'BRL',
  date_format VARCHAR(10) DEFAULT 'dd/MM/yyyy',
  
  -- Dashboard preferências
  dashboard_layout TEXT,
  quick_filters JSONB,
  
  -- Histórico
  recent_searches TEXT[],
  favorite_products UUID[],
  favorite_clients UUID[],
  
  -- UI
  sidebar_collapsed BOOLEAN DEFAULT false,
  compact_mode BOOLEAN DEFAULT false,
  
  -- Dados customizados
  custom_settings JSONB DEFAULT '{}',
  
  criado_em TIMESTAMPTZ DEFAULT now(),
  atualizado_em TIMESTAMPTZ DEFAULT now(),
  UNIQUE(tenant_id, user_id)
);

CREATE INDEX idx_user_preferences_user ON user_preferences(tenant_id, user_id);
