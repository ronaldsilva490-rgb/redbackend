from supabase import create_client, Client
from flask import current_app

_client: Client | None = None
_admin_client: Client | None = None


def get_supabase() -> Client:
    """Cliente anon — usado nas rotas autenticadas (RLS ativo)."""
    global _client
    if _client is None:
        _client = create_client(
            current_app.config["SUPABASE_URL"],
            current_app.config["SUPABASE_KEY"]
        )
    return _client


def get_supabase_admin() -> Client:
    """Cliente service_role — bypassa RLS. Usar APENAS em operações admin
    como criar tenant, registrar usuário, etc."""
    global _admin_client
    if _admin_client is None:
        _admin_client = create_client(
            current_app.config["SUPABASE_URL"],
            current_app.config["SUPABASE_SERVICE_KEY"]
        )
    return _admin_client


class _LazySupabaseClient:
    """Lazy-loading proxy para o cliente Supabase anon."""
    def __getattr__(self, name):
        return getattr(get_supabase(), name)


# Exporta um objeto que age como um cliente Supabase
supabase = _LazySupabaseClient()
