#!/bin/bash
set -e
echo "🚀 Iniciando Microserviço WhatsApp (Node.js) em background..."
mkdir -p /data/auth_info_baileys
ln -sfn /data/auth_info_baileys /app/whatsapp-service/auth_info_baileys
cd /app/whatsapp-service && node index.js &
sleep 3
echo "🚀 Iniciando API Principal (Gunicorn/Flask)..."
cd /app && exec gunicorn --bind 0.0.0.0:7860 --workers 2 --worker-class sync --timeout 60 main:app
