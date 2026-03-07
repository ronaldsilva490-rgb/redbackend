-- ═══════════════════════════════════════════════════════════════════════════════
-- SETUP LOGS DO SISTEMA — Execute isso no SQL Editor do Supabase
-- ═══════════════════════════════════════════════════════════════════════════════

-- Tabela principal de logs
CREATE TABLE IF NOT EXISTS system_logs (
  id          BIGSERIAL PRIMARY KEY,
  level       TEXT NOT NULL DEFAULT 'info',
  service     TEXT NOT NULL DEFAULT 'backend',
  message     TEXT NOT NULL,
  details     JSONB,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- Índices para performance
CREATE INDEX IF NOT EXISTS idx_system_logs_level   ON system_logs(level);
CREATE INDEX IF NOT EXISTS idx_system_logs_service ON system_logs(service);
CREATE INDEX IF NOT EXISTS idx_system_logs_created ON system_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_system_logs_message ON system_logs USING GIN (to_tsvector('portuguese', message));

-- Nota: RLS desativado por enquanto - você pode ativar depois se necessário
-- ALTER TABLE system_logs ENABLE ROW LEVEL SECURITY;

-- Função auxiliar para limpeza de logs antigos (executa automaticamente)
CREATE OR REPLACE FUNCTION cleanup_old_logs()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  DELETE FROM system_logs
  WHERE created_at < NOW() - INTERVAL '60 days';
  
  -- Vacuum para recuperar espaço
  VACUUM system_logs;
END;
$$;

-- Agenda limpeza automática (executar uma vez por dia)
-- Nota: Cron jobs em Supabase requerem plano Plus
-- Para dev, você pode executar manualmente com: SELECT cleanup_old_logs();

-- ═══════════════════════════════════════════════════════════════════════════════
-- ESTATÍSTICAS (Views úteis)
-- ═══════════════════════════════════════════════════════════════════════════════

-- View: Contagem de logs por nível
CREATE OR REPLACE VIEW logs_by_level AS
SELECT 
  level,
  COUNT(*) as count,
  COUNT(*) * 100.0 / (SELECT COUNT(*) FROM system_logs) as percentage
FROM system_logs
WHERE created_at > NOW() - INTERVAL '7 days'
GROUP BY level
ORDER BY count DESC;

-- View: Contagem de logs por serviço
CREATE OR REPLACE VIEW logs_by_service AS
SELECT 
  service,
  COUNT(*) as count,
  COUNT(*) * 100.0 / (SELECT COUNT(*) FROM system_logs) as percentage
FROM system_logs
WHERE created_at > NOW() - INTERVAL '7 days'
GROUP BY service
ORDER BY count DESC;

-- View: Erros nos últimos 24h
CREATE OR REPLACE VIEW recent_errors AS
SELECT 
  id,
  service,
  message,
  details,
  created_at
FROM system_logs
WHERE level = 'error' AND created_at > NOW() - INTERVAL '24 hours'
ORDER BY created_at DESC;

-- ═══════════════════════════════════════════════════════════════════════════════
-- TESTES (Execute para testar se tudo funciona)
-- ═══════════════════════════════════════════════════════════════════════════════

-- Insere alguns logs de teste
INSERT INTO system_logs (level, service, message, details) VALUES
  ('info', 'backend', 'Sistema iniciado', '{"version": "5.0.0"}'),
  ('warning', 'database', 'Connection pool low', '{"available": 5, "max": 10}'),
  ('error', 'orders', 'Erro ao processar pedido #123', '{"order_id": 123, "status": "failed"}'),
  ('debug', 'auth', 'User login attempt', '{"user_id": "abc123"}');

-- Verifica se foi inserido
SELECT COUNT(*) FROM system_logs;
SELECT * FROM logs_by_level;
SELECT * FROM logs_by_service;

-- ═══════════════════════════════════════════════════════════════════════════════
-- MONITORAMENTO (Queries úteis)
-- ═══════════════════════════════════════════════════════════════════════════════

-- Erros mais recentes
SELECT * FROM recent_errors ORDER BY created_at DESC LIMIT 20;

-- Top 10 mensagens de erro
SELECT 
  message,
  COUNT(*) as occurrences,
  MAX(created_at) as last_occurrence
FROM system_logs
WHERE level = 'error'
GROUP BY message
ORDER BY occurrences DESC
LIMIT 10;

-- Taxa de erros por hora
SELECT 
  DATE_TRUNC('hour', created_at) as hour,
  COUNT(*) FILTER (WHERE level = 'error') as errors,
  COUNT(*) as total,
  ROUND(100.0 * COUNT(*) FILTER (WHERE level = 'error') / COUNT(*), 2) as error_rate_pct
FROM system_logs
WHERE created_at > NOW() - INTERVAL '7 days'
GROUP BY DATE_TRUNC('hour', created_at)
ORDER BY hour DESC;
