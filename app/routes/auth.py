"""
auth.py — Autenticação RED SaaS
Suporte a login por USERNAME (sem @email) ou EMAIL.
Usernames são armazenados como username@red.internal no Supabase Auth.
"""
from flask import Blueprint, request
from ..utils.supabase_client import get_supabase, get_supabase_admin
from ..utils.auth_middleware import require_auth
from app.config.business_types import validate_business_type, get_all_business_types
from ..utils.response import success, error
import re

auth_bp = Blueprint("auth", __name__)

INTERNAL_DOMAIN = "@red.internal"


def slugify(text):
    text = text.lower().strip()
    text = re.sub(r'[^\w\s-]', '', text)
    text = re.sub(r'[\s_-]+', '-', text)
    return text[:50]


def is_username(login: str) -> bool:
    """Retorna True se login é username (sem @), False se é email."""
    return "@" not in login


def to_auth_email(login: str) -> str:
    """Converte login para email usado no Supabase Auth."""
    if is_username(login):
        return login.lower().strip() + INTERNAL_DOMAIN
    return login.lower().strip()


def check_username_available(sb, username: str, tenant_id: str = None) -> bool:
    """Verifica se username está disponível (globalmente ou no tenant)."""
    auth_email = to_auth_email(username)
    # Tenta achar no auth — se não lança exceção, existe
    try:
        users = sb.auth.admin.list_users()
        for u in users:
            if u.email == auth_email:
                return False
        return True
    except Exception:
        return True


@auth_bp.post("/register")
def register():
    """Cria usuário + tenant + vínculo como dono."""
    body     = request.get_json() or {}
    login    = body.get("email", "").strip()   # aceita email ou username
    password = body.get("password", "")
    tenant   = body.get("tenant", {})

    if not login or not password:
        return error("Login e senha são obrigatórios")
    if not tenant.get("nome"):
        return error("Nome do negócio é obrigatório")
    tipo = (tenant.get("tipo") or "").strip()
    if not validate_business_type(tipo):
        allowed = ", ".join(get_all_business_types())
        return error(f"Tipo inválido. Use: {allowed}")

    auth_email = to_auth_email(login)
    sb = get_supabase_admin()

    try:
        auth_resp = sb.auth.admin.create_user({
            "email":         auth_email,
            "password":      password,
            "email_confirm": True,
        })
        user_id = auth_resp.user.id
    except Exception as e:
        msg = str(e)
        if "already registered" in msg or "already exists" in msg:
            return error("Este login já está cadastrado", 409)
        return error(f"Erro ao criar usuário: {msg}", 400)

    try:
        slug_base = slugify(tenant["nome"])
        slug = slug_base
        i = 1
        while True:
            existing = sb.table("tenants").select("id").eq("slug", slug).execute()
            if not existing.data:
                break
            slug = f"{slug_base}-{i}"
            i += 1

        tenant_resp = sb.table("tenants").insert({
            "nome":     tenant["nome"].strip(),
            "slug":     slug,
            "tipo":     tenant["tipo"],
            "cnpj":     tenant.get("cnpj") or None,
            "telefone": tenant.get("telefone") or None,
            "cidade":   tenant.get("cidade") or None,
            "estado":   tenant.get("estado") or None,
        }).execute()
        tenant_id = tenant_resp.data[0]["id"]
    except Exception as e:
        try: sb.auth.admin.delete_user(user_id)
        except: pass
        return error(f"Erro ao criar negócio: {str(e)}", 500)

    try:
        sb.table("tenant_users").insert({
            "tenant_id": tenant_id,
            "user_id":   user_id,
            "papel":     "dono",
            "username":  login if is_username(login) else None,
        }).execute()
    except Exception as e:
        return error(f"Erro ao vincular usuário: {str(e)}", 500)

    return success({"tenant_id": tenant_id, "slug": slug}, "Negócio criado com sucesso!", 201)


