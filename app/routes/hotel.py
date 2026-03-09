"""
MÓDULO DE HOTELARIA E HOSPEDAGEM (SaaS)
"""
from flask import Blueprint, request, jsonify
from datetime import datetime, date
from uuid import UUID

from ..utils.auth import auth_required, get_current_user
from ..config.supabase import get_supabase

hotel_bp = Blueprint("hotel", __name__)

@hotel_bp.get("/dashboard")
@auth_required
def get_hotel_dashboard():
    """
    GET /api/hotel/dashboard
    Retorna Ocupação %, Check-ins previstos, Check-outs e Receita hospedagem.
    """
    user = get_current_user()
    tenant_id = user["tenant_id"]
    sb = get_supabase()

    try:
        # Pega a Data Atual no timezone UTC (Simplificado para o momento)
        hoje_texto = datetime.now().strftime("%Y-%m-%d")

        # 1. Total e Ocupados (Acomodacoes)
        r_acomodacoes = sb.table("acomodacoes").select("id, status").eq("tenant_id", tenant_id).execute()
        acom_list = r_acomodacoes.data or []
        total_quartos = len(acom_list)
        ocupados = len([q for q in acom_list if q.get("status") == "ocupado"])
        
        ocupacao_pct = 0
        if total_quartos > 0:
            ocupacao_pct = int((ocupados / total_quartos) * 100)

        # 2. Status das Reservas de HOJE e em Curso
        r_reservas = sb.table("reservas").select("id, status, valor_total, data_checkin, data_checkout").eq("tenant_id", tenant_id).execute()
        res_list = r_reservas.data or []

        checkins_hoje = 0
        checkouts_hoje = 0
        reservas_ativas = 0
        receita_estadia = 0.0

        for r in res_list:
            status = r.get("status")
            
            # Conta as Reservas Em Curso ou Agendadas
            if status in ["em_curso", "agendada"]:
                reservas_ativas += 1
            
            # Receitas das que estao em curso
            if status == "em_curso":
                receita_estadia += float(r.get("valor_total", 0))
            
            # Check-ins e Check-outs do dia especifico
            data_in = r.get("data_checkin") or ""
            data_out = r.get("data_checkout") or ""
            
            if hoje_texto in data_in and status == "agendada":
                checkins_hoje += 1
            if hoje_texto in data_out and status == "em_curso":
                checkouts_hoje += 1

        return jsonify({
            "status": "success",
            "data": {
                "ocupacao_pct": ocupacao_pct,
                "checkins_hoje": checkins_hoje,
                "checkouts_hoje": checkouts_hoje,
                "reservas_ativas": reservas_ativas,
                "receita_hospedes": receita_estadia
            }
        }), 200

    except Exception as e:
        print(f"[HOTEL DASHBOARD ERROR] {e}")
        return jsonify({"error": str(e)}), 500


@hotel_bp.get("/acomodacoes")
@auth_required
def list_acomodacoes():
    """GET /api/hotel/acomodacoes - Lista todos os quartos da Hospedagem"""
    user = get_current_user()
    tenant_id = user["tenant_id"]
    sb = get_supabase()

    try:
        r = sb.table("acomodacoes").select("*").eq("tenant_id", tenant_id).execute()
        return jsonify({"status": "success", "data": r.data}), 200
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@hotel_bp.post("/acomodacoes")
@auth_required
def create_acomodacao():
    """POST /api/hotel/acomodacoes - Criar um novo quarto"""
    user = get_current_user()
    tenant_id = user["tenant_id"]
    if user["papel"] not in ["dono", "gerente"]:
        return jsonify({"error": "Acesso negado."}), 403

    sb = get_supabase()
    body = request.json or {}

    payload = {
        "tenant_id": tenant_id,
        "numero": str(body.get("numero", "")),
        "tipo": body.get("tipo", "padrao"),
        "capacidade": int(body.get("capacidade", 2)),
        "diaria_padrao": float(body.get("diaria_padrao", 0.0)),
        "status": body.get("status", "livre"),
        "descricao": body.get("descricao", "")
    }

    try:
        r = sb.table("acomodacoes").insert(payload).execute()
        return jsonify({"status": "success", "data": r.data[0]}), 201
    except Exception as e:
        return jsonify({"error": str(e)}), 400


@hotel_bp.get("/reservas")
@auth_required
def list_reservas():
    """GET /api/hotel/reservas - Lista todas as reservas"""
    user = get_current_user()
    tenant_id = user["tenant_id"]
    sb = get_supabase()

    try:
        # Idealmente trazer com inner join do nome do hospede e n do quarto,
        # mas faremos nativo do supabase no frontend futuramente pra tabelas complexas.
        r = sb.table("reservas").select("*, clients(nome, telefone), acomodacoes(numero, tipo)").eq("tenant_id", tenant_id).execute()
        return jsonify({"status": "success", "data": r.data}), 200
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@hotel_bp.post("/reservas")
@auth_required
def create_reserva():
    """POST /api/hotel/reservas - Agendar novo Check-in/Reserva"""
    user = get_current_user()
    tenant_id = user["tenant_id"]
    sb = get_supabase()
    body = request.json or {}

    try:
        payload = {
            "tenant_id": tenant_id,
            "client_id": body.get("client_id"),
            "acomodacao_id": body.get("acomodacao_id"),
            "data_checkin": body.get("data_checkin"),
            "data_checkout": body.get("data_checkout") or None,
            "status": body.get("status", "agendada"),
            "valor_total": float(body.get("valor_total", 0.0)),
            "observacoes": body.get("observacoes", "")
        }

        # Insere a Reserva
        r = sb.table("reservas").insert(payload).execute()
        nova_reserva = r.data[0]

        # Se for um Check-in imediato, já muda o quarto para 'ocupado'
        if payload["status"] == "em_curso":
            sb.table("acomodacoes").update({"status": "ocupado"}).eq("id", payload["acomodacao_id"]).execute()

        return jsonify({"status": "success", "data": nova_reserva}), 201
    except Exception as e:
        return jsonify({"error": str(e)}), 400
