FROM python:3.11-slim

# Instala Node.js 20 LTS + dependências nativas (sharp, baileys)
RUN apt-get update && apt-get install -y \
    curl git python3 make g++ libvips-dev \
    && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y nodejs \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Dependências Python
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Dependências Node (whatsapp-service)
COPY whatsapp-service/package.json whatsapp-service/
RUN cd whatsapp-service && npm install --omit=dev

# Código completo
COPY . .

# Pasta de sessão WhatsApp (sobrescrita pelo volume no fly.toml)
RUN mkdir -p /data/auth_info_baileys

RUN chmod +x start.sh

EXPOSE 7860

CMD ["bash", "start.sh"]
