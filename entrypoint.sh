#!/bin/bash
set -e

echo "� Starting Flask app..."

# Inicia a aplicação com Gunicorn
exec gunicorn --bind 0.0.0.0:7860 --workers 2 --worker-class sync --timeout 60 main:app
