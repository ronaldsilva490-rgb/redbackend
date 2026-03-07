"""
superadmin.py — Super Admin com AI Agent integrado, git pull corrigido.
v3.0 — bugs corrigidos: git binary check, vercel repoId, system prompt seguro,
       SQL protection melhorada (UPDATE sem WHERE bloqueado), paginação no DB Explorer.
"""
import os, re, json, base64, subprocess, shutil, requests, threading
from flask import Blueprint, request, jsonify, Response, stream_with_context
from ..utils.supabase_client import get_supabase_admin

superadmin_bp = Blueprint("superadmin", __name__)

SUPERADMIN_EMAIL  = os.getenv("SUPERADMIN_EMAIL", "")
GITHUB_TOKEN      = os.getenv("GITHUB_TOKEN", "")
GITHUB_REPO       = os.getenv("GITHUB_REPO", "")          # "usuario/repo"
GITHUB_REPO_ID    = os.getenv("GITHUB_REPO_ID", "")       # ID numérico do repo
VERCEL_TOKEN      = os.getenv("VERCEL_TOKEN", "")
VERCEL_PROJECT_ID = os.getenv("VERCEL_PROJECT_ID", "")
HF_TOKEN          = os.getenv("HF_TOKEN", "")
HF_SPACE          = os.getenv("HF_SPACE", "")


# ─── Auth guard ───────────────────────────────────────────
def require_superadmin(f):
    from functools import wraps
    @wraps(f)
    def decorated(*args, **kwargs):
        token    = request.headers.get("Authorization", "").replace("Bearer ", "").strip()
        sa_token = os.getenv("SUPERADMIN_SECRET", "")
        if sa_token and token == sa_token:
            return f(*args, **kwargs)
        try:
            sb        = get_supabase_admin()
            user_resp = sb.auth.get_user(token)
            if not user_resp or not user_resp.user:
                return jsonify({"error": "Não autorizado"}), 401
            email = user_resp.user.email or ""
            if SUPERADMIN_EMAIL and email != SUPERADMIN_EMAIL:
                return jsonify({"error": "Acesso negado"}), 403
        except Exception:
            return jsonify({"error": "Token inválido"}), 401
        return f(*args, **kwargs)
    return decorated


# ─── TENANTS ──────────────────────────────────────────────
@superadmin_bp.get("/tenants")
@require_superadmin
def list_tenants():
    sb   = get_supabase_admin()
    r    = sb.table("tenants").select("*, tenant_users(count)").execute()
    data = r.data or []
    for t in data:
        count = t.get("tenant_users", [])
        t["user_count"] = count[0]["count"] if count else 0
        t.pop("tenant_users", None)
    return jsonify({"data": data})



@superadmin_bp.get("/status")
@require_superadmin
def system_status():
    """Retorna status de todos os serviços: backend, supabase, vercel, github, hf."""
    import time
    results = {}

    # Backend itself (always ok if we got here)
    results["backend"] = {"ok": True, "label": "Backend HF Space", "latency_ms": 0}

    # Supabase
    try:
        t0 = time.time()
        sb = get_supabase_admin()
        sb.table("tenants").select("id").limit(1).execute()
        results["supabase"] = {"ok": True, "label": "Supabase DB", "latency_ms": round((time.time()-t0)*1000)}
    except Exception as e:
        results["supabase"] = {"ok": False, "label": "Supabase DB", "error": str(e)[:120]}

    # Vercel (via API)
    try:
        t0 = time.time()
        vt = VERCEL_TOKEN
        if vt:
            r = requests.get("https://api.vercel.com/v9/projects", headers={"Authorization": f"Bearer {vt}"}, timeout=8)
            results["vercel"] = {"ok": r.status_code == 200, "label": "Vercel Frontend", "latency_ms": round((time.time()-t0)*1000)}
        else:
            results["vercel"] = {"ok": None, "label": "Vercel Frontend", "error": "Token não configurado"}
    except Exception as e:
        results["vercel"] = {"ok": False, "label": "Vercel Frontend", "error": str(e)[:80]}

    # GitHub
    try:
        t0 = time.time()
        gt = GITHUB_TOKEN
        if gt:
            r = requests.get(f"https://api.github.com/repos/{GITHUB_REPO}", headers={"Authorization": f"Bearer {gt}"}, timeout=8)
            results["github"] = {"ok": r.status_code == 200, "label": "GitHub Repo", "latency_ms": round((time.time()-t0)*1000)}
        else:
            results["github"] = {"ok": None, "label": "GitHub Repo", "error": "Token não configurado"}
    except Exception as e:
        results["github"] = {"ok": False, "label": "GitHub Repo", "error": str(e)[:80]}

    # HuggingFace Space (self ping)
    try:
        t0 = time.time()
        hf = HF_SPACE
        if hf:
            r = requests.get(f"https://huggingface.co/spaces/{hf}", timeout=8)
            results["huggingface"] = {"ok": r.status_code < 400, "label": "HuggingFace Space", "latency_ms": round((time.time()-t0)*1000)}
        else:
            results["huggingface"] = {"ok": None, "label": "HuggingFace Space", "error": "HF_SPACE não configurado"}
    except Exception as e:
        results["huggingface"] = {"ok": False, "label": "HuggingFace Space", "error": str(e)[:80]}

    return jsonify({"data": results})


@superadmin_bp.patch("/tenants/<tenant_id>")
@require_superadmin
def update_tenant(tenant_id):
    body = request.get_json() or {}
    sb   = get_supabase_admin()
    sb.table("tenants").update(body).eq("id", tenant_id).execute()
    return jsonify({"ok": True})


# ─── DB EXPLORER ──────────────────────────────────────────
ALLOWED_TABLES = [
    "tenants", "tenant_users", "vehicles", "clients",
    "orders", "order_items", "products", "stock_movements",
    "sales", "sale_items", "workshop_orders", "transactions",
    "bills", "tables", "notifications",
]


@superadmin_bp.get("/db/tables")
@require_superadmin
def db_tables():
    return jsonify({"data": ALLOWED_TABLES})


@superadmin_bp.get("/db/table/<table_name>")
@require_superadmin
def db_table_data(table_name):
    if table_name not in ALLOWED_TABLES:
        return jsonify({"error": "Tabela não permitida"}), 400
    limit  = min(int(request.args.get("limit", 50)), 200)
    offset = int(request.args.get("offset", 0))
    sb = get_supabase_admin()
    r  = sb.table(table_name).select("*").limit(limit).offset(offset).execute()
    # Conta total
    count_r = sb.table(table_name).select("id", count="exact").execute()
    total   = count_r.count if hasattr(count_r, "count") else len(r.data or [])
    return jsonify({"data": r.data or [], "total": total, "limit": limit, "offset": offset})


@superadmin_bp.post("/db/sql")
@require_superadmin
def db_sql():
    body  = request.get_json() or {}
    query = body.get("query", "").strip()
    if not query:
        return jsonify({"error": "Query vazia"}), 400
    try:
        _check_dangerous_sql(query)
    except ValueError as e:
        return jsonify({"error": str(e)}), 400
    try:
        sb = get_supabase_admin()
        r  = sb.rpc("exec_sql", {"query": query}).execute()
        return jsonify({"data": r.data, "count": len(r.data) if isinstance(r.data, list) else 1})
    except Exception as e:
        return jsonify({"error": str(e)}), 400


