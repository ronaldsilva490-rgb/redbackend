-- ═══════════════════════════════════════════════════════════════════════════════
-- SCHEMA PARA ADMINISTRADORES DO SISTEMA
-- Execute este script no SQL Editor do Supabase uma vez
-- ═══════════════════════════════════════════════════════════════════════════════

-- Tabela de Administradores do Sistema
CREATE TABLE IF NOT EXISTS admin_users (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nome            TEXT NOT NULL,
  username        TEXT NOT NULL UNIQUE,
  email           TEXT NOT NULL UNIQUE,
  senha_hash      TEXT NOT NULL,
  ativo           BOOLEAN DEFAULT true,
  criado_em       TIMESTAMPTZ DEFAULT now(),
  criado_por      UUID,
  atualizado_em   TIMESTAMPTZ DEFAULT now()
);

-- Índices para performance
CREATE INDEX IF NOT EXISTS idx_admin_users_username ON admin_users(username);
CREATE INDEX IF NOT EXISTS idx_admin_users_email ON admin_users(email);
CREATE INDEX IF NOT EXISTS idx_admin_users_ativo ON admin_users(ativo);

-- Tabela de Logs de Admin (auditoria)
CREATE TABLE IF NOT EXISTS admin_logs (
  id              BIGSERIAL PRIMARY KEY,
  admin_id        UUID NOT NULL REFERENCES admin_users(id) ON DELETE SET NULL,
  acao            TEXT NOT NULL,  -- 'login', 'criar_admin', 'deletar_usuario', 'modificar_config', 'verificar_db', etc
  descricao       TEXT,
  dados           JSONB,
  ip_address      VARCHAR(45),
  user_agent      TEXT,
  status_codigo   INTEGER,
  criado_em       TIMESTAMPTZ DEFAULT now()
);

-- Índices para logs
CREATE INDEX IF NOT EXISTS idx_admin_logs_admin_id ON admin_logs(admin_id);
CREATE INDEX IF NOT EXISTS idx_admin_logs_acao ON admin_logs(acao);
CREATE INDEX IF NOT EXISTS idx_admin_logs_criado ON admin_logs(criado_em DESC);

-- Tabela de Métricas e Status do Sistema
CREATE TABLE IF NOT EXISTS system_metrics (
  id              BIGSERIAL PRIMARY KEY,
  metrica         TEXT NOT NULL,  -- 'usuarios_ativos', 'vendas_dia', 'requisicoes', 'latencia_db', etc
  valor           NUMERIC DEFAULT 0,
  unidade        TEXT,  -- 'count', 'ms', 'bytes', '%', etc
  timestamp       TIMESTAMPTZ DEFAULT now(),
  ambiente        TEXT DEFAULT 'production'  -- 'production', 'staging', 'development'
);

-- Índices para métricas
CREATE INDEX IF NOT EXISTS idx_system_metrics_metrica ON system_metrics(metrica);
CREATE INDEX IF NOT EXISTS idx_system_metrics_timestamp ON system_metrics(timestamp DESC);

-- Tabela de Configurações do Sistema (globais)
CREATE TABLE IF NOT EXISTS system_config (
  chave           TEXT PRIMARY KEY,
  valor           JSONB NOT NULL,
  descricao       TEXT,
  atualizado_em   TIMESTAMPTZ DEFAULT now(),
  atualizado_por  UUID REFERENCES admin_users(id) ON DELETE SET NULL
);

-- View para estatísticas rápidas
CREATE OR REPLACE VIEW admin_dashboard_stats AS
SELECT 
  (SELECT COUNT(*) FROM tenants WHERE ativo = true) as total_tenants_ativos,
  (SELECT COUNT(*) FROM tenants WHERE tipo = 'restaurante' AND ativo = true) as tenants_restaurantes,
  (SELECT COUNT(*) FROM tenants WHERE tipo = 'concessionaria' AND ativo = true) as tenants_concessionarias,
  (SELECT COUNT(*) FROM tenants WHERE tipo = 'comercio' AND ativo = true) as tenants_comercios,
  (SELECT COUNT(*) FROM tenant_users WHERE ativo = true) as total_usuarios_ativos,
  (SELECT COUNT(*) FROM admin_logs WHERE criado_em > NOW() - INTERVAL '24 hours') as logs_24h,
  (SELECT COUNT(*) FROM system_logs WHERE level = 'error' AND created_at > NOW() - INTERVAL '24 hours') as erros_24h;

-- View para atividade recente
CREATE OR REPLACE VIEW admin_recent_activity AS
SELECT 
  'admin_login' as tipo,
  admin_id as user_id,
  (SELECT username FROM admin_users WHERE id = admin_logs.admin_id) as username,
  acao as descricao,
  criado_em as timestamp
FROM admin_logs
WHERE acao = 'login'
ORDER BY criado_em DESC
LIMIT 20;

-- Função para registrar atividade de admin
CREATE OR REPLACE FUNCTION log_admin_activity(
  p_admin_id UUID,
  p_acao TEXT,
  p_descricao TEXT DEFAULT NULL,
  p_dados JSONB DEFAULT NULL,
  p_status_codigo INTEGER DEFAULT 200
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  INSERT INTO admin_logs (admin_id, acao, descricao, dados, status_codigo)
  VALUES (p_admin_id, p_acao, p_descricao, p_dados, p_status_codigo);
END;
$$;

-- Tabela para Status dos Serviços Externos
CREATE TABLE IF NOT EXISTS service_health (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  servico_nome    TEXT NOT NULL,
  status          TEXT NOT NULL,  -- 'online', 'offline', 'degraded'
  latencia_ms     INTEGER,
  erro_mensagem   TEXT,
  checado_em      TIMESTAMPTZ DEFAULT now(),
  proximo_check   TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_service_health_servico ON service_health(servico_nome);
CREATE INDEX IF NOT EXISTS idx_service_health_checado ON service_health(checado_em DESC);

-- Função para registrar métricas do sistema
CREATE OR REPLACE FUNCTION record_system_metric(
  p_metrica TEXT,
  p_valor NUMERIC,
  p_unidade TEXT DEFAULT NULL
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  INSERT INTO system_metrics (metrica, valor, unidade)
  VALUES (p_metrica, p_valor, p_unidade);
END;
$$;

-- ═══════════════════════════════════════════════════════════════════════════════
-- DADOS INICIAIS (Descomente para inserir um admin de teste)
-- ═══════════════════════════════════════════════════════════════════════════════

-- Para gerar hash da senha 'admin' use: bcrypt('admin', 10)
-- No backend, use: from werkzeug.security import generate_password_hash
-- INSERT INTO admin_users (nome, username, email, senha_hash, ativo)
-- VALUES ('Administrador Sistema', 'admin', 'admin@redcommercial.local', '[HASH_DA_SENHA]', true);

-- ═══════════════════════════════════════════════════════════════════════════════
-- VERIFICAÇÃO
-- ═══════════════════════════════════════════════════════════════════════════════

-- Verifica se tabelas foram criadas
SELECT 'admin_users' as tabela, COUNT(*) FROM admin_users
UNION ALL
SELECT 'admin_logs', COUNT(*) FROM admin_logs
UNION ALL
SELECT 'system_metrics', COUNT(*) FROM system_metrics
UNION ALL
SELECT 'system_config', COUNT(*) FROM system_config
UNION ALL
SELECT 'service_health', COUNT(*) FROM service_health;