@auth_bp.post("/login")
def login():
    body     = request.get_json() or {}
    login    = body.get("email", "").strip()
    password = body.get("password", "")

    if not login or not password:
        return error("Login e senha são obrigatórios")

    auth_email = to_auth_email(login)

    try:
        resp = get_supabase().auth.sign_in_with_password({
            "email": auth_email, "password": password
        })

        import os
        SUPERADMIN_EMAIL = os.getenv("SUPERADMIN_EMAIL", "")

        # ── Superadmin: pula verificação de tenant ──────────
        if SUPERADMIN_EMAIL and resp.user.email == SUPERADMIN_EMAIL:
            return success({
                "access_token":  resp.session.access_token,
                "refresh_token": resp.session.refresh_token,
                "user": {
                    "id":       resp.user.id,
                    "email":    resp.user.email,
                    "username": "superadmin",
                },
                "tenant": None,
                "papel":  "superadmin",
            })

        # ── Login normal ────────────────────────────────────
        sb = get_supabase_admin()
        tenant_resp = sb.table("tenant_users") \
            .select("tenant_id, papel, username, tenants(*)") \
            .eq("user_id", resp.user.id) \
            .eq("ativo", True) \
            .limit(1) \
            .execute()

        tenant_data = tenant_resp.data[0] if tenant_resp.data else None
        if not tenant_data:
            return error("Usuário sem empresa vinculada. Contate o administrador.", 403)

        display_login = tenant_data.get("username") or login

        return success({
            "access_token":  resp.session.access_token,
            "refresh_token": resp.session.refresh_token,
            "user": {
                "id":       resp.user.id,
                "email":    resp.user.email,
                "username": display_login,
            },
            "tenant": tenant_data["tenants"],
            "papel":  tenant_data["papel"],
        })
    except Exception as e:
        msg = str(e)
        if "Invalid login" in msg or "invalid_credentials" in msg:
            return error("Login ou senha incorretos", 401)
        return error("Erro ao fazer login", 401)

@auth_bp.post("/check-username")
def check_username():
    """Verifica se um username está disponível."""
    body     = request.get_json() or {}
    username = body.get("username", "").strip().lower()
    if not username or len(username) < 3:
        return error("Username deve ter ao menos 3 caracteres")
    if re.search(r'[^a-z0-9._-]', username):
        return error("Username só pode ter letras, números, ponto, traço e underline")

    sb = get_supabase_admin()
    available = check_username_available(sb, username)
    return success({"available": available, "username": username})


@auth_bp.post("/logout")
def logout():
    try:
        get_supabase().auth.sign_out()
    except: pass
    return success(message="Logout realizado")


@auth_bp.post("/refresh")
def refresh():
    body  = request.get_json() or {}
    token = body.get("refresh_token", "")
    if not token:
        return error("refresh_token obrigatório")
    try:
        resp = get_supabase().auth.refresh_session(token)
        return success({
            "access_token":  resp.session.access_token,
            "refresh_token": resp.session.refresh_token,
        })
    except Exception:
        return error("Refresh token inválido ou expirado", 401)


# ═══════════════════════════════════════════════════════════════════════════════
# AUTENTICAÇÃO DE ADMINISTRADORES
# ═══════════════════════════════════════════════════════════════════════════════

from werkzeug.security import generate_password_hash, check_password_hash
import os
import jwt
from datetime import datetime, timedelta

ADMIN_MASTER_KEY = os.getenv("ADMIN_MASTER_KEY", "RED")  # Palavra-mestre padrão
JWT_SECRET = os.getenv("SECRET_KEY", "dev-secret-change-in-prod")
JWT_ALGORITHM = "HS256"


def generate_admin_token(admin_id: str) -> str:
    """Gera JWT para admin."""
    payload = {
        "admin_id": admin_id,
        "tipo": "admin",
        "exp": datetime.utcnow() + timedelta(hours=24),
        "iat": datetime.utcnow()
    }
    return jwt.encode(payload, JWT_SECRET, algorithm=JWT_ALGORITHM)


def verify_admin_token(token: str) -> dict or None:
    """Verifica e decodifica JWT de admin."""
    try:
        payload = jwt.decode(token, JWT_SECRET, algorithms=[JWT_ALGORITHM])
        if payload.get("tipo") != "admin":
            return None
        return payload
    except:
        return None


@auth_bp.post("/admin/register")
def admin_register():
    """Cria novo administrador do sistema."""
    body = request.get_json() or {}
    nome = body.get("nome", "").strip()
    username = body.get("username", "").strip().lower()
    email = body.get("email", "").strip().lower()
    senha = body.get("senha", "")
    palavra_mestre = body.get("palavra_mestre", "")

    # Validações
    if not all([nome, username, email, senha, palavra_mestre]):
        return error("Todos os campos são obrigatórios")

    if len(nome) < 3:
        return error("Nome deve ter ao menos 3 caracteres")

    if len(username) < 3 or not re.match(r'^[a-z0-9._-]+$', username):
        return error("Username inválido. Use apenas letras, números, ponto, traço e underline")

    if len(senha) < 8:
        return error("Senha deve ter ao menos 8 caracteres")

    if palavra_mestre != ADMIN_MASTER_KEY:
        return error("Palavra-mestre de admin incorreta", 403)

    sb = get_supabase_admin()

    # Verifica se já existe
    try:
        existing = sb.table("admin_users") \
            .select("id") \
            .or_(f"username.eq.{username},email.eq.{email}") \
            .execute()
        if existing.data:
            return error("Username ou email já cadastrado", 409)
    except:
        pass

    # Cria o admin
    try:
        senha_hash = generate_password_hash(senha, method='pbkdf2:sha256')
        
        resp = sb.table("admin_users").insert({
            "nome": nome,
            "username": username,
            "email": email,
            "senha_hash": senha_hash,
            "ativo": True
        }).execute()

        admin_id = resp.data[0]["id"] if resp.data else None
        if not admin_id:
            return error("Erro ao criar administrador", 500)

        # Log da criação
        try:
            sb.rpc("log_admin_activity", {
                "p_admin_id": admin_id,
                "p_acao": "admin_criado",
                "p_descricao": f"Novo administrador {username} criado"
            }).execute()
        except:
            pass

        return success({
            "admin_id": admin_id,
            "username": username,
            "nome": nome,
            "email": email
        }, "Administrador criado com sucesso!", 201)

    except Exception as e:
        return error(f"Erro ao criar administrador: {str(e)}", 500)