# ─── DEPLOY / GITHUB ──────────────────────────────────────
@superadmin_bp.post("/deploy/vercel-status")
@require_superadmin
def vercel_status():
    if not VERCEL_TOKEN or not VERCEL_PROJECT_ID:
        return jsonify({"error": "VERCEL_TOKEN e VERCEL_PROJECT_ID não configurados"}), 400
    r = requests.get(f"https://api.vercel.com/v6/deployments?projectId={VERCEL_PROJECT_ID}&limit=5",
                     headers={"Authorization": f"Bearer {VERCEL_TOKEN}"}, timeout=10)
    data = [{"created": d["created"], "state": d["state"], "uid": d["uid"], "url": d.get("url", "")}
            for d in r.json().get("deployments", [])[:3]]
    return jsonify({"data": data})


@superadmin_bp.post("/deploy/vercel-deploy")
@require_superadmin
def vercel_deploy():
    if not VERCEL_TOKEN or not VERCEL_PROJECT_ID:
        return jsonify({"error": "VERCEL_TOKEN e VERCEL_PROJECT_ID não configurados"}), 400

    # BUGFIX: repoId deve ser o ID numérico, não "usuario/repo"
    # Se GITHUB_REPO_ID não estiver configurado, faz deploy via nome do projeto (sem gitSource)
    payload = {"name": VERCEL_PROJECT_ID}
    if GITHUB_REPO_ID:
        payload["gitSource"] = {
            "type":   "github",
            "repoId": str(GITHUB_REPO_ID),  # ID numérico do repositório
            "ref":    "main",
        }

    r = requests.post("https://api.vercel.com/v13/deployments",
                      headers={"Authorization": f"Bearer {VERCEL_TOKEN}", "Content-Type": "application/json"},
                      json=payload, timeout=15)
    return jsonify({"data": r.json()})


@superadmin_bp.post("/deploy/github-status")
@require_superadmin
def github_status():
    if not GITHUB_TOKEN or not GITHUB_REPO:
        return jsonify({"error": "GITHUB_TOKEN e GITHUB_REPO não configurados"}), 400
    r = requests.get(f"https://api.github.com/repos/{GITHUB_REPO}/commits?per_page=5",
                     headers={"Authorization": f"Bearer {GITHUB_TOKEN}", "Accept": "application/vnd.github+json"},
                     timeout=10)
    commits = r.json()
    if not isinstance(commits, list):
        return jsonify({"error": commits.get("message", "Erro na API GitHub")}), 400
    data = [{"sha": c["sha"][:7], "message": c["commit"]["message"][:80],
             "author": c["commit"]["author"]["name"], "date": c["commit"]["author"]["date"]}
            for c in commits]
    return jsonify({"data": data})


@superadmin_bp.post("/deploy/github-pull")
@require_superadmin
def github_pull():
    # BUGFIX: verifica se git está disponível antes de chamar subprocess
    git_path = shutil.which("git")
    if not git_path:
        return jsonify({"error": "git não está instalado no servidor. Adicione 'RUN apt-get install -y git' no Dockerfile."}), 500

    project_path = os.getenv("PROJECT_PATH", "/app")
    if not os.path.isdir(project_path):
        return jsonify({"error": f"Diretório não encontrado: {project_path}"}), 500

    try:
        result = subprocess.run(
            [git_path, "-C", project_path, "pull", "origin", "main"],
            capture_output=True, text=True, timeout=60
        )
        output = (result.stdout + result.stderr).strip()
        if result.returncode != 0:
            return jsonify({"error": output or "git pull falhou"}), 500
        return jsonify({"data": output or "Already up to date."})
    except subprocess.TimeoutExpired:
        return jsonify({"error": "git pull demorou mais de 60s"}), 500
    except Exception as e:
        return jsonify({"error": str(e)}), 500


# ─── AI AGENT — modelos ───────────────────────────────────
@superadmin_bp.post("/ai/models")
@require_superadmin
def ai_models():
    body     = request.get_json() or {}
    provider = body.get("provider", "openrouter")
    api_key  = body.get("api_key", "")
    if not api_key:
        return jsonify({"error": "API Key necessária"}), 400

    # Providers com endpoint de listagem de modelos
    ENDPOINTS = {
        "openrouter": "https://openrouter.ai/api/v1/models",
        "openai":     "https://api.openai.com/v1/models",
        "github":     "https://models.github.ai/models",
        "mistral":    "https://api.mistral.ai/v1/models",
        "groq":       "https://api.groq.com/openai/v1/models",
        "together":   "https://api.together.xyz/v1/models",
        "xai":        "https://api.x.ai/v1/language-models",
    }

    # Providers com lista fixa (sem endpoint de listagem útil)
    STATIC_MODELS = {
        "anthropic": [
            {"id": "claude-opus-4-6",            "name": "Claude Opus 4.6"},
            {"id": "claude-sonnet-4-6",           "name": "Claude Sonnet 4.6 ⭐"},
            {"id": "claude-3-5-sonnet-20241022",  "name": "Claude 3.5 Sonnet"},
            {"id": "claude-3-5-haiku-20241022",   "name": "Claude 3.5 Haiku"},
        ],
        "gemini": [
            {"id": "gemini-2.5-flash-preview-05-20", "name": "Gemini 2.5 Flash ⭐"},
            {"id": "gemini-2.0-flash",               "name": "Gemini 2.0 Flash"},
            {"id": "gemini-1.5-flash",               "name": "Gemini 1.5 Flash"},
            {"id": "gemini-2.5-pro-preview-06-05",   "name": "Gemini 2.5 Pro"},
        ],
        "cerebras": [
            {"id": "llama-4-scout-17b-16e-instruct", "name": "Llama 4 Scout 17B ⭐"},
            {"id": "llama3.3-70b",                   "name": "Llama 3.3 70B"},
            {"id": "qwen-3-235b",                    "name": "Qwen 3 235B"},
            {"id": "llama3.1-8b",                    "name": "Llama 3.1 8B"},
        ],
        "deepseek": [
            {"id": "deepseek-chat",     "name": "DeepSeek V3 ⭐"},
            {"id": "deepseek-reasoner", "name": "DeepSeek R1"},
        ],
        "cohere": [
            {"id": "command-r-plus", "name": "Command R+ ⭐"},
            {"id": "command-r",      "name": "Command R"},
            {"id": "command",        "name": "Command"},
        ],
    }

    if provider in STATIC_MODELS:
        return jsonify({"models": STATIC_MODELS[provider]})

    # Ollama local via ngrok — api_key é a URL do ngrok
    if provider == "ollama_local":
        base_url = api_key.rstrip("/")
        try:
            r = requests.get(f"{base_url}/api/tags", timeout=10)
            raw = r.json().get("models", [])
            models = [{"id": m["name"], "name": m["name"]} for m in raw]
            return jsonify({"models": models})
        except Exception as e:
            return jsonify({"error": f"Não foi possível conectar ao Ollama: {e}"}), 500

    url = ENDPOINTS.get(provider)
    if not url:
        return jsonify({"error": f"Provider '{provider}' não suportado"}), 400

    headers = {"Authorization": f"Bearer {api_key}"}
    if provider == "openrouter":
        headers["HTTP-Referer"] = os.getenv("FRONTEND_URL", "https://redcomercialweb.vercel.app")

    try:
        r = requests.get(url, headers=headers, timeout=10)
        models_data = r.json()
        raw = models_data.get("data", []) or models_data.get("models", []) or models_data.get("items", [])
        models = [{"id": m.get("id") or m.get("name",""), "name": m.get("name") or m.get("id","")} for m in raw if m.get("id") or m.get("name")]
        return jsonify({"models": sorted(models, key=lambda x: x["id"])})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


