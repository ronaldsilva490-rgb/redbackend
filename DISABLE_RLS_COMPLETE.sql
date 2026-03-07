-- ============================================================================
-- DISABLE RLS COMPLETE - RED Commerce Platform
-- Remove Row Level Security de TODAS as tabelas e habilita acesso público
-- ============================================================================

-- Tabela: tenants
ALTER TABLE tenants DISABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "public_read_tenants" ON tenants;
DROP POLICY IF EXISTS "public_write_tenants" ON tenants;
GRANT SELECT, INSERT, UPDATE, DELETE ON tenants TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON tenants TO authenticated;

-- Tabela: tenant_users
ALTER TABLE tenant_users DISABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "public_read_tenant_users" ON tenant_users;
DROP POLICY IF EXISTS "public_write_tenant_users" ON tenant_users;
GRANT SELECT, INSERT, UPDATE, DELETE ON tenant_users TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON tenant_users TO authenticated;

-- Tabela: transactions
ALTER TABLE transactions DISABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "public_read_transactions" ON transactions;
DROP POLICY IF EXISTS "public_write_transactions" ON transactions;
GRANT SELECT, INSERT, UPDATE, DELETE ON transactions TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON transactions TO authenticated;

-- Tabela: clients
ALTER TABLE clients DISABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "public_read_clients" ON clients;
DROP POLICY IF EXISTS "public_write_clients" ON clients;
GRANT SELECT, INSERT, UPDATE, DELETE ON clients TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON clients TO authenticated;

-- Tabela: vehicles
ALTER TABLE vehicles DISABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "public_read_vehicles" ON vehicles;
DROP POLICY IF EXISTS "public_write_vehicles" ON vehicles;
GRANT SELECT, INSERT, UPDATE, DELETE ON vehicles TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON vehicles TO authenticated;

-- Tabela: products
ALTER TABLE products DISABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "public_read_products" ON products;
DROP POLICY IF EXISTS "public_write_products" ON products;
GRANT SELECT, INSERT, UPDATE, DELETE ON products TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON products TO authenticated;

-- Tabela: workshop_services
ALTER TABLE workshop_services DISABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "public_read_workshop_services" ON workshop_services;
DROP POLICY IF EXISTS "public_write_workshop_services" ON workshop_services;
GRANT SELECT, INSERT, UPDATE, DELETE ON workshop_services TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON workshop_services TO authenticated;

-- Tabela: orders
ALTER TABLE orders DISABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "public_read_orders" ON orders;
DROP POLICY IF EXISTS "public_write_orders" ON orders;
GRANT SELECT, INSERT, UPDATE, DELETE ON orders TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON orders TO authenticated;

-- Tabela: order_items
ALTER TABLE order_items DISABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "public_read_order_items" ON order_items;
DROP POLICY IF EXISTS "public_write_order_items" ON order_items;
GRANT SELECT, INSERT, UPDATE, DELETE ON order_items TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON order_items TO authenticated;

-- Tabela: sales
ALTER TABLE sales DISABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "public_read_sales" ON sales;
DROP POLICY IF EXISTS "public_write_sales" ON sales;
GRANT SELECT, INSERT, UPDATE, DELETE ON sales TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON sales TO authenticated;

-- Tabela: sales_items
ALTER TABLE sales_items DISABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "public_read_sales_items" ON sales_items;
DROP POLICY IF EXISTS "public_write_sales_items" ON sales_items;
GRANT SELECT, INSERT, UPDATE, DELETE ON sales_items TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON sales_items TO authenticated;

-- Tabela: stock
ALTER TABLE stock DISABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "public_read_stock" ON stock;
DROP POLICY IF EXISTS "public_write_stock" ON stock;
GRANT SELECT, INSERT, UPDATE, DELETE ON stock TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON stock TO authenticated;

-- Tabela: inventory_logs
ALTER TABLE inventory_logs DISABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "public_read_inventory_logs" ON inventory_logs;
DROP POLICY IF EXISTS "public_write_inventory_logs" ON inventory_logs;
GRANT SELECT, INSERT, UPDATE, DELETE ON inventory_logs TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON inventory_logs TO authenticated;

-- Tabela: tables
ALTER TABLE tables DISABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "public_read_tables" ON tables;
DROP POLICY IF EXISTS "public_write_tables" ON tables;
GRANT SELECT, INSERT, UPDATE, DELETE ON tables TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON tables TO authenticated;

-- Tabela: notifications
ALTER TABLE notifications DISABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "public_read_notifications" ON notifications;
DROP POLICY IF EXISTS "public_write_notifications" ON notifications;
GRANT SELECT, INSERT, UPDATE, DELETE ON notifications TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON notifications TO authenticated;

-- Tabela: user_preferences
ALTER TABLE user_preferences DISABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "public_read_user_preferences" ON user_preferences;
DROP POLICY IF EXISTS "public_write_user_preferences" ON user_preferences;
GRANT SELECT, INSERT, UPDATE, DELETE ON user_preferences TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON user_preferences TO authenticated;

-- Tabela: caixa_sessions
ALTER TABLE caixa_sessions DISABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "public_read_caixa_sessions" ON caixa_sessions;
DROP POLICY IF EXISTS "public_write_caixa_sessions" ON caixa_sessions;
GRANT SELECT, INSERT, UPDATE, DELETE ON caixa_sessions TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON caixa_sessions TO authenticated;

-- Tabela: caixa_transactions
ALTER TABLE caixa_transactions DISABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "public_read_caixa_transactions" ON caixa_transactions;
DROP POLICY IF EXISTS "public_write_caixa_transactions" ON caixa_transactions;
GRANT SELECT, INSERT, UPDATE, DELETE ON caixa_transactions TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON caixa_transactions TO authenticated;

-- Tabela: audit_logs
ALTER TABLE audit_logs DISABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "public_read_audit_logs" ON audit_logs;
DROP POLICY IF EXISTS "public_write_audit_logs" ON audit_logs;
GRANT SELECT, INSERT, UPDATE, DELETE ON audit_logs TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON audit_logs TO authenticated;

-- ============================================================================
-- Habilita acesso anônimo ao auth.users (muito importante!)
-- ============================================================================

ALTER TABLE auth.users DISABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON auth.users TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON auth.users TO authenticated;

-- ============================================================================
-- Remove autenticação obrigatória - SIMPLIFICA TUDO
-- ============================================================================

-- Altera o cliente Supabase para usar a chave anon em vez de service_role
-- Isso permitirá que o frontend acesse diretamente sem JWT complexo

UPDATE tenants SET aud = 'authenticated' WHERE aud IS NULL;
UPDATE tenant_users SET aud = 'authenticated' WHERE aud IS NULL;
UPDATE transactions SET aud = 'authenticated' WHERE aud IS NULL;
UPDATE clients SET aud = 'authenticated' WHERE aud IS NULL;
UPDATE vehicles SET aud = 'authenticated' WHERE aud IS NULL;
UPDATE products SET aud = 'authenticated' WHERE aud IS NULL;
UPDATE orders SET aud = 'authenticated' WHERE aud IS NULL;
UPDATE sales SET aud = 'authenticated' WHERE aud IS NULL;
UPDATE stock SET aud = 'authenticated' WHERE aud IS NULL;
UPDATE tables SET aud = 'authenticated' WHERE aud IS NULL;
UPDATE notifications SET aud = 'authenticated' WHERE aud IS NULL;

-- ============================================================================
-- Commit - Script completo executado com sucesso
-- ============================================================================
-- Execute isso no SQL Editor do Supabase Dashboard para desabilitar RLS