@auth_bp.post("/admin/login")
def admin_login():
    """Login de administrador do sistema."""
    body = request.get_json() or {}
    login = body.get("login", "").strip()  # username ou email
    senha = body.get("senha", "")

    if not login or not senha:
        return error("Login e senha são obrigatórios")

    sb = get_supabase_admin()

    try:
        # Busca admin por username ou email
        query = sb.table("admin_users").select("*")
        
        if "@" in login:
            query = query.eq("email", login.lower())
        else:
            query = query.eq("username", login.lower())

        resp = query.execute()

        if not resp.data:
            return error("Admin não encontrado", 401)

        admin = resp.data[0]

        # Verifica ativo
        if not admin.get("ativo"):
            return error("Administrador desativado", 403)

        # Verifica senha
        if not check_password_hash(admin["senha_hash"], senha):
            return error("Senha incorreta", 401)

        # Gera token
        token = generate_admin_token(admin["id"])

        # Log do login
        try:
            sb.rpc("log_admin_activity", {
                "p_admin_id": admin["id"],
                "p_acao": "login",
                "p_descricao": f"Login de {admin['username']}"
            }).execute()
        except:
            pass

        return success({
            "access_token": token,
            "tipo": "admin",
            "admin": {
                "id": admin["id"],
                "nome": admin["nome"],
                "username": admin["username"],
                "email": admin["email"]
            }
        }, "Login bem-sucedido")

    except Exception as e:
        return error(f"Erro ao fazer login: {str(e)}", 500)


@auth_bp.post("/register-tenant")
@require_auth
def register_tenant(current_user=None):
    """Cria um tenant vinculado ao usuário autenticado (frontend já criou o usuário via Supabase)."""
    body = request.get_json() or {}
    tenant = body.get("tenant", {})

    nome = tenant.get("nome", "").strip()
    tipo = (tenant.get("tipo") or "").strip()

    if not nome:
        return error("Nome do negócio é obrigatório")
    if not validate_business_type(tipo):
        allowed = ", ".join(get_all_business_types())
        return error(f"Tipo inválido. Use: {allowed}")

    sb = get_supabase_admin()
    try:
        slug_base = slugify(nome)
        slug = slug_base
        i = 1
        while True:
            existing = sb.table("tenants").select("id").eq("slug", slug).execute()
            if not existing.data:
                break
            slug = f"{slug_base}-{i}"
            i += 1

        tenant_resp = sb.table("tenants").insert({
            "nome": nome,
            "slug": slug,
            "tipo": tipo,
            "cnpj": tenant.get("cnpj") or None,
            "telefone": tenant.get("telefone") or None,
            "cidade": tenant.get("cidade") or None,
            "estado": tenant.get("estado") or None,
        }).execute()
        tenant_id = tenant_resp.data[0]["id"]
    except Exception as e:
        return error(f"Erro ao criar negócio: {str(e)}", 500)

    try:
        user_id = request.user_id
        sb.table("tenant_users").insert({
            "tenant_id": tenant_id,
            "user_id": user_id,
            "papel": "dono",
            "username": None,
            "ativo": True,
        }).execute()
    except Exception as e:
        try:
            sb.table("tenants").delete().eq("id", tenant_id).execute()
        except:
            pass
        return error(f"Erro ao vincular usuário: {str(e)}", 500)

    return success({"tenant_id": tenant_id, "slug": slug}, "Negócio criado com sucesso!", 201)


@auth_bp.get("/admin/verifica-token")
def admin_verify_token():
    """Verifica se token de admin é válido."""
    auth_header = request.headers.get("Authorization", "")
    if not auth_header.startswith("Bearer "):
        return error("Token não fornecido ou formato inválido", 401)

    token = auth_header[7:]  # Remove "Bearer "
    payload = verify_admin_token(token)

    if not payload:
        return error("Token inválido ou expirado", 401)

    sb = get_supabase_admin()
    try:
        admin_resp = sb.table("admin_users") \
            .select("id, nome, username, email, ativo") \
            .eq("id", payload["admin_id"]) \
            .execute()

        if not admin_resp.data or not admin_resp.data[0]["ativo"]:
            return error("Admin não encontrado ou desativado", 401)

        return success({"admin": admin_resp.data[0], "token_valido": True})
    except:
        return error("Erro ao verificar token", 500)


