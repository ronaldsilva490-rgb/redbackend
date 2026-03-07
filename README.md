---
title: RED Backend API
emoji: 🔴
colorFrom: red
colorTo: gray
sdk: docker
pinned: false
app_port: 7860
---

# RED — Backend API v1.0

API REST em Flask para o sistema RED de Gestão Comercial.

## Endpoints

| Método | Rota | Descrição |
|--------|------|-----------|
| POST | /api/auth/login | Login |
| POST | /api/auth/logout | Logout |
| GET | /api/vehicles | Listar veículos |
| POST | /api/vehicles | Cadastrar veículo |
| GET | /api/clients | Listar clientes |
| GET | /api/clients/leads | Listar leads/CRM |
| GET | /api/workshop/os | Listar ordens de serviço |
| GET | /api/finance/summary | Resumo financeiro |

## Stack
- Flask 3.0
- Supabase (PostgreSQL + Auth)
- Gunicorn (produção)