# ─── AI AGENT — streaming SSE ─────────────────────────────
@superadmin_bp.post("/ai/stream")
@require_superadmin
def ai_stream():
    body     = request.get_json() or {}
    provider = body.get("provider", "openrouter")
    api_key  = body.get("api_key", "")
    model    = body.get("model", "")
    messages = body.get("messages", [])
    conv_id  = body.get("conv_id", "default")

    if not api_key:
        return jsonify({"error": "API Key necessária"}), 400

    # Suporta dois formatos: {messages} ou {message + history}
    if not messages:
        history = body.get("history", [])
        message = body.get("message", "")
        attachments = body.get("attachments", [])
        # Monta conteúdo da mensagem do usuário (texto + anexos)
        user_content = message
        if attachments:
            text_parts = [message] if message else []
            for att in attachments:
                if att.get("isText") and att.get("textContent"):
                    text_parts.append(f"\n\n[Arquivo: {att['name']}]\n```\n{att['textContent']}\n```")
                elif att.get("isImage") and att.get("data"):
                    text_parts.append(f"\n\n[Imagem anexada: {att['name']}]")
                elif att.get("isPdf"):
                    text_parts.append(f"\n\n[PDF anexado: {att['name']}]")
            user_content = "".join(text_parts)
        messages = history + ([{"role": "user", "content": user_content}] if user_content else [])

    system = (
        "Você é RED AI. Dois repositórios separados:\n"
        "BACKEND → HuggingFace: prefixo backend/ (ex: backend/app/routes/auth.py)\n"
        "FRONTEND → GitHub: SEM prefixo, path direto da raiz (ex: src/App.jsx, src/index.css)\n"
        "NUNCA invente frontend/ — essa pasta não existe no GitHub.\n"
        "Fluxo para editar: 1) list_files() → ver estrutura real, "
        "2) read_file(path_exato) → ler, "
        "3) patch_file(path, old_str_literal, new_str) → editar.\n"
        "SEMPRE use o path que a tool retornou. Nunca substitua pelo que parece certo.\n"
        "Para conversa normal, responda sem usar tools."
    )
    # write_queue coleta SOMENTE ops HF (backend/) para commitar APÓS o SSE fechar
    # GitHub ops são imediatos — Vercel rebuild é paralelo, não mata o Space
    hf_write_queue = []

    def _sse(obj: dict) -> str:
        return f"data: {json.dumps(obj, ensure_ascii=False)}\n\n"

    def generate():
        try:
            for token in _stream_provider(provider, api_key, model, system, messages, hf_write_queue):
                if isinstance(token, dict):
                    result = token.get("result", None)
                    if result is None:
                        # BUG B FIX: primeiro yield do par (sem result) = tool iniciando
                        # Emite tool_start aqui para o spinner aparecer imediatamente
                        yield _sse({"type": "tool_start", "tool": token.get("name", ""), "args": token.get("args", {})})
                    else:
                        # Segundo yield do par (com result) = tool concluída
                        yield _sse({"type": "tool_done", "tool": token.get("name", ""), "result": result})
                else:
                    yield _sse({"type": "token", "text": token})

            # SSE fecha — agora é seguro commitar no HF sem matar a conexão
            yield _sse({"type": "done", "pending_hf_ops": hf_write_queue})

        except Exception as e:
            yield _sse({"type": "error", "text": str(e)})

    return Response(
        stream_with_context(generate()),
        content_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@superadmin_bp.get("/ai/test-hf")
@require_superadmin
def test_hf():
    """
    BUG F FIX: endpoint de diagnóstico referenciado nas mensagens de erro do frontend
    mas que não existia. Verifica conectividade e credenciais do HuggingFace Space.
    """
    results = {}
    token = HF_TOKEN
    space = HF_SPACE_REPO

    if not token:
        return jsonify({"ok": False, "error": "HF_TOKEN não configurado nas variáveis de ambiente"}), 400
    if not space:
        return jsonify({"ok": False, "error": "HF_SPACE não configurado nas variáveis de ambiente"}), 400

    results["space"] = space
    results["token_prefix"] = token[:8] + "..." if len(token) > 8 else "(curto)"

    # Testa leitura de arquivo
    try:
        read = _hf_read_file("main.py")
        results["read_main_py"] = "ok" if read.get("ok") else read.get("error", "erro desconhecido")
    except Exception as e:
        results["read_main_py"] = str(e)

    # Testa API de metadados do space
    try:
        r = requests.get(f"https://huggingface.co/api/spaces/{space}", headers=_hf_headers(), timeout=10)
        results["space_api"] = f"HTTP {r.status_code}"
        if r.status_code == 200:
            data = r.json()
            results["space_runtime"] = data.get("runtime", {}).get("stage", "unknown")
    except Exception as e:
        results["space_api"] = str(e)

    ok = results.get("read_main_py") == "ok"
    return jsonify({"ok": ok, "diagnostics": results})


@superadmin_bp.post("/ai/exec-hf-ops")
@require_superadmin
def exec_hf_ops():
    """
    Executa commits no HuggingFace APÓS o SSE fechar.

    Chamado pelo frontend depois que o evento 'done' é recebido.
    Nesse ponto o SSE já está fechado — commitar no HF é seguro mesmo que
    o Space reinicie, pois não há conexão ativa para matar.
    """
    body = request.get_json() or {}
    ops  = body.get("ops", [])

    if not ops:
        return jsonify({"results": [], "commit": None})

    results = []
    for op in ops:
        name   = op.get("name", "")
        args   = op.get("args", {})
        # hf_write_queue=None → HF commits imediatos (SSE já fechou, seguro)
        result = _execute_tool_with_retry(name, args, hf_write_queue=None, max_attempts=3)
        results.append({"tool": name, "result": result})

    return jsonify({"results": results})


# ─── Tools dispatch ───────────────────────────────────────
def _dispatch_tool(name: str, args: dict, hf_write_queue: list = None):
    """
    Executa uma tool.
    
    REGRA CRÍTICA DE TIMING:
    - GitHub (frontend): commits IMEDIATOS — Vercel rebuild é paralelo, não afeta o Space
    - HuggingFace (backend): commits ENFILEIRADOS — commitar durante SSE reinicia o Space,
      matando a conexão. Commits HF só acontecem APÓS o SSE fechar, via /exec-hf-ops.
    
    Se hf_write_queue for passado, writes de backend/ são enfileirados em vez de executados.
    """
    path = args.get("path", "")
    is_backend = path.startswith("backend/")

    def _read():
        if is_backend:
            return _hf_read_file(path[len("backend/"):])
        return _github_read_file(path)

    def _list():
        if is_backend:
            return _hf_list_files(path[len("backend/"):])
        return _github_list_files(path)

    def _write():
        content = args.get("content")
        message = args.get("message", "chore: update via RED AI Agent")
        if is_backend:
            if hf_write_queue is not None:
                # ENFILEIRA — não commita agora (evita reiniciar o Space durante o SSE)
                hf_write_queue.append({"name": "write_file", "args": args})
                return {"ok": True, "queued": True, "note": f"'{path}' enfileirado — commitado após IA terminar."}
            return _hf_write_file(path[len("backend/"):], content, message)
        return _github_write_file(path, content, message)

    def _patch():
        old_str = args.get("old_str")
        new_str = args.get("new_str")
        message = args.get("message", "chore: patch via RED AI Agent")

        # AUTO-READ: se old_str vazio, lê o arquivo e devolve pro modelo
        # forçando o fluxo correto independente do modelo seguir instruções.
        if not old_str:
            if is_backend:
                read_result = _hf_read_file(path[len("backend/"):])
            else:
                read_result = _github_read_file(path)
            if "error" in read_result:
                return read_result
            return {
                "error": "old_str está vazio.",
                "action_required": "Use o conteúdo abaixo para identificar o trecho exato e chame patch_file novamente com old_str preenchido.",
                "file_content": read_result.get("content", ""),
                "path": path,
            }

        if is_backend:
            if hf_write_queue is not None:
                hf_write_queue.append({"name": "patch_file", "args": args})
                return {"ok": True, "queued": True, "note": f"'{path}' enfileirado — commitado após IA terminar."}
            return _hf_patch_file(path[len("backend/"):], old_str, new_str, message)
        return _github_patch_file(path, old_str, new_str, message)

    dispatch = {
        "read_file":    _read,
        "list_files":   _list,
        "write_file":   _write,
        "patch_file":   _patch,
        "run_sql":      lambda: _run_sql(args.get("query", "")),
        "list_tenants": lambda: _list_tenants_tool(),
    }
    fn = dispatch.get(name)
    if not fn:
        return {"error": f"Tool '{name}' não reconhecida"}
    try:
        return fn()
    except Exception as e:
        return {"error": str(e)}


# ─── Tool implementations ─────────────────────────────────
def _gh_headers():
    return {"Authorization": f"Bearer {GITHUB_TOKEN}",
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28"}


def _hf_headers():
    return {"Authorization": f"Bearer {HF_TOKEN}"}


# ─── HuggingFace Space file tools ─────────────────────────
HF_SPACE_REPO = os.getenv("HF_SPACE", "theredsclub/comercial")  # usuario/space-name

def _hf_read_file(path):
    """Lê arquivo do repo do HuggingFace Space."""
    if not HF_TOKEN:
        return {"error": "HF_TOKEN não configurado"}
    url = f"https://huggingface.co/api/spaces/{HF_SPACE_REPO}/raw/{path}"
    r = requests.get(url, headers=_hf_headers(), timeout=15)
    if r.status_code == 404:
        # AUTO-NAVIGATE: arquivo não existe — lista o diretório pai
        parent = "/".join(path.split("/")[:-1]) if "/" in path else ""
        listing = _hf_list_files(parent)
        files = [f["path"] for f in listing.get("files", [])]
        parent_label = "backend/" + parent if parent else "backend/"
        return {
            "error": f"Arquivo não encontrado no HF Space: {path}",
            "hint": f"Este path nao existe. Arquivos em {parent_label}: {files}",
            "action_required": "Use um dos paths listados acima. Nunca invente paths.",
        }
    if r.status_code != 200:
        # Tenta via datasets API
        url2 = f"https://huggingface.co/{HF_SPACE_REPO}/raw/main/{path}"
        r = requests.get(url2, headers=_hf_headers(), timeout=15)
    if r.status_code == 200:
        return {"ok": True, "path": f"backend/{path}", "content": r.text}
    return {"error": f"Erro ao ler {path} do HF Space: {r.status_code}"}


def _hf_list_files(path=""):
    """Lista arquivos do repo do HuggingFace Space."""
    if not HF_TOKEN:
        return {"error": "HF_TOKEN não configurado"}
    url = f"https://huggingface.co/api/spaces/{HF_SPACE_REPO}/tree/main/{path}"
    r = requests.get(url, headers=_hf_headers(), timeout=15)
    if r.status_code != 200:
        return {"error": f"Erro ao listar {path}: {r.status_code}"}
    items = r.json()
    if not isinstance(items, list):
        return {"error": "Resposta inesperada da API do HF"}
    return {"ok": True, "files": [
        {"name": i.get("path", "").split("/")[-1], "path": f"backend/{i.get('path','')}", "type": i.get("type", "file")}
        for i in items
    ]}


def _hf_write_file(path, content, message):
    """Escreve arquivo no repo do HuggingFace Space via commit API."""
    if not HF_TOKEN:
        return {"error": "HF_TOKEN não configurado"}
    if not path or content is None:
        return {"error": "path e content são obrigatórios"}

    encoded = base64.b64encode(content.encode("utf-8")).decode()
    payload = {
        "summary": message,
        "files": [{
            "path": path,
            "encoding": "base64",
            "content": encoded
        }]
    }
    url = f"https://huggingface.co/api/spaces/{HF_SPACE_REPO}/commit/main"
    r = requests.post(url, headers={**_hf_headers(), "Content-Type": "application/json"},
                      json=payload, timeout=30)
    if r.status_code in (200, 201):
        return {"ok": True, "path": f"backend/{path}", "note": "HF Space vai rebuildar em ~30s"}
    return {"error": f"Erro ao commitar no HF: {r.status_code} {r.text[:200]}"}


def _fuzzy_replace(content: str, old_str: str, new_str: str):
    """
    Substitui old_str em content com tolerância a diferenças de whitespace.

    Estratégia em 3 camadas:
    1. Match exato
    2. Match deep_norm: ignora indentação, espaços internos múltiplos e ponto-e-vírgula
    3. Match por linha-chave: encontra a linha mais específica do old_str

    Retorna (updated_content, match_type) ou (None, None) se não achou.
    """
    import re as _re

    # 1. Match exato
    if old_str in content:
        return content.replace(old_str, new_str, 1), "exact"

    content_lines = content.splitlines(keepends=True)

    def deep_norm(s):
        """Strip, colapsa espaços internos, remove ; final — para comparação apenas."""
        return _re.sub(r'\s+', ' ', s.strip()).rstrip(';').strip()

    old_lines_raw  = old_str.splitlines()
    old_lines_norm = [deep_norm(l) for l in old_lines_raw if l.strip()]
    content_norm   = [deep_norm(l) for l in content.splitlines()]

    # 2. Match com deep_norm — janela deslizante
    if old_lines_norm:
        for start in range(len(content_norm) - len(old_lines_norm) + 1):
            window = content_norm[start:start + len(old_lines_norm)]
            if window == old_lines_norm:
                original_block = "".join(content_lines[start:start + len(old_lines_norm)])
                original_indent = len(content_lines[start]) - len(content_lines[start].lstrip())
                indent = " " * original_indent
                new_indented = "\n".join(
                    indent + l.strip() if l.strip() else l
                    for l in new_str.splitlines()
                )
                if original_block.endswith("\n") and not new_indented.endswith("\n"):
                    new_indented += "\n"
                return content.replace(original_block, new_indented, 1), "deep_normalized"

    # 3. Match por linha-chave: pega a linha normalizada mais longa do old_str
    # Remove comentários inline (/* ... */ e <- ...) antes de comparar
    def strip_comments(s):
        s = _re.sub(r'/\*.*?\*/', '', s)
        s = _re.sub(r'<-.*$', '', s)
        s = _re.sub(r'//.*$', '', s)
        return s.strip()

    old_lines_stripped = [deep_norm(strip_comments(l)) for l in old_lines_raw if strip_comments(l).strip()]
    content_stripped   = [deep_norm(strip_comments(l)) for l in content.splitlines()]

    if old_lines_stripped:
        for start in range(len(content_stripped) - len(old_lines_stripped) + 1):
            window = content_stripped[start:start + len(old_lines_stripped)]
            if window == old_lines_stripped:
                original_block = "".join(content_lines[start:start + len(old_lines_stripped)])
                original_indent = len(content_lines[start]) - len(content_lines[start].lstrip())
                indent = " " * original_indent
                new_indented = "\n".join(
                    indent + l.strip() if l.strip() else l
                    for l in new_str.splitlines()
                )
                if original_block.endswith("\n") and not new_indented.endswith("\n"):
                    new_indented += "\n"
                return content.replace(original_block, new_indented, 1), "comment_stripped"

    key_line = max(old_lines_stripped, key=len) if old_lines_stripped else ""
    if key_line and len(key_line) > 6:
        for i, norm_line in enumerate(content_stripped):
            if norm_line == key_line:
                original_line = content_lines[i]
                original_indent = len(original_line) - len(original_line.lstrip())
                indent = " " * original_indent
                new_lines_norm = [deep_norm(l) for l in new_str.splitlines() if l.strip()]
                new_key = max(new_lines_norm, key=len) if new_lines_norm else deep_norm(new_str)
                semicolon = ";" if original_line.rstrip("\n").rstrip().endswith(";") and not new_key.endswith(";") else ""
                eol = "\n" if original_line.endswith("\n") else ""
                return content.replace(original_line, f"{indent}{new_key}{semicolon}{eol}", 1), "key_line"

    # 4. CSS property key match: se old_str contém `--prop:`, acha a linha pelo nome da propriedade
    css_props = _re.findall(r'(--[\w-]+)\s*:', old_str)
    for prop in css_props:
        for i, line in enumerate(content_lines):
            if _re.search(rf'\b{_re.escape(prop)}\s*:', line):
                original_line = content_lines[i]
                original_indent = len(original_line) - len(original_line.lstrip())
                indent = " " * original_indent
                # Pega o valor do new_str para essa propriedade, ou usa new_str inteiro
                new_val_match = _re.search(rf'{_re.escape(prop)}\s*:\s*([^;]+)', new_str)
                if new_val_match:
                    new_val = new_val_match.group(1).strip()
                    eol = "\n" if original_line.endswith("\n") else ""
                    new_line = f"{indent}{prop}: {new_val};\n" if eol else f"{indent}{prop}: {new_val};"
                    return content.replace(original_line, new_line, 1), "css_prop_key"

    return None, None


def _hf_patch_file(path, old_str, new_str, message):
    """Edita trecho de arquivo no HuggingFace Space."""
    if not old_str or new_str is None:
        return {"error": "old_str e new_str são obrigatórios"}
    read = _hf_read_file(path)
    if "error" in read:
        return read
    content = read["content"]
    updated, match_type = _fuzzy_replace(content, old_str, new_str)
    if updated is None:
        return {"error": f"Patch falhou em backend/{path}: trecho não encontrado mesmo após busca fuzzy. Use write_file para reescrever o arquivo inteiro com a mudança aplicada."}
    note = "" if match_type == "exact" else f" (match por {match_type})"
    result = _hf_write_file(path, updated, message)
    if "ok" in result:
        result["match_type"] = match_type
        result["note"] = result.get("note", "") + note
    return result


def _github_read_file(path):
    if not GITHUB_TOKEN or not GITHUB_REPO:
        return {"error": "GITHUB_TOKEN/GITHUB_REPO não configurados"}
    r = requests.get(f"https://api.github.com/repos/{GITHUB_REPO}/contents/{path}",
                     headers=_gh_headers(), timeout=15)
    if r.status_code == 404:
        # AUTO-NAVIGATE: arquivo não existe — lista o diretório pai para o modelo
        # usar um path real em vez de inventar caminhos.
        parent = "/".join(path.split("/")[:-1]) if "/" in path else ""
        listing = _github_list_files(parent)
        files = [f["path"] for f in listing.get("files", [])]
        return {
            "error": f"Arquivo não encontrado: {path}",
            "hint": f"Este path não existe. Arquivos disponíveis em '{parent or 'raiz'}': {files}",
            "action_required": "Use um dos paths listados acima. Nunca invente paths.",
        }
    d = r.json()
    if isinstance(d, dict) and d.get("content"):
        return {"ok": True, "path": path,
                "content": base64.b64decode(d["content"]).decode("utf-8", errors="replace"),
                "sha": d.get("sha", "")}
    return {"error": "Não foi possível ler o arquivo"}


def _github_patch_file(path, old_str, new_str, message):
    if not old_str or new_str is None:
        return {"error": "old_str e new_str são obrigatórios"}
    read = _github_read_file(path)
    if "error" in read:
        return read
    content = read["content"]
    updated, match_type = _fuzzy_replace(content, old_str, new_str)
    if updated is None:
        return {"error": f"Patch falhou em {path}: trecho não encontrado mesmo após busca fuzzy. Use write_file para reescrever o arquivo inteiro com a mudança aplicada."}
    result = _github_write_file(path, updated, message, sha=read["sha"])
    if "ok" in result:
        result["match_type"] = match_type
    return result


def _github_list_files(path):
    if not GITHUB_TOKEN or not GITHUB_REPO:
        return {"error": "GITHUB_TOKEN/GITHUB_REPO não configurados"}
    url = f"https://api.github.com/repos/{GITHUB_REPO}/contents/{path}" if path \
          else f"https://api.github.com/repos/{GITHUB_REPO}/contents"
    r   = requests.get(url, headers=_gh_headers(), timeout=15)
    items = r.json()
    if not isinstance(items, list):
        return {"error": items.get("message", "Erro")}
    return {"ok": True, "files": [{"name": i["name"], "path": i["path"], "type": i["type"]} for i in items]}


def _github_write_file(path, content, message, sha=None):
    if not path or content is None:
        return {"error": "path e content são obrigatórios"}
    if not GITHUB_TOKEN or not GITHUB_REPO:
        return {"error": "GITHUB_TOKEN/GITHUB_REPO não configurados"}

    if not sha:
        r_get = requests.get(f"https://api.github.com/repos/{GITHUB_REPO}/contents/{path}",
                             headers=_gh_headers(), timeout=15)
        if r_get.status_code == 200:
            sha = r_get.json().get("sha", "")

    encoded = base64.b64encode(content.encode("utf-8")).decode()
    payload = {"message": message, "content": encoded}
    if sha:
        payload["sha"] = sha

    r = requests.put(f"https://api.github.com/repos/{GITHUB_REPO}/contents/{path}",
                     headers=_gh_headers(), json=payload, timeout=30)
    if r.status_code in (200, 201):
        commit_sha = r.json().get("commit", {}).get("sha", "")[:7]
        return {"ok": True, "path": path, "commit": commit_sha, "note": "Vercel redeploya automaticamente"}
    return {"error": r.json().get("message", "Erro ao escrever arquivo")}


def _run_sql(query: str):
    if not query:
        return {"error": "Query vazia"}
    try:
        _check_dangerous_sql(query)
    except ValueError as e:
        return {"error": str(e)}
    try:
        sb = get_supabase_admin()
        r  = sb.rpc("exec_sql", {"query": query}).execute()
        return {"ok": True, "data": r.data}
    except Exception as e:
        return {"error": str(e)}


def _list_tenants_tool():
    try:
        sb   = get_supabase_admin()
        data = sb.table("tenants").select("id, nome, tipo, plano, ativo").execute().data or []
        return {"ok": True, "tenants": data}
    except Exception as e:
        return {"error": str(e)}


# ─── Provider streaming ───────────────────────────────────
def _stream_provider(provider, api_key, model, system, messages, write_queue=None):
    if write_queue is None:
        write_queue = []
    if provider == "ollama_local":
        base_url = api_key.rstrip("/")
        yield from _stream_ollama_tools(f"{base_url}/v1/chat/completions", model, system, messages, write_queue)
        return
    yield f"[Provider '{provider}' não suportado]"


# ─── Loop agentic nativo via function calling OpenAI-compat ──────────────────
def _extract_json_objects(text: str) -> list:
    """
    Extrai todos os objetos JSON válidos de um texto usando parser de chaves balanceadas.
    Funciona com JSON inline, multi-linha e com aninhamento arbitrário.
    BUG FIX: os regex antigos falhavam para JSON multi-linha e com valores aninhados
    (ex: {"name": "read_file", "arguments": {"path": "..."}}) porque o padrão [^{}]*
    não permite chaves aninhadas e o .*? parava no } interno do valor.
    """
    objects = []
    i = 0
    while i < len(text):
        if text[i] == '{':
            depth = 0
            start = i
            in_str = False
            escape = False
            for j in range(i, len(text)):
                c = text[j]
                if escape:
                    escape = False
                    continue
                if c == '\\' and in_str:
                    escape = True
                    continue
                if c == '"':
                    in_str = not in_str
                    continue
                if in_str:
                    continue
                if c == '{':
                    depth += 1
                elif c == '}':
                    depth -= 1
                    if depth == 0:
                        candidate = text[start:j + 1]
                        try:
                            obj = json.loads(candidate)
                            if isinstance(obj, dict):
                                objects.append(obj)
                        except Exception:
                            pass
                        i = j
                        break
        i += 1
    return objects


def _extract_tool_calls_from_text(text: str) -> dict:
    """
    Fallback para modelos que não suportam function calling nativo.
    Detecta quando o modelo imprimiu a chamada de tool como texto em vários formatos:
      - {"name": "read_file", "arguments": {"path": "..."}}   ← formato padrão
      - {"tool": "read_file", "args": {"path": "..."}}         ← formato ReAct legado
      - <tool_call>{...}</tool_call>                           ← formato tag
      - ```json\\n{...}\\n```                                  ← formato code block
    Usa parser de chaves balanceadas — funciona com JSON multi-linha e aninhado.
    """
    import re as _re

    if not text or not text.strip():
        return {}

    TOOL_NAMES = {"read_file", "list_files", "write_file", "patch_file", "run_sql", "list_tenants"}

    # 1. Tenta <tool_call>...</tool_call> primeiro (formato mais explícito)
    tag_re = _re.compile(r'<tool_call>\s*(.*?)\s*</tool_call>', _re.DOTALL)
    for m in tag_re.finditer(text):
        for obj in _extract_json_objects(m.group(1)):
            name = obj.get("name") or obj.get("tool", "")
            args = obj.get("arguments") or obj.get("args") or obj.get("parameters") or {}
            if name in TOOL_NAMES:
                return {0: {"id": "fallback_0", "name": name, "args_str": json.dumps(args, ensure_ascii=False)}}

    # 2. Tenta ```json ... ``` (código formatado)
    block_re = _re.compile(r'```(?:json)?\s*(.*?)\s*```', _re.DOTALL)
    for m in block_re.finditer(text):
        for obj in _extract_json_objects(m.group(1)):
            name = obj.get("name") or obj.get("tool", "")
            args = obj.get("arguments") or obj.get("args") or obj.get("parameters") or {}
            if name in TOOL_NAMES:
                return {0: {"id": "fallback_0", "name": name, "args_str": json.dumps(args, ensure_ascii=False)}}

    # 3. Varredura geral: extrai TODOS os JSONs do texto (inclui multi-linha e aninhado)
    all_objects = _extract_json_objects(text)
    # Itera de trás pra frente — o último JSON é o mais provável de ser a chamada real
    for obj in reversed(all_objects):
        name = obj.get("name") or obj.get("tool", "")
        args = obj.get("arguments") or obj.get("args") or obj.get("parameters") or {}
        if name in TOOL_NAMES:
            return {0: {"id": "fallback_0", "name": name, "args_str": json.dumps(args, ensure_ascii=False)}}

    return {}


def _stream_ollama_tools(url: str, model: str, system: str, messages: list, write_queue: list):
    """
    Loop agentic completo para Ollama.

    ARQUITETURA:
    - Function calling nativo (tool_calls) quando o modelo suporta
    - Fallback automático para extração de JSON do texto quando não suporta
    - NUNCA faz stream de tokens enquanto pode ser uma tool call disfarçada de texto
    - Só faz stream de texto quando a resposta completa foi recebida e não é tool call
    """
    tools   = _get_tools_schema()
    headers = {"Content-Type": "application/json"}

    # BUG D FIX: sanitiza histórico antes de enviar ao Ollama
    # Mensagens assistant com content='' (geradas quando AI só executou tools) devem ter
    # content=None para respeitar o spec OpenAI. String vazia causa alucinações.
    def _sanitize_messages(msgs):
        sanitized = []
        for m in msgs:
            role    = m.get("role", "")
            content = m.get("content")
            # Converte string vazia para None em mensagens do assistant
            if role == "assistant" and content == "":
                content = None
            # Trunca tool results muito grandes para não explodir o contexto
            if role == "tool" and isinstance(content, str) and len(content) > 6000:
                try:
                    data = json.loads(content)
                    if isinstance(data, dict) and "content" in data:
                        file_content = data["content"]
                        if len(file_content) > 5000:
                            data["content"] = file_content[:5000] + "\n\n[... TRUNCADO — arquivo grande. Use read_file para ver partes específicas ...]"
                            content = json.dumps(data, ensure_ascii=False)
                except Exception:
                    content = content[:6000] + "\n[... TRUNCADO ...]"
            sanitized.append({**m, "content": content})
        return sanitized

    chat     = ([{"role": "system", "content": system}] if system else []) + _sanitize_messages(messages)
    MAX_ITER = 15

    # ── Detecção de mensagem conversacional ──────────────────────────────
    # Se a última mensagem do usuário for curta e não contiver palavras de ação,
    # força tool_choice="none" — modelo responde em texto direto sem chamar tools.
    # Isso é a barreira definitiva contra loops em saudações, independente do Modelfile.
    _ACTION_KEYWORDS = {
        "altere", "mude", "troque", "adicione", "crie", "cria", "remove", "remova",
        "delete", "edite", "edita", "faça", "execute", "rode",
        "liste", "mostra", "mostre", "busca", "busque", "verifica", "corrija",
        "implemente", "adiciona", "insere", "insira", "atualiza", "atualize",
        "patch", "commit", "deploy", "sql", "select", "insert", "update",
        "criar", "fazer", "adicionar", "mudar", "alterar", "trocar",
        "background", "cor", "componente", "pagina", "rota", "endpoint",
        "tabela", "coluna", "campo", "botao", "menu", "aba", "sidebar",
    }

    def _is_conversational(msgs):
        """Retorna True se a última mensagem do usuário é claramente conversacional."""
        user_msgs = [m for m in msgs if m.get("role") == "user"]
        if not user_msgs:
            return False
        last = (user_msgs[-1].get("content") or "").strip().lower()
        # Curta (< 60 chars) e sem palavras de ação = conversacional
        if len(last) >= 60:
            return False
        words = set(last.replace("?", "").replace("!", "").replace(",", "").split())
        return not bool(words & _ACTION_KEYWORDS)

    _force_no_tools = _is_conversational(messages)

    # Detecção de loop infinito: registra últimas calls para detectar repetição
    _recent_calls = []

    for iteration in range(MAX_ITER):
        payload = {
            "model":       model,
            "messages":    chat,
            "stream":      True,
            "temperature": 0.1,
            "options":     {"num_ctx": 4096},
        }
        # Mensagem conversacional: não oferece tools ao modelo — resposta direta garantida
        if _force_no_tools:
            payload["tool_choice"] = "none"
        else:
            payload["tools"]       = tools
            payload["tool_choice"] = "auto"

        full_text      = ""
        tool_calls_acc = {}  # index → {id, name, args_str}

        # ── Chamada ao modelo — TUDO BUFFERIZADO, nada streamed direto ────
        try:
            with requests.post(url, headers=headers, json=payload, stream=True, timeout=300) as resp:
                if resp.status_code != 200:
                    yield f"\n❌ Ollama HTTP {resp.status_code}: {resp.text[:300]}"
                    return

                for raw_line in resp.iter_lines():
                    if not raw_line:
                        continue
                    line = raw_line.decode("utf-8", errors="replace")
                    if line.startswith("data: "):
                        line = line[6:]
                    if line == "[DONE]":
                        break
                    try:
                        chunk = json.loads(line)
                        delta = chunk["choices"][0].get("delta", {})

                        # Acumula texto — NÃO faz yield aqui ainda
                        txt = delta.get("content") or ""
                        if txt:
                            full_text += txt

                        # Tool calls nativos chegam fragmentados — acumular
                        for tc in delta.get("tool_calls", []):
                            idx = tc.get("index", 0)
                            if idx not in tool_calls_acc:
                                tool_calls_acc[idx] = {
                                    "id":       tc.get("id", f"call_{idx}"),
                                    "name":     "",
                                    "args_str": "",
                                }
                            fn = tc.get("function", {})
                            if fn.get("name"):
                                tool_calls_acc[idx]["name"] = fn["name"]
                            tool_calls_acc[idx]["args_str"] += fn.get("arguments", "")

                    except Exception:
                        pass

        except Exception as e:
            yield f"\n❌ Erro de conexão com Ollama: {e}"
            return

        # ── Fallback: modelo imprimiu JSON de tool como texto ─────────────
        # Se é mensagem conversacional, NUNCA executa tools mesmo que o modelo
        # antigo (baked Modelfile) gere JSON de tool call como texto
        if not tool_calls_acc and full_text.strip() and not _force_no_tools:
            tool_calls_acc = _extract_tool_calls_from_text(full_text)
            if tool_calls_acc:
                full_text = ""  # era tool call disfarçada — descarta o texto

        # ── Sem tool calls: resposta final em texto — agora sim faz stream ─
        if not tool_calls_acc or _force_no_tools:
            # BUG FIX: após executar tools, o qwen2.5-coder às vezes inclui o JSON da
            # chamada na resposta de texto final (ex: mostra {"name":"read_file",...}
            # no chat em vez de uma confirmação em linguagem natural).
            # Solução: detecta e remove blocos JSON de tool call do texto final.
            import re as _re
            clean_text = full_text

            # Remove blocos ```json...``` que sejam tool calls
            def _is_tool_json(s):
                TOOL_NAMES = {"read_file","list_files","write_file","patch_file","run_sql","list_tenants"}
                for o in _extract_json_objects(s):
                    if (o.get("name") or o.get("tool","")) in TOOL_NAMES:
                        return True
                return False

            def _strip_code_block(m):
                return "" if _is_tool_json(m.group(0)) else m.group(0)

            clean_text = _re.sub(r'```(?:json)?\s*.*?\s*```', _strip_code_block, clean_text, flags=_re.DOTALL)
            clean_text = _re.sub(r'<tool_call>.*?</tool_call>', '', clean_text, flags=_re.DOTALL)

            # Se o texto inteiro (após limpeza) é apenas um JSON de tool call, descarta tudo
            if _is_tool_json(clean_text.strip()):
                clean_text = ""

            text_to_stream = clean_text.strip()
            chunk_size = 8
            for i in range(0, len(text_to_stream), chunk_size):
                yield text_to_stream[i:i+chunk_size]
            break

        # ── Executa cada tool IMEDIATAMENTE no backend ────────────────────
        assistant_msg = {
            "role":       "assistant",
            "content":    full_text or None,
            "tool_calls": [],
        }
        result_msgs = []

        for idx in sorted(tool_calls_acc.keys()):
            tc        = tool_calls_acc[idx]
            tool_name = tc["name"]
            call_id   = tc["id"]

            try:
                args = json.loads(tc["args_str"]) if tc["args_str"].strip() else {}
            except Exception:
                args = {}

            assistant_msg["tool_calls"].append({
                "id":       call_id,
                "type":     "function",
                "function": {"name": tool_name, "arguments": tc["args_str"]},
            })

            # Emite badge "executando" para o frontend
            yield {"name": tool_name, "args": args}

            # Executa com retry automático — HF writes são enfileirados, não commitados agora
            result = _execute_tool_with_retry(tool_name, args, hf_write_queue=write_queue)

            # Emite resultado para o frontend
            yield {"name": tool_name, "args": args, "result": result}

            result_msgs.append({
                "role":         "tool",
                "tool_call_id": call_id,
                "content":      json.dumps(result, ensure_ascii=False),
            })

        # Injeta resultados no histórico e volta ao topo do loop
        chat.append(assistant_msg)
        chat.extend(result_msgs)

        # ── Detecção de loop infinito ─────────────────────────────────────
        # Registra as tools chamadas nesta iteração
        iter_signature = "|".join(
            f"{tool_calls_acc[i]['name']}:{tool_calls_acc[i]['args_str']}"
            for i in sorted(tool_calls_acc.keys())
        )
        _recent_calls.append(iter_signature)
        # Se as últimas 3 iterações fizeram exatamente as mesmas calls → loop
        if len(_recent_calls) >= 3 and len(set(_recent_calls[-3:])) == 1:
            yield "\n\nNão consegui completar a tarefa — estou em loop chamando a mesma ferramenta repetidamente. Tente ser mais específico ou verificar se o arquivo/recurso existe."
            return

    else:
        # for...else: só executa se o loop TERMINOU sem break (MAX_ITER esgotado)
        yield f"\n\n⚠️ Limite de {MAX_ITER} iterações atingido sem conclusão. Tente dividir a tarefa em partes menores."


def _execute_tool_with_retry(tool_name: str, args: dict, hf_write_queue: list = None, max_attempts: int = 3) -> dict:
    """
    Executa uma tool com retry automático em falhas de rede.
    
    hf_write_queue: se passado, writes de backend/ são enfileirados (não commitados agora).
                    Passa None apenas quando chamado fora do contexto SSE.
    """
    import time as _time
    last_error = None

    for attempt in range(1, max_attempts + 1):
        try:
            result = _dispatch_tool(tool_name, args, hf_write_queue=hf_write_queue)
            if isinstance(result, dict) and "error" in result:
                err_str = str(result["error"]).lower()
                is_transient = any(x in err_str for x in (
                    "timeout", "connection", "network", "502", "503", "504"
                ))
                if is_transient and attempt < max_attempts:
                    last_error = result["error"]
                    _time.sleep(2 * attempt)
                    continue
            return result
        except Exception as e:
            last_error = str(e)
            if attempt < max_attempts:
                _time.sleep(2 * attempt)

    return {"error": f"Falhou após {max_attempts} tentativas: {last_error}"}





def _stream_gemini(api_key, model, system, messages):
    """Google Gemini via REST API (não usa openai-compat)."""
    url = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:streamGenerateContent?alt=sse&key={api_key}"
    # Converte messages para formato Gemini
    contents = []
    if system:
        contents.append({"role": "user", "parts": [{"text": f"[System]: {system}"}]})
        contents.append({"role": "model", "parts": [{"text": "Entendido."}]})
    for m in messages:
        role = "user" if m.get("role") == "user" else "model"
        contents.append({"role": role, "parts": [{"text": m.get("content", "")}]})
    payload = {"contents": contents, "generationConfig": {"maxOutputTokens": 4096}}
    try:
        with requests.post(url, json=payload, stream=True, timeout=120,
                           headers={"Content-Type": "application/json"}) as resp:
            for line in resp.iter_lines():
                if not line:
                    continue
                line = line.decode("utf-8", errors="replace")
                if line.startswith("data: "):
                    try:
                        evt = json.loads(line[6:])
                        for cand in evt.get("candidates", []):
                            for part in cand.get("content", {}).get("parts", []):
                                if part.get("text"):
                                    yield part["text"]
                    except Exception:
                        pass
    except Exception as e:
        yield f"\n[Erro Gemini: {e}]"

def _fake_stream(text: str):
    import time
    chunk = 4
    for i in range(0, len(text), chunk):
        yield text[i:i+chunk]
        time.sleep(0.008)


# ─── Tools schema ─────────────────────────────────────────
def _get_tools_schema():
    return [
        {
            "type": "function",
            "function": {
                "name": "read_file",
                "description": "Lê o conteúdo de um arquivo do repositório GitHub.",
                "parameters": {"type": "object", "properties": {"path": {"type": "string"}}, "required": ["path"]},
            },
        },
        {
            "type": "function",
            "function": {
                "name": "list_files",
                "description": "Lista arquivos/pastas do repositório GitHub.",
                "parameters": {"type": "object", "properties": {"path": {"type": "string", "default": ""}}, "required": []},
            },
        },
        {
            "type": "function",
            "function": {
                "name": "write_file",
                "description": "Cria ou atualiza um arquivo no repositório GitHub.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "path":    {"type": "string"},
                        "content": {"type": "string"},
                        "message": {"type": "string"},
                    },
                    "required": ["path", "content"],
                },
            },
        },
        {
            "type": "function",
            "function": {
                "name": "patch_file",
                "description": "Substitui um trecho específico de um arquivo (old_str → new_str).",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "path":    {"type": "string"},
                        "old_str": {"type": "string"},
                        "new_str": {"type": "string"},
                        "message": {"type": "string"},
                    },
                    "required": ["path", "old_str", "new_str"],
                },
            },
        },
        {
            "type": "function",
            "function": {
                "name": "run_sql",
                "description": "Executa SQL no Supabase. SELECT livre; DROP/DELETE/TRUNCATE/UPDATE sem WHERE bloqueados.",
                "parameters": {"type": "object", "properties": {"query": {"type": "string"}}, "required": ["query"]},
            },
        },
        {
            "type": "function",
            "function": {
                "name": "list_tenants",
                "description": "Lista todos os tenants (empresas) cadastrados no sistema.",
                "parameters": {"type": "object", "properties": {}, "required": []},
            },
        },
    ]


# ─── SQL safety ───────────────────────────────────────────
def _check_dangerous_sql(query: str):
    ql = query.strip().lower()
    # Remove comentários simples
    ql = " ".join(line.split("--")[0] for line in ql.splitlines())

    BLOCKLIST = [
        "drop table", "drop database", "drop schema",
        "truncate",
        "delete from",
        "alter table",
    ]
    for pattern in BLOCKLIST:
        if pattern in ql:
            raise ValueError(f"Query perigosa bloqueada: '{pattern}'")

    # UPDATE sem WHERE é perigoso
    if "update " in ql and " set " in ql and " where " not in ql:
        raise ValueError("UPDATE sem cláusula WHERE é bloqueado por segurança")