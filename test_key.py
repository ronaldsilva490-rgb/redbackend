#!/usr/bin/env python3
"""Script para testar validação de chave OpenRouter"""
import requests
import json

KEY = "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"

print("=" * 80)
print("TESTE DE VALIDAÇÃO DE CHAVE OPENROUTER")
print("=" * 80)

print(f"\n✓ Chave: {KEY[:30]}...")
print(f"✓ Comprimento: {len(KEY)} caracteres")

# Teste 1: Direct OpenRouter API
print("\n" + "=" * 80)
print("TESTE 1: Conectar diretamente ao OpenRouter")
print("=" * 80)

headers = {
    "Authorization": f"Bearer {KEY}",
    "HTTP-Referer": "https://redcomercialweb.vercel.app",
    "X-Title": "RedCommercial AI Agent",
    "Content-Type": "application/json"
}

try:
    print("\n🔍 Enviando request para https://api.openrouter.io/api/v1/models...")
    resp = requests.get(
        "https://api.openrouter.io/api/v1/models",
        headers=headers,
        timeout=10
    )
    
    print(f"Status: {resp.status_code}")
    
    if resp.status_code == 200:
        print("✅ SUCESSO! Chave é válida!")
        data = resp.json()
        print(f"   Modelos disponíveis: {len(data.get('data', []))}")
    elif resp.status_code == 401:
        print("❌ ERRO 401 Unauthorized - Chave inválida ou expirada")
        print(f"   Resposta: {resp.text[:200]}")
    else:
        print(f"❌ ERRO {resp.status_code}")
        print(f"   Resposta: {resp.text[:200]}")
        
except requests.exceptions.Timeout:
    print("❌ Timeout - OpenRouter não respondeu em 10 segundos")
except requests.exceptions.ConnectionError as e:
    print(f"❌ Erro de conexão: {e}")
except Exception as e:
    print(f"❌ Erro: {e}")

# Teste 2: Backend validation
print("\n" + "=" * 80)
print("TESTE 2: Validar através do backend")
print("=" * 80)

try:
    print("\n🔍 Enviando para backend: POST https://redbackend.fly.dev/api/superadmin/ai-agent/validate-key...")
    resp = requests.post(
        "https://redbackend.fly.dev/api/superadmin/ai-agent/validate-key",
        json={"api_key": KEY},
        headers={"Content-Type": "application/json"},
        timeout=10
    )
    
    print(f"Status: {resp.status_code}")
    data = resp.json()
    print(f"Resposta: {json.dumps(data, indent=2, ensure_ascii=False)}")
    
except Exception as e:
    print(f"❌ Erro: {e}")

print("\n" + "=" * 80)
