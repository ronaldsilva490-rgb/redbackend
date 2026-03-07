"""Rotas do Agente de IA para análise e modificação de código via Groq"""
import requests
import json
import os
from flask import Blueprint, request, jsonify

ai_agent_bp = Blueprint('ai_agent', __name__, url_prefix='/api/superadmin/ai-agent')

# Groq API
GROQ_API = "https://api.groq.com/openai/v1"
GROQ_API_KEY = os.environ.get('GROQ_API_KEY', '')

# Modelos disponíveis no Groq (verificado em 2026-03-07)
MODELOS_DISPONIVEIS = {
    "llama-3.1-8b-instant": {
        "name": "Llama 3.1 8B Instant (Recomendado)",
        "description": "Rápido e eficiente, perfeito para testes",
        "pricing_tier": "GRÁTIS",
        "is_recommended": True,
        "best_for": "Respostas rápidas e iterações"
    },
    "llama3-70b-8192": {
        "name": "Llama 3 70B",
        "description": "Modelo anterior, excelente para tarefas complexas",
        "pricing_tier": "GRÁTIS",
        "is_recommended": False,
        "best_for": "Análise e modificação de código"
    },
    "gemma-7b-it": {
        "name": "Gemma 7B",
        "description": "Leve e rápido",
        "pricing_tier": "GRÁTIS",
        "is_recommended": False,
        "best_for": "Respostas muito rápidas"
    }
}


def validar_chave_api(chave_api):
    """Validar chave de API do Groq"""
    try:
        print(f"🔍 Validando chave Groq: {chave_api[:15]}...")
        print(f"   Comprimento da chave: {len(chave_api)}")
        headers = {
            "Authorization": f"Bearer {chave_api}",
            "Content-Type": "application/json"
        }
        print(f"   Headers: {list(headers.keys())}")
        resposta = requests.get(
            f"{GROQ_API}/models",
            headers=headers,
            timeout=10
        )
        print(f"   Status: {resposta.status_code}")
        
        if resposta.status_code == 200:
            print(f"✓ Chave Groq válida")
            return True
        else:
            print(f"❌ Erro: status {resposta.status_code}")
            print(f"   Resposta: {resposta.text[:300]}")
            return False
            
    except requests.exceptions.Timeout:
        print("❌ Timeout ao conectar ao Groq")
        return False
    except requests.exceptions.ConnectionError:
        print("❌ Erro de conexão ao Groq")
        return False
    except Exception as e:
        print(f"❌ Erro ao validar chave: {type(e).__name__}: {e}")
        return False


@ai_agent_bp.route('/validate-key', methods=['POST'])
def validar_chave():
    """Validar chave de API do Groq"""
    try:
        dados = request.get_json() or {}
        chave_api = dados.get('api_key', '').strip()
        
        if not chave_api:
            return jsonify({
                "valida": False,
                "valid": False,
                "erro": "Chave de API não fornecida"
            }), 400
        
        print(f"📝 Validando chave Groq...")
        valida = validar_chave_api(chave_api)
        
        return jsonify({
            "valida": valida,
            "valid": valida,
            "mensagem": "Chave de API válida" if valida else "Chave de API inválida ou expirada"
        }), 200
    
    except Exception as e:
        print(f"❌ Erro ao validar chave: {e}")
        return jsonify({
            "valida": False,
            "valid": False,
            "erro": str(e)
        }), 500


@ai_agent_bp.route('/models', methods=['POST', 'GET'])
def obter_modelos():
    """Obter lista de modelos disponíveis do Groq"""
    try:
        # Para o Groq, vamos retornar os modelos conhecidos
        # porque a API de modelos pode ter limitações
        print(f"📥 Retornando modelos do Groq...")
        
        # Converter para formato de resposta similar
        modelos_formatados = []
        for id_modelo, info in MODELOS_DISPONIVEIS.items():
            modelos_formatados.append({
                "id": id_modelo,
                "name": info["name"],
                "description": info["description"],
                "pricing": {"input": 0, "output": 0},
                "is_recommended": info["is_recommended"]
            })
        
        print(f"✓ Retornando {len(modelos_formatados)} modelos do Groq")
        
        return jsonify({
            "sucesso": True,
            "data": modelos_formatados,
            "total": len(modelos_formatados)
        }), 200
    
    except Exception as e:
        print(f"❌ Erro ao buscar modelos: {type(e).__name__}: {e}")
        import traceback
        traceback.print_exc()
        return jsonify({"erro": f"Erro ao buscar modelos: {str(e)}"}), 500


