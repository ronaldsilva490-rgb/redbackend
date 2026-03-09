-- UPGRADE CONCESSIONÁRIA - LEADS E CUSTOS

-- Tabela de Leads (CRM) se não existir (O schema master já tem uma básica, vamos turbinar)
CREATE TABLE IF NOT EXISTS public.leads (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  nome text NOT NULL,
  telefone text,
  email text,
  origem text DEFAULT 'whatsapp', -- whatsapp, instagram, site, presencial
  status text DEFAULT 'novo', -- novo, em_atendimento, test_drive, proposta, fechado, perdido
  vehicle_id uuid REFERENCES public.vehicles(id) ON DELETE SET NULL,
  valor_oferta numeric,
  obs text,
  vendedor_id uuid REFERENCES public.tenant_users(id),
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  CONSTRAINT leads_pkey PRIMARY KEY (id)
);

-- Tabela de Custos de Preparação do Veículo
CREATE TABLE IF NOT EXISTS public.vehicle_costs (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  vehicle_id uuid NOT NULL REFERENCES public.vehicles(id) ON DELETE CASCADE,
  descricao text NOT NULL,
  valor numeric NOT NULL DEFAULT 0,
  data date DEFAULT CURRENT_DATE,
  categoria text, -- mecanica, estetica, documentacao
  created_at timestamp with time zone DEFAULT now(),
  CONSTRAINT vehicle_costs_pkey PRIMARY KEY (id)
);

-- Habilitar RLS
ALTER TABLE public.leads ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.vehicle_costs ENABLE ROW LEVEL SECURITY;

-- Políticas de Isolamento
CREATE POLICY "Tenant isolation for leads" ON public.leads FOR ALL USING (tenant_id = public.get_tenant_id());
CREATE POLICY "Tenant isolation for vehicle_costs" ON public.vehicle_costs FOR ALL USING (tenant_id = public.get_tenant_id());
