FROM python:3.11-slim

# Instala git, curl, dnsutils e netcat (necessário para diagnosticos e DNS)
RUN apt-get update && apt-get install -y git curl dnsutils netcat-traditional && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

# Copia entrypoint script
COPY entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh

EXPOSE 7860

# Usa entrypoint script para configurar DNS antes de rodar a app
ENTRYPOINT ["/app/entrypoint.sh"]
