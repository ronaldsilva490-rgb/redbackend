from flask import Blueprint, request
from ..utils.supabase_client import get_supabase_admin
from ..utils.auth_middleware import require_auth, require_papel
from ..utils.response import success, error

products_bp = Blueprint("products", __name__)




def _to_frontend(p):
    """Mapeia campos do banco para nomes esperados pelo frontend."""
    if not p:
        return p
    p = dict(p)
    # estoque → estoque_atual
    # estoque_atual is the real column name — no remapping needed
    # imagens[] → foto_url (primeira imagem)
    if "imagens" in p and "foto_url" not in p:
        imgs = p.get("imagens") or []
        p["foto_url"] = imgs[0] if imgs else None
    return p

def _clean(body):
    """Normaliza campos do frontend para nomes/tipos corretos do banco."""
    # Mapeia nomes frontend → banco
    # estoque_atual é o nome real da coluna no banco (não renomeia)
    if "foto_url" in body:
        url = body.pop("foto_url")
        body["imagens"] = [url] if url else []
    # categoria texto livre → salva em 'descricao' extra ou ignora categoria_id
    body.pop("categoria_id", None)   # nunca vem do frontend simples
    body.pop("destino", None)        # coluna não existe no schema

    # Numéricos
    for f in ["preco_venda", "preco_custo", "estoque_atual", "estoque_minimo"]:
        val = body.get(f)
        if val == "" or val is None:
            body[f] = 0
        else:
            try:
                body[f] = float(val)
            except (ValueError, TypeError):
                body[f] = 0

    # Strings opcionais → None se vazio
    for f in ["descricao", "categoria", "codigo_barras"]:
        if body.get(f) == "":
            body[f] = None

    return body


@products_bp.get("/")
@require_auth
def list_products():
    tid       = request.tenant_id
    search    = request.args.get("search", "").strip()
    categoria = request.args.get("categoria")
    ativo     = request.args.get("ativo")

    query = get_supabase_admin().table("products").select("*") \
        .eq("tenant_id", tid).order("nome")

    if search:
        query = query.or_(f"nome.ilike.%{search}%,codigo_barras.ilike.%{search}%")
    if categoria:
        query = query.eq("categoria", categoria)
    if ativo is not None:
        query = query.eq("ativo", ativo.lower() == "true")

    data = query.execute().data
    return success([_to_frontend(p) for p in data])


@products_bp.get("/<product_id>")
@require_auth
def get_product(product_id):
    resp = get_supabase_admin().table("products").select("*") \
        .eq("id", product_id).eq("tenant_id", request.tenant_id) \
        .maybe_single().execute()
    if not resp.data:
        return error("Produto não encontrado", 404)
    return success(_to_frontend(resp.data))


@products_bp.post("/")
@require_auth
def create_product():
    body = request.get_json() or {}
    body = _clean(body)

    if not body.get("nome"):
        return error("Nome é obrigatório")
    if body.get("preco_venda") is None:
        return error("Preço de venda é obrigatório")

    body["tenant_id"] = request.tenant_id
    body.setdefault("estoque_atual",   0)
    body.setdefault("estoque_minimo", 0)
    body.setdefault("unidade",  "un")
    body.setdefault("ativo",    True)

    # sku é NOT NULL no schema — gera automaticamente se não vier
    if not body.get("sku"):
        import uuid as _uuid
        body["sku"] = f"SKU-{str(_uuid.uuid4())[:8].upper()}"

    # Remove campos protegidos
    for f in ["id", "created_at", "updated_at", "criado_em", "atualizado_em",
              "margem_percentual"]:
        body.pop(f, None)

    sb = get_supabase_admin()
    try:
        resp = sb.table("products").insert(body).execute()
        return success(_to_frontend(resp.data[0]), "Produto cadastrado", 201)
    except Exception as e:
        # Se falhar por coluna inexistente (ex: categoria), tenta sem ela
        err_str = str(e)
        if "categoria" in err_str and "schema" in err_str.lower():
            body.pop("categoria", None)
            try:
                resp = sb.table("products").insert(body).execute()
                return success(_to_frontend(resp.data[0]), "Produto cadastrado", 201)
            except Exception as e2:
                return error(f"Erro ao cadastrar: {str(e2)}", 500)
        return error(f"Erro ao cadastrar: {err_str}", 500)


@products_bp.put("/<product_id>")
@require_auth
def update_product(product_id):
    body = request.get_json() or {}
    body = _clean(body)
    for f in ["id", "tenant_id", "created_at", "updated_at", "criado_em",
              "atualizado_em", "margem_percentual", "sku"]:
        body.pop(f, None)

    try:
        resp = get_supabase_admin().table("products") \
            .update(body).eq("id", product_id).eq("tenant_id", request.tenant_id).execute()
        if not resp.data:
            return error("Produto não encontrado", 404)
        return success(_to_frontend(resp.data[0]), "Produto atualizado")
    except Exception as e:
        return error(f"Erro ao atualizar: {str(e)}", 500)


@products_bp.delete("/<product_id>")
@require_auth
@require_papel("dono", "gerente")
def delete_product(product_id):
    get_supabase_admin().table("products") \
        .delete().eq("id", product_id).eq("tenant_id", request.tenant_id).execute()
    return success(message="Produto removido")


@products_bp.patch("/<product_id>/estoque")
@require_auth
def update_estoque(product_id):
    body      = request.get_json() or {}
    quantidade = body.get("quantidade")
    operacao   = body.get("operacao", "adicionar")

    if quantidade is None:
        return error("quantidade é obrigatório")

    sb   = get_supabase_admin()
    prod = sb.table("products").select("estoque_atual") \
        .eq("id", product_id).eq("tenant_id", request.tenant_id) \
        .maybe_single().execute()
    if not prod.data:
        return error("Produto não encontrado", 404)

    atual = float(prod.data["estoque_atual"] or 0)
    qtd   = float(quantidade)

    if operacao == "adicionar":
        novo = atual + qtd
    elif operacao == "subtrair":
        novo = max(0, atual - qtd)
    else:
        novo = qtd

    resp = sb.table("products").update({"estoque_atual": novo}) \
        .eq("id", product_id).eq("tenant_id", request.tenant_id).execute()
    return success(resp.data[0], f"Estoque: {novo}")


@products_bp.get("/categorias/lista")
@require_auth
def list_categorias():
    rows = get_supabase_admin().table("products").select("categoria") \
        .eq("tenant_id", request.tenant_id).not_.is_("categoria", "null").execute().data
    cats = sorted(set(r["categoria"] for r in rows if r.get("categoria")))
    return success(cats)
