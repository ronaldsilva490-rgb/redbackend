#!/bin/bash
set -e

echo "🔧 Configurando DNS..."

# Tenta configurar DNS via resolvectl (systemd-resolved)
if command -v resolvectl &> /dev/null; then
    echo "Using resolvectl..."
    resolvectl dns 1.1.1.1 8.8.8.8 || true
fi

# Tenta via netcat/nc para testar conectividade
if command -v nc &> /dev/null; then
    echo "Testing DNS resolution..."
    nc -zv api.openrouter.io 443 || echo "⚠️  TCP test failed (DNS might still work)"
fi

# Tenta fazer um curl para testar
echo "Testing HTTP connectivity to api.openrouter.io..."
curl -I https://api.openrouter.io --max-time 5 || echo "⚠️  Curl failed (will retry in app)"

echo "✓ DNS configuration attempt complete"
echo ""
echo "🚀 Starting Flask app..."

# Inicia a aplicação
exec python main.py
