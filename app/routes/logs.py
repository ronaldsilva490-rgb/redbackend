"""
logs.py — Endpoint de logs do sistema para superadmin.
Lê logs do Supabase (tabela system_logs) com filtros de nível, serviço e busca.

Para criar a tabela no Supabase, execute este SQL:
  CREATE TABLE IF NOT EXISTS system_logs (
    id          BIGSERIAL PRIMARY KEY,
    level       TEXT NOT NULL DEFAULT 'info',   -- error | warning | info | debug
    service     TEXT NOT NULL DEFAULT 'backend',
    message     TEXT NOT NULL,
    details     JSONB,
    created_at  TIMESTAMPTZ DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS idx_system_logs_level   ON system_logs(level);
  CREATE INDEX IF NOT EXISTS idx_system_logs_service ON system_logs(service);
  CREATE INDEX IF NOT EXISTS idx_system_logs_created ON system_logs(created_at DESC);
"""
from flask import Blueprint, request, jsonify
from ..routes.superadmin import require_superadmin
from ..utils.supabase_client import get_supabase_admin

logs_bp = Blueprint('logs', __name__)


@logs_bp.get('/logs')
@require_superadmin
def get_logs():
    """Lista logs com filtros opcionais de nível, serviço e busca."""
    level   = request.args.get('level')
    service = request.args.get('service')
    search  = request.args.get('search', '').strip()
    limit   = min(int(request.args.get('limit', 200)), 500)

    try:
        sb = get_supabase_admin()
        q  = sb.table('system_logs').select('*').order('created_at', desc=True).limit(limit)

        if level:
            q = q.eq('level', level)
        if service:
            q = q.eq('service', service)
        if search:
            q = q.ilike('message', f'%{search}%')

        r = q.execute()
        # Renomeia created_at → timestamp para o frontend
        logs = []
        for row in (r.data or []):
            logs.append({
                'id':        row.get('id'),
                'level':     row.get('level', 'info'),
                'service':   row.get('service', 'backend'),
                'message':   row.get('message', ''),
                'details':   row.get('details'),
                'timestamp': row.get('created_at'),
            })
        return jsonify({'data': logs})
    except Exception as e:
        # Se a tabela ainda não existe, retorna lista vazia com instrução
        return jsonify({
            'data': [],
            'warning': f'Tabela system_logs não encontrada. Execute o SQL de criação. Erro: {str(e)[:120]}'
        })


@logs_bp.post('/logs')
@require_superadmin
def create_log():
    """Insere um log manualmente (útil para testes)."""
    body    = request.get_json() or {}
    level   = body.get('level', 'info')
    service = body.get('service', 'backend')
    message = body.get('message', '')
    details = body.get('details')

    if not message:
        return jsonify({'error': 'message é obrigatório'}), 400

    try:
        sb = get_supabase_admin()
        r  = sb.table('system_logs').insert({
            'level': level, 'service': service,
            'message': message, 'details': details,
        }).execute()
        return jsonify({'data': r.data[0] if r.data else {}})
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@logs_bp.delete('/logs')
@require_superadmin
def clear_logs():
    """Limpa logs mais antigos que N dias (padrão 30)."""
    days = int(request.args.get('days', 30))
    try:
        sb = get_supabase_admin()
        sb.rpc('exec_sql', {
            'query': f"DELETE FROM system_logs WHERE created_at < NOW() - INTERVAL '{days} days'"
        }).execute()
        return jsonify({'ok': True, 'message': f'Logs mais antigos que {days} dias removidos.'})
    except Exception as e:
        return jsonify({'error': str(e)}), 500
