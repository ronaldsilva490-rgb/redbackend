"""Rotas do Agente de IA para análise e modificação de código via OpenRouter"""
import requests
import json
from flask import Blueprint, request, jsonify

ai_agent_bp = Blueprint('ai_agent', __name__, url_prefix='/api/superadmin/ai-agent')

# OpenRouter API
OPENROUTER_API = "https://api.openrouter.io/api/v1"

# Modelos recomendados para desenvolvimento
MODELOS_RECOMENDADOS = {
    "openrouter/auto": {
        "name": "OpenRouter Auto (Recomendado)",
        "description": "Seleciona automaticamente o melhor modelo livre",
        "pricing_tier": "GRÁTIS",
        "is_recommended": True,
        "best_for": "Tarefas gerais de desenvolvimento"
    },
    "meta-llama/llama-2-70b-chat": {
        "name": "Llama 2 70B (Excelente)",
        "description": "Alta qualidade, muito capaz para código",
        "pricing_tier": "GRÁTIS",
        "is_recommended": True,
        "best_for": "Análise e modificação de código"
    },
    "mistralai/mistral-7b-instruct": {
        "name": "Mistral 7B",
        "description": "Rápido e preciso",
        "pricing_tier": "GRÁTIS",
        "is_recommended": True,
        "best_for": "Iterações rápidas"
    }
}


def validar_chave_api(chave_api):
    """Validar chave de API do OpenRouter"""
    try:
        print(f"🔍 Validando chave de API: {chave_api[:15]}...")
        print(f"   Comprimento da chave: {len(chave_api)}")
        headers = {
            "Authorization": f"Bearer {chave_api}",
            "HTTP-Referer": "https://redcomercialweb.vercel.app",
            "X-Title": "RedCommercial AI Agent",
            "Content-Type": "application/json"
        }
        print(f"   Headers: {list(headers.keys())}")
        resposta = requests.get(
            f"{OPENROUTER_API}/models",
            headers=headers,
            timeout=10
        )
        print(f"   Status: {resposta.status_code}")
        
        if resposta.status_code == 200:
            print(f"✓ Chave de API válida")
            return True
        else:
            print(f"❌ Erro: status {resposta.status_code}")
            print(f"   Resposta: {resposta.text[:300]}")
            return False
            
    except requests.exceptions.Timeout:
        print("❌ Timeout ao conectar ao OpenRouter")
        return False
    except requests.exceptions.ConnectionError:
        print("❌ Erro de conexão ao OpenRouter")
        return False
    except Exception as e:
        print(f"❌ Erro ao validar chave: {type(e).__name__}: {e}")
        return False


@ai_agent_bp.route('/validate-key', methods=['POST'])
def validar_chave():
    """Validar chave de API do OpenRouter"""
    try:
        dados = request.get_json() or {}
        chave_api = dados.get('api_key', '').strip()
        
        if not chave_api:
            return jsonify({
                "valida": False,
                "valid": False,
                "erro": "Chave de API não fornecida"
            }), 400
        
        print(f"📝 Validando chave de API...")
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
    """Obter lista de modelos disponíveis do OpenRouter"""
    try:
        # Aceitar chave tanto por GET header quanto POST body
        if request.method == 'POST':
            dados = request.get_json() or {}
            chave_api = dados.get('api_key') or request.headers.get('X-API-Key') or request.headers.get('Authorization', '').replace('Bearer ', '')
        else:
            chave_api = request.headers.get('X-API-Key') or request.headers.get('Authorization', '').replace('Bearer ', '')
        
        if not chave_api:
            return jsonify({"erro": "Chave de API obrigatória"}), 400
        
        print(f"📥 Buscando modelos com chave: {chave_api[:20]}...")
        
        headers = {
            "Authorization": f"Bearer {chave_api}",
            "HTTP-Referer": "https://redcomercialweb.vercel.app",
            "X-Title": "RedCommercial AI Agent",
            "Content-Type": "application/json"
        }
        
        print(f"Headers: {list(headers.keys())}")
        
        resposta = requests.get(
            f"{OPENROUTER_API}/models",
            headers=headers,
            timeout=10
        )
        
        print(f"Status OpenRouter: {resposta.status_code}")
        
        if resposta.status_code == 401:
            return jsonify({"erro": "Chave de API inválida ou expirada"}), 401
        
        if resposta.status_code != 200:
            print(f"❌ Erro {resposta.status_code}: {resposta.text[:300]}")
            return jsonify({"erro": f"Erro ao buscar modelos: {resposta.status_code}"}), 400
        
        todos_modelos = resposta.json().get('data', [])
        print(f"✓ Recebidos {len(todos_modelos)} modelos do OpenRouter")
        
        # Processar e retornar modelos como está
        modelos_processados = []
        for m in todos_modelos:
            modelos_processados.append({
                "id": m.get('id'),
                "name": m.get('name', m.get('id')),
                "description": m.get('description', ''),
                "pricing": m.get('pricing', {}),
                "is_recommended": m.get('id') in MODELOS_RECOMENDADOS
            })
        
        # Ordenar com recomendados primeiro
        modelos_processados.sort(key=lambda x: (not x.get('is_recommended', False), x['name']))
        
        print(f"✓ Retornando {len(modelos_processados)} modelos processados")
        
        return jsonify({
            "sucesso": True,
            "data": modelos_processados,
            "total": len(modelos_processados)
        }), 200
    
    except Exception as e:
        print(f"❌ Erro ao buscar modelos: {type(e).__name__}: {e}")
        import traceback
        traceback.print_exc()
        return jsonify({"erro": f"Erro ao buscar modelos: {str(e)}"}), 500


@ai_agent_bp.route('/chat', methods=['POST'])
def conversar_ia():
    """Chat com IA para análise e modificação de código"""
    try:
        dados = request.json or {}
        prompt = dados.get('prompt', '').strip()
        chave_api = dados.get('api_key', '').strip()
        modelo = dados.get('modelo', 'openrouter/auto')
        
        if not prompt or not chave_api:
            return jsonify({
                "erro": "Prompt e chave_api são obrigatórios"
            }), 400
        
        print(f"🤖 Enviando prompt para IA...")
        
        if not validar_chave_api(chave_api):
            return jsonify({
                "erro": "Chave de API inválida"
            }), 401
        
        headers = {
            "Authorization": f"Bearer {chave_api}",
            "HTTP-Referer": "https://redcomercialweb.vercel.app",
            "X-Title": "RedCommercial AI Agent",
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
        
        print(f"📤 Chamando API OpenRouter com modelo: {modelo}")
        resposta = requests.post(
            f"{OPENROUTER_API}/chat/completions",
            headers=headers,
            json=carga,
            timeout=60
        )
        
        print(f"Status: {resposta.status_code}")
        
        if resposta.status_code != 200:
            erro_msg = resposta.text or "Erro desconhecido"
            print(f"❌ Erro na API: {erro_msg}")
            return jsonify({
                "erro": f"Erro ao chamar API OpenRouter: {erro_msg}",
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
