#!/usr/bin/env python3
# validate_schema.py
# Script para validar se o schema está completo no Supabase

import os
from supabase import create_client

url = os.getenv("SUPABASE_URL")
key = os.getenv("SUPABASE_KEY")
client = create_client(url, key)
db = client.postgrest

expected_tables = [
    'tenants',
    'tenant_users',
    'clients',
    'products',
    'categories',
    'transactions',
    'estoque_movimentacoes',
    'tenant_config',
    'user_preferences'
]

print("🔍 Validando Schema...\n")

# Obter tabelas existentes
try:
    # Teste simples: tentar acessar cada tabela
    for table in expected_tables:
        try:
            response = db.table(table).select('count', count='exact').execute()
            print(f"✅ {table:30} - EXISTS")
        except Exception as e:
            print(f"❌ {table:30} - MISSING")
            print(f"   Erro: {str(e)[:50]}")
    
    print("\n" + "="*60)
    print("🎯 Verificação Completa")
    print("="*60)
    
except Exception as e:
    print(f"❌ Erro ao conectar Supabase: {e}")

# Validar alguns endpoints
print("\n🔌 Testando Endpoints API...\n")

import requests

base_url = "http://localhost:5000/api"

endpoints = [
    ("GET", "/inventory/resumo"),
    ("GET", "/finance/dashboard"),
    ("GET", "/preferences"),
]

for method, endpoint in endpoints:
    try:
        if method == "GET":
            resp = requests.get(f"{base_url}{endpoint}", timeout=5)
        print(f"✅ {method:6} {endpoint:30} - {resp.status_code}")
    except Exception as e:
        print(f"⚠️  {method:6} {endpoint:30} - Backend não respondeu")

print("\n✨ Validação concluída!")
