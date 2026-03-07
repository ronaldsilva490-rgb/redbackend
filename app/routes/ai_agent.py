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
        headers = {
            "Authorization": f"Bearer {chave_api}",
            "HTTP-Referer": "https://redcomercialweb.vercel.app",
            "X-Title": "RedCommercial AI Agent",
            "Content-Type": "application/json"
        }
        resposta = requests.get(
            f"{OPENROUTER_API}/models",
            headers=headers,
            timeout=10
        )
        valida = resposta.status_code == 200
        if valida:
            print(f"✓ Chave de API válida")
        else:
            print(f"❌ Erro: status {resposta.status_code}")
        return valida
    except requests.exceptions.Timeout:
        print("❌ Timeout ao conectar ao OpenRouter")
        return False
    except requests.exceptions.ConnectionError:
        print("❌ Erro de conexão ao OpenRouter")
        return False
    except Exception as e:
        print(f"❌ Erro ao validar chave: {e}")
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


@ai_agent_bp.route('/models', methods=['GET'])
def obter_modelos():
    """Obter lista de modelos disponíveis do OpenRouter"""
    try:
        chave_api = request.headers.get('X-API-Key')
        if not chave_api:
            return jsonify({
                "erro": "Chave de API obrigatória no header X-API-Key"
            }), 400
        
        print(f"📥 Buscando modelos...")
        if not validar_chave_api(chave_api):
            return jsonify({
                "erro": "Chave de API inválida ou expirada"
            }), 401
        
        headers = {
            "Authorization": f"Bearer {chave_api}",
            "HTTP-Referer": "https://redcomercialweb.vercel.app",
            "X-Title": "RedCommercial AI Agent",
            "Content-Type": "application/json"
        }
        
        resposta = requests.get(
            f"{OPENROUTER_API}/models",
            headers=headers,
            timeout=10
        )
        
        if resposta.status_code != 200:
            print(f"❌ Erro ao buscar modelos: {resposta.status_code}")
            return jsonify({
                "erro": "Falha ao buscar modelos do OpenRouter"
            }), 400
        
        todos_modelos = resposta.json().get('data', [])
        
        modelos_livres = []
        modelos_pagos = []
        
        for modelo in todos_modelos:
            modelo_id = modelo.get('id', '')
            preco = modelo.get('pricing', {})
            
            try:
                eh_livre = (
                    float(preco.get('prompt', 1)) == 0 and
                    float(preco.get('completion', 1)) == 0
                )
            except:
                eh_livre = False
            
            info_modelo = {
                "id": modelo_id,
                "name": modelo.get('name', modelo_id),
                "description": modelo.get('description', ''),
                "is_recommended": False,
                "best_for": "Desenvolvimento",
                "pricing_tier": "GRÁTIS" if eh_livre else "PAGO"
            }
            
            # Marcar modelos recomendados
            if modelo_id in MODELOS_RECOMENDADOS:
                info_modelo.update(MODELOS_RECOMENDADOS[modelo_id])
            elif eh_livre and any(palavra in modelo_id.lower() for palavra in ['llama', 'mistral', 'neural']):
                info_modelo["is_recommended"] = True
            
            if eh_livre:
                modelos_livres.append(info_modelo)
            else:
                modelos_pagos.append(info_modelo)
        
        # Ordenar recomendados primeiro
        modelos_livres.sort(key=lambda x: (not x.get('is_recommended', False), x['name']))
        
        print(f"✓ {len(modelos_livres)} modelos livres encontrados")
        
        return jsonify({
            "sucesso": True,
            "modelos_livres": modelos_livres,
            "modelos_pagos": modelos_pagos[:10],
            "recomendado_para_desenvolvimento": [m for m in modelos_livres if m.get('is_recommended')]
        }), 200
    
    except Exception as e:
        print(f"❌ Erro ao buscar modelos: {e}")
        return jsonify({
            "erro": f"Erro ao buscar modelos: {str(e)}"
        }), 500


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
