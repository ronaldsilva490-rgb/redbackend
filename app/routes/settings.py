"""
settings.py — Persistência de configurações do superadmin no banco de dados.
API Keys e preferências ficam salvas no Supabase, não mais no localStorage.

Para criar a tabela no Supabase, execute este SQL:
  CREATE TABLE IF NOT EXISTS superadmin_settings (
    key        TEXT PRIMARY KEY,
    value      JSONB NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT NOW()
  );
"""
from flask import Blueprint, request, jsonify
from ..routes.superadmin import require_superadmin
from ..utils.supabase_client import get_supabase_admin

settings_bp = Blueprint('settings', __name__)


@settings_bp.get('/settings')
@require_superadmin
def get_settings():
    """Retorna todas as configurações do superadmin."""
    try:
        sb = get_supabase_admin()
        r  = sb.table('superadmin_settings').select('key, value, updated_at').execute()
        # Transforma em {key: value} para o frontend
        result = {}
        for row in (r.data or []):
            result[row['key']] = row['value']
        return jsonify({'data': result})
    except Exception as e:
        return jsonify({'data': {}, 'warning': f'Tabela superadmin_settings não encontrada: {str(e)[:120]}'}), 200


@settings_bp.get('/settings/<key>')
@require_superadmin
def get_setting(key):
    """Retorna uma configuração específica."""
    try:
        sb = get_supabase_admin()
        r  = sb.table('superadmin_settings').select('value').eq('key', key).limit(1).execute()
        if r.data:
            return jsonify({'data': r.data[0]['value']})
        return jsonify({'data': None})
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@settings_bp.put('/settings/<key>')
@require_superadmin
def set_setting(key):
    """Salva ou atualiza uma configuração."""
    body  = request.get_json() or {}
    value = body.get('value')
    if value is None:
        return jsonify({'error': 'Campo "value" é obrigatório'}), 400

    try:
        sb = get_supabase_admin()
        sb.table('superadmin_settings').upsert({
            'key': key, 'value': value, 'updated_at': 'NOW()',
        }, on_conflict='key').execute()
        return jsonify({'ok': True})
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@settings_bp.delete('/settings/<key>')
@require_superadmin
def delete_setting(key):
    """Remove uma configuração."""
    try:
        sb = get_supabase_admin()
        sb.table('superadmin_settings').delete().eq('key', key).execute()
        return jsonify({'ok': True})
    except Exception as e:
        return jsonify({'error': str(e)}), 500