@ai_agent_bp.route('/chat', methods=['POST'])
def conversar_ia():
    """Chat com IA para análise e modificação de código via Groq"""
    print("🔍 Recebido request no /chat")
    print(f"Content-Type: {request.content_type}")
    print(f"Method: {request.method}")
    
    try:
        print(f"📝 Tentando parsear JSON...")
        dados = request.json or {}
        print(f"✓ JSON parseado: {list(dados.keys())}")
        
        prompt = dados.get('prompt', '').strip()
        chave_api = dados.get('api_key', '').strip()
        modelo = dados.get('modelo', 'llama-3.1-8b-instant')
        
        print(f"  prompt: {prompt[:50] if prompt else 'vazio'}...")
        print(f"  chave: {chave_api[:20] if chave_api else 'vazio'}...")
        print(f"  modelo: {modelo}")
        
        if not prompt or not chave_api:
            print(f"❌ Validação falhou: prompt={bool(prompt)}, chave={bool(chave_api)}")
            return jsonify({
                "erro": "Prompt e api_key são obrigatórios"
            }), 400
        
        print(f"🤖 Enviando prompt para Groq via modelo: {modelo}")
        
        if not validar_chave_api(chave_api):
            print(f"❌ Chave inválida")
            return jsonify({
                "erro": "Chave de API inválida"
            }), 401
        
        headers = {
            "Authorization": f"Bearer {chave_api}",
            "Content-Type": "application/json"
        }
        
        carga = {
            "model": modelo,
            "messages": [
                {
                    "role": "system",
                    "content": "Você é um assistente de desenvolvimento web especializado. Responda sempre em português do Brasil."
                },
                {
                    "role": "user",
                    "content": prompt
                }
            ],
            "temperature": 0.7,
            "max_tokens": 2000
        }
        
        print(f"📤 Chamando API Groq com modelo: {modelo}")
        resposta = requests.post(
            f"{GROQ_API}/chat/completions",
            headers=headers,
            json=carga,
            timeout=60
        )
        
        print(f"Status: {resposta.status_code}")
        
        if resposta.status_code != 200:
            erro_msg = resposta.text or "Erro desconhecido"
            print(f"❌ Erro na API: {erro_msg}")
            return jsonify({
                "erro": f"Erro ao chamar API Groq: {erro_msg}",
                "status": resposta.status_code
            }), resposta.status_code
        
        dados_resposta = resposta.json()
        conteudo = dados_resposta.get('choices', [{}])[0].get('message', {}).get('content', 'Sem resposta')
        
        print(f"✓ Resposta recebida da IA")
        
        return jsonify({
            "sucesso": True,
            "resposta": conteudo
        }), 200
    
    except requests.exceptions.Timeout:
        print("❌ Timeout na requisição")
        return jsonify({
            "erro": "Timeout ao conectar com a IA. Tente novamente."
        }), 504
    except Exception as e:
        print(f"❌ Erro ao conversar com IA: {e}")
        return jsonify({
            "erro": f"Erro ao processar: {str(e)}"
        }), 500


@ai_agent_bp.route('/debug-connection', methods=['GET'])
def debug_conexao():
    """Debug endpoint para testar conectividade"""
    import socket
    import ssl
    from urllib.parse import urlparse
    
    print("\n" + "="*60)
    print("🔍 TESTANDO CONECTIVIDADE")
    print("="*60)
    
    debug_info = {
        "timestamp": str(__import__('datetime').datetime.now()),
        "tests": {}
    }
    
    # Test 1: httpbin (site genérico para teste)
    print("\n1️⃣ TESTANDO httpbin.org (site de teste)...")
    try:
        resposta = requests.get("https://httpbin.org/get", timeout=10)
        print(f"✓ httpbin.org respondeu com status {resposta.status_code}")
        debug_info["tests"]["httpbin"] = {
            "status": "OK",
            "http_status": resposta.status_code
        }
    except Exception as e:
        print(f"❌ Erro com httpbin: {e}")
        debug_info["tests"]["httpbin"] = {"status": "FAILED", "error": str(e)}
    
    # Test 2: Google (site mais genérico ainda)
    print("\n2️⃣ TESTANDO google.com...")
    try:
        resposta = requests.get("https://www.google.com", timeout=10)
        print(f"✓ Google respondeu com status {resposta.status_code}")
        debug_info["tests"]["google"] = {
            "status": "OK",
            "http_status": resposta.status_code
        }
    except Exception as e:
        print(f"❌ Erro com Google: {e}")
        debug_info["tests"]["google"] = {"status": "FAILED", "error": str(e)}
    
    # Test 3: Groq (novo)
    print("\n3️⃣ TESTANDO api.groq.com...")
    try:
        resposta = requests.get("https://api.groq.com/openai/v1/models", timeout=10)
        print(f"✓ Groq respondeu com status {resposta.status_code}")
        debug_info["tests"]["groq"] = {
            "status": "OK",
            "http_status": resposta.status_code
        }
    except Exception as e:
        print(f"❌ Erro com Groq: {e}")
        debug_info["tests"]["groq"] = {"status": "FAILED", "error": str(e)[:200]}
    
    print("\n" + "="*60)
    print("📊 RESULTADO")
    print("="*60)
    httpbin_ok = debug_info["tests"].get("httpbin", {}).get("status") == "OK"
    google_ok = debug_info["tests"].get("google", {}).get("status") == "OK"
    groq_ok = debug_info["tests"].get("groq", {}).get("status") == "OK"
    
    if not httpbin_ok and not google_ok:
        print("❌ Container NÃO consegue fazer nenhuma requisição HTTPS pra fora")
        print("   Problema: Fly.io bloqueou acesso externo")
    elif not groq_ok:
        print("⚠️  Container consegue fazer HTTPS (httpbin/google OK)")
        print("   MAS Groq especificamente não funciona")
        print("   Problema: Fly.io bloqueou especificamente Groq OU DNS")
    else:
        print("✓ Tudo OK! Container consegue conectar com Groq")
    
    return jsonify(debug_info), 200