# ═══════════════════════════════════════════════════════════════════════════════
# GERENCIAMENTO DE ADMINISTRADORES
# ═══════════════════════════════════════════════════════════════════════════════

def require_admin_token(f):
    """Decorator para verificar token de admin."""
    from functools import wraps
    @wraps(f)
    def decorated_function(*args, **kwargs):
        auth_header = request.headers.get("Authorization", "")
        if not auth_header.startswith("Bearer "):
            return error("Token não fornecido", 401)
        
        token = auth_header[7:]
        payload = verify_admin_token(token)
        if not payload:
            return error("Token inválido ou expirado", 401)
        
        return f(*args, **kwargs)
    return decorated_function


@auth_bp.get("/admin/list")
@require_admin_token
def list_admins():
    """Lista todos os administradores do sistema."""
    sb = get_supabase_admin()
    
    try:
        admins_resp = sb.table("admin_users") \
            .select("id, nome, username, email, ativo, created_at") \
            .order("created_at", desc=True) \
            .execute()
        
        return success({
            "admins": admins_resp.data or []
        }, "Administradores carregados com sucesso")
    except Exception as e:
        return error(f"Erro ao listar administradores: {str(e)}", 500)


@auth_bp.post("/admin/deactivate/<admin_id>")
@require_admin_token
def deactivate_admin(admin_id):
    """Desativa um administrador."""
    sb = get_supabase_admin()
    
    try:
        # Verifica se admin existe
        resp = sb.table("admin_users") \
            .select("id") \
            .eq("id", admin_id) \
            .execute()
        
        if not resp.data:
            return error("Administrador não encontrado", 404)
        
        # Desativa o admin
        sb.table("admin_users") \
            .update({"ativo": False}) \
            .eq("id", admin_id) \
            .execute()
        
        # Log da ação
        try:
            auth_header = request.headers.get("Authorization", "")
            token = auth_header[7:]
            payload = verify_admin_token(token)
            
            sb.rpc("log_admin_activity", {
                "p_admin_id": payload["admin_id"],
                "p_acao": "desativar_admin",
                "p_descricao": f"Admin {admin_id} foi desativado"
            }).execute()
        except:
            pass
        
        return success(message="Administrador desativado com sucesso")
    except Exception as e:
        return error(f"Erro ao desativar administrador: {str(e)}", 500)


@auth_bp.post("/admin/activate/<admin_id>")
@require_admin_token
def activate_admin(admin_id):
    """Ativa um administrador."""
    sb = get_supabase_admin()
    
    try:
        # Verifica se admin existe
        resp = sb.table("admin_users") \
            .select("id") \
            .eq("id", admin_id) \
            .execute()
        
        if not resp.data:
            return error("Administrador não encontrado", 404)
        
        # Ativa o admin
        sb.table("admin_users") \
            .update({"ativo": True}) \
            .eq("id", admin_id) \
            .execute()
        
        # Log da ação
        try:
            auth_header = request.headers.get("Authorization", "")
            token = auth_header[7:]
            payload = verify_admin_token(token)
            
            sb.rpc("log_admin_activity", {
                "p_admin_id": payload["admin_id"],
                "p_acao": "ativar_admin",
                "p_descricao": f"Admin {admin_id} foi ativado"
            }).execute()
        except:
            pass
        
        return success(message="Administrador ativado com sucesso")
    except Exception as e:
        return error(f"Erro ao ativar administrador: {str(e)}", 500)


@auth_bp.delete("/admin/<admin_id>")
@require_admin_token
def delete_admin(admin_id):
    """Deleta um administrador."""
    sb = get_supabase_admin()
    
    try:
        # Verifica se admin existe
        resp = sb.table("admin_users") \
            .select("id") \
            .eq("id", admin_id) \
            .execute()
        
        if not resp.data:
            return error("Administrador não encontrado", 404)
        
        # Deleta o admin
        sb.table("admin_users") \
            .delete() \
            .eq("id", admin_id) \
            .execute()
        
        # Log da ação
        try:
            auth_header = request.headers.get("Authorization", "")
            token = auth_header[7:]
            payload = verify_admin_token(token)
            
            sb.rpc("log_admin_activity", {
                "p_admin_id": payload["admin_id"],
                "p_acao": "deletar_admin",
                "p_descricao": f"Admin {admin_id} foi deletado"
            }).execute()
        except:
            pass
        
        return success(message="Administrador deletado com sucesso")
    except Exception as e:
        return error(f"Erro ao deletar administrador: {str(e)}", 500)

