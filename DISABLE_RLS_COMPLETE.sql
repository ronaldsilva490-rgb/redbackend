-- ============================================================================
-- DISABLE RLS COMPLETE - RED Commerce Platform
-- Remove Row Level Security de TODAS as tabelas automaticamente
-- ============================================================================

-- 1. REMOVE TODAS AS POLICIES EXISTENTES
DO $$
DECLARE
    r RECORD;
BEGIN
    FOR r IN (
        SELECT schemaname, tablename, policyname
        FROM pg_policies
        WHERE schemaname = 'public'
    ) LOOP
        EXECUTE 'DROP POLICY IF EXISTS "' || r.policyname || '" ON ' || r.schemaname || '.' || r.tablename;
    END LOOP;
END $$;

-- 2. DESABILITA RLS DE TODAS AS TABELAS DO SCHEMA PUBLIC
DO $$
DECLARE
    r RECORD;
BEGIN
    FOR r IN (
        SELECT tablename
        FROM pg_tables
        WHERE schemaname = 'public'
    ) LOOP
        EXECUTE 'ALTER TABLE public.' || r.tablename || ' DISABLE ROW LEVEL SECURITY';
    END LOOP;
END $$;

-- 3. HABILITA ACESSO ANÔNIMO E AUTENTICADO EM TODAS AS TABELAS
DO $$
DECLARE
    r RECORD;
BEGIN
    FOR r IN (
        SELECT tablename
        FROM pg_tables
        WHERE schemaname = 'public'
    ) LOOP
        EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON public.' || r.tablename || ' TO anon';
        EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON public.' || r.tablename || ' TO authenticated';
    END LOOP;
END $$;

-- 4. HABILITA ACESSO AO SCHEMA AUTH
ALTER TABLE auth.users DISABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON auth.users TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON auth.users TO authenticated;

-- ============================================================================
-- RESULTADO ESPERADO
-- ============================================================================
-- Se você ver "Success" ou nenhuma mensagem de erro, RLS foi TOTALMENTE desabilitado!
-- Todas as ~30+ tabelas agora têm acesso público.
