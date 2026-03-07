from flask import Flask
from flask_cors import CORS
from .config import Config
from .utils.logger import log_request_middleware


def create_app():
    app = Flask(__name__)
    app.config.from_object(Config)
    app.url_map.strict_slashes = False

    allowed_origins = [
        "https://redcomercialweb.vercel.app",
        "http://localhost:5173",
        "http://localhost:3000",
    ]
    CORS(app, resources={r"/api/*": {"origins": allowed_origins}})
    
    # Ativa middleware de logging automático
    log_request_middleware(app)

    from .routes.auth          import auth_bp
    from .routes.tenants       import tenants_bp
    from .routes.vehicles      import vehicles_bp
    from .routes.clients       import clients_bp
    from .routes.workshop      import workshop_bp
    from .routes.finance       import finance_bp
    from .routes.products      import products_bp
    from .routes.tables        import tables_bp
    from .routes.orders        import orders_bp
    from .routes.notifications import notif_bp
    from .routes.sales         import sales_bp
    from .routes.upload        import upload_bp
    from .routes.stock         import stock_bp
    from .routes.superadmin    import superadmin_bp
    from .routes.caixa         import caixa_bp
    from .routes.logs          import logs_bp
    from .routes.settings      import settings_bp
    from .routes.ai_agent      import ai_agent_bp

    app.register_blueprint(auth_bp,        url_prefix="/api/auth")
    app.register_blueprint(tenants_bp,     url_prefix="/api/tenants")
    app.register_blueprint(vehicles_bp,    url_prefix="/api/vehicles")
    app.register_blueprint(clients_bp,     url_prefix="/api/clients")
    app.register_blueprint(workshop_bp,    url_prefix="/api/workshop")
    app.register_blueprint(finance_bp,     url_prefix="/api/finance")
    app.register_blueprint(products_bp,    url_prefix="/api/products")
    app.register_blueprint(tables_bp,      url_prefix="/api/tables")
    app.register_blueprint(orders_bp,      url_prefix="/api/orders")
    app.register_blueprint(notif_bp,       url_prefix="/api/notifications")
    app.register_blueprint(sales_bp,       url_prefix="/api/sales")
    app.register_blueprint(upload_bp,      url_prefix="/api/upload")
    app.register_blueprint(stock_bp,       url_prefix="/api/stock")
    app.register_blueprint(superadmin_bp,  url_prefix="/api/superadmin")
    app.register_blueprint(caixa_bp,       url_prefix="/api/caixa")
    app.register_blueprint(logs_bp,        url_prefix="/api/superadmin")
    app.register_blueprint(settings_bp,    url_prefix="/api/superadmin")
    app.register_blueprint(ai_agent_bp)

    @app.get("/")
    def health():
        return {"status": "RED API online", "version": "5.0.0"}

    return app
