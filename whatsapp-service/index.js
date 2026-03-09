require('dotenv').config()
const express = require('express')
const cors = require('cors')
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, makeInMemoryStore, jidDecode, Browsers } = require('@whiskeysockets/baileys')
const { GoogleGenerativeAI } = require('@google/generative-ai')
const { createClient } = require('@supabase/supabase-js')
const QRCode = require('qrcode')
const pino = require('pino')
const path = require('path')
const fs = require('fs')

const app = express()
app.use(cors())
app.use(express.json())

// ── Configuração Supabase ──
const supabase = createClient(
    process.env.SUPABASE_URL || "",
    process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY || ""
)

// ── Configurações Hardcoded do Admin (Fallback garantido, independente do DB) ──
const ADMIN_CONFIGS = {
    ai_provider: process.env.ADMIN_AI_PROVIDER || 'gemini',
    api_key: process.env.ADMIN_GEMINI_API_KEY || process.env.GEMINI_API_KEY || '',
    model: process.env.ADMIN_AI_MODEL || 'gemini-1.5-flash',
    system_prompt: 'Você é o assistente virtual da Red Comercial. Seja prestativo e objetivo.',
    ai_prefix: process.env.ADMIN_AI_PREFIX || 'red',
    ai_bot_enabled: false // Desabilitado por padrão até admin ativar
}

// ── Gerenciador de Sessões (Multi-Tenant) ──
const sessions = new Map() // tenantId -> { sock, aiConfigs, lastQr }

// ── Prevenção de crash silencioso do processo Node ──
process.on('uncaughtException', (err) => {
    console.error('❌ [CRITICAL] Uncaught Exception:', err?.message || err)
})
process.on('unhandledRejection', (reason) => {
    console.error('❌ [CRITICAL] Unhandled Rejection:', reason?.message || reason)
})

// Variáveis globais antigas removidas ou adaptadas para o modelo multi-tenant
// let sock = null
// let currentQr = null
// let qrStatus = 'disconnected'

// ── Funções de Conexão WhatsApp (Multi-Tenant) ──
async function connectToWhatsApp(tenantId) {
    console.log(`📡 Iniciando Conexão para Tenant: ${tenantId}`)
    const authPath = path.join(__dirname, `auth_info_baileys/tenant_${tenantId}`)
    // Garante que o diretório de autenticação exista
    if (!fs.existsSync(authPath)) {
        fs.mkdirSync(authPath, { recursive: true })
    }
    const { state, saveCreds } = await useMultiFileAuthState(authPath)
    const { version, isLatest } = await fetchLatestBaileysVersion() // Fetch version for each connection

    const sock = makeWASocket({
        version, // Usar a versão mais recente
        auth: state,
        printQRInTerminal: false, // QR codes serão retornados via API
        browser: Browsers.macOS('Desktop'),
        logger: pino({ level: 'silent' }) // Logger silencioso para evitar poluir o console
    })

    const session = { sock, aiConfigs: null, lastQr: null, status: 'connecting' }
    sessions.set(tenantId, session)

    // Carrega configs de IA do Tenant
    await loadTenantAIConfigs(tenantId)

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update
        
        if (qr) {
            session.lastQr = await QRCode.toDataURL(qr)
            session.status = 'qrcode'
            console.log(`🔗 Novo QR Code gerado para Tenant: ${tenantId}`)
            if (tenantId !== 'admin') {
                await supabase.from('whatsapp_sessions').upsert({ 
                    tenant_id: tenantId, 
                    status: 'qrcode', 
                    qr: session.lastQr,
                    updated_at: new Date() 
                }, { onConflict: 'tenant_id' })
            }
        }

        if (connection === 'close') {
            const statusCode = (lastDisconnect?.error)?.output?.statusCode
            console.log(`❌ Conexão Fechada (Tenant: ${tenantId}). Status Code: ${statusCode}`)
            session.status = 'disconnected'
            session.lastQr = null

            if (statusCode === DisconnectReason.loggedOut) {
                // Logout explícito: limpa tudo e NÃO reconecta
                console.log(`🚫 Tenant ${tenantId} deslogado explicitamente. Limpando...`)
                sessions.delete(tenantId)
                if (tenantId !== 'admin') {
                    await supabase.from('whatsapp_sessions').delete().eq('tenant_id', tenantId)
                }
                if (fs.existsSync(authPath)) fs.rmSync(authPath, { recursive: true, force: true })

            } else if (statusCode === 428) {
                // Auth corrompida: apaga pasta e gera novo QR do zero
                console.log(`⚠️ Tenant ${tenantId}: auth corrompida (428). Apagando sessão e reiniciando fresh...`)
                sessions.delete(tenantId)
                if (tenantId !== 'admin') {
                    await supabase.from('whatsapp_sessions').delete().eq('tenant_id', tenantId)
                }
                if (fs.existsSync(authPath)) fs.rmSync(authPath, { recursive: true, force: true })
                // Aguarda 2s antes de tentar novamente para evitar race condition
                setTimeout(() => connectToWhatsApp(tenantId), 2000)

            } else {
                // Qualquer outro erro: reconecta normalmente
                console.log(`🔄 Reconectando Tenant ${tenantId}...`)
                connectToWhatsApp(tenantId)
            }
        } else if (connection === 'open') {
            console.log(`✅ Conexão Aberta (Tenant: ${tenantId})`)
            session.status = 'authenticated'
            session.lastQr = null
            if (tenantId !== 'admin') {
                await supabase.from('whatsapp_sessions').upsert({ 
                    tenant_id: tenantId, 
                    status: 'authenticated', 
                    phone: sock.user.id,
                    qr: null,
                    updated_at: new Date() 
                }, { onConflict: 'tenant_id' })
            }
        }
    })

    sock.ev.on('creds.update', saveCreds)

    // ── Listener de Mensagens (IA Bot Multi-Tenant) ──
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return
        
        const botNumber = jidDecode(sock.user.id)?.user + '@s.whatsapp.net'
        const botLid = sock.user.lid || ''
        const botId = botNumber.split('@')[0].split(':')[0]
        const botLidShort = botLid.split('@')[0].split(':')[0]
        
        console.log(`🤖 Bot ID (Tenant ${tenantId}): ${botNumber} | LID: ${botLid}`)

        for (const msg of messages) {
            if (!msg.message || msg.key.fromMe) continue

            const remoteJid = msg.key.remoteJid
            const isGroup = remoteJid.endsWith('@g.us')
            
            // Extração de Conteúdo (Suporta Ephemeral, ViewOnce, etc)
            const msgType = Object.keys(msg.message)[0]
            let content = ""
            if (msgType === 'conversation') content = msg.message.conversation
            else if (msgType === 'extendedTextMessage') content = msg.message.extendedTextMessage.text
            else if (msgType === 'buttonsResponseMessage') content = msg.message.buttonsResponseMessage.selectedButtonId
            else if (msgType === 'listResponseMessage') content = msg.message.listResponseMessage.singleSelectReply.selectedRowId
            else if (msg.message[msgType]?.text) content = msg.message[msgType].text
            else if (msg.message[msgType]?.caption) content = msg.message[msgType].caption

            // Resiliência para contextInfo
            const contextInfo = msg.message?.extendedTextMessage?.contextInfo || 
                              msg.message?.imageMessage?.contextInfo || 
                              msg.message?.videoMessage?.contextInfo ||
                              msg.message?.ephemeralMessage?.message?.extendedTextMessage?.contextInfo ||
                              msg.message?.viewOnceMessage?.message?.imageMessage?.contextInfo ||
                              msg.message?.viewOnceMessage?.message?.videoMessage?.contextInfo ||
                              msg.message?.viewOnceMessageV2?.message?.imageMessage?.contextInfo ||
                              msg.message?.viewOnceMessageV2?.message?.videoMessage?.contextInfo

            const isMentioned = !!contextInfo?.mentionedJid?.some(jid => 
                jid.includes(botId) || (botLidShort && jid.includes(botLidShort))
            )
            const isReplyToMe = !!(contextInfo?.participant?.includes(botId) || (botLidShort && contextInfo?.participant?.includes(botLidShort)))
            
            // Verificação de Palavra-Chave (ai_prefix agora é tenant-specific)
            const keyword = session.aiConfigs?.ai_prefix?.trim() || ""
            const normalizeText = (text) => text ? text.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase() : ""
            const normContent = normalizeText(content)
            const normKeyword = normalizeText(keyword)
            const containsKeyword = Boolean(normKeyword && normContent.includes(normKeyword))

            if (isGroup) {
                console.log(`📩 [DEBUG GRUPO - Tenant ${tenantId}] text: "${content.substring(0,30)}..."`)
                console.log(`   - isMentioned: ${isMentioned}, isReplyToMe: ${isReplyToMe}, containsKeyword: ${containsKeyword}, keywordSetada: "${keyword}"`)
            }

            // Responde se: Ativo + (PV ou Menção ou Resposta ou Keyword)
            if (session.aiConfigs?.ai_bot_enabled === true && (!isGroup || isMentioned || isReplyToMe || containsKeyword)) {
                console.log(`🤖 IA (Tenant ${tenantId}): Processando mensagem de ${remoteJid}`)
                
                // Limpa JID, LID e Palavra-Chave do texto
                let cleanText = content.replace(new RegExp(`@${botId}`, 'g'), '').trim()
                if (botLidShort) {
                    cleanText = cleanText.replace(new RegExp(`@${botLidShort}`, 'g'), '').trim()
                }
                if (containsKeyword && keyword) {
                    // Remove a palavra-chave (case-insensitive) em qualquer lugar
                    const escapedKeyword = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
                    cleanText = cleanText.replace(new RegExp(escapedKeyword, 'gi'), '').trim()
                }

                // Monta Contexto Dinâmico (RAG)
                const businessContext = await getTenantContext(tenantId)
                const systemPrompt = session.aiConfigs.system_prompt || "Você é um assistente virtual prestativo e descontraído."
                const fullPrompt = `CONTEXTO DA EMPRESA:\n${businessContext}\n\nINSTRUÇÕES:\n${systemPrompt}\n\nPERGUNTA DO CLIENTE: ${cleanText || "Oi!"}`

                try {
                    const response = await getAIResponse(fullPrompt, session.aiConfigs)
                    if (response) {
                        await sock.sendMessage(remoteJid, { text: response }, { quoted: msg })
                    } else {
                        // Se a IA não retornar nada (null/empty), envia fallback
                        await sock.sendMessage(remoteJid, { text: "Sem conexão com o modelo." }, { quoted: msg })
                    }
                } catch (err) {
                    console.error(`Erro ao processar resposta da IA (Tenant ${tenantId}):`, err)
                    await sock.sendMessage(remoteJid, { text: "Sem conexão com o modelo." }, { quoted: msg })
                }
            }
        }
    })
}

// ── Funções de IA (Adaptadas para Multi-Tenant) ──

async function loadTenantAIConfigs(tenantId) {
    try {
        let configData = {}

        if (tenantId === 'admin') {
            // Admin: começa com valores hardcoded e tenta sobrescrever com o DB
            configData = { ...ADMIN_CONFIGS }
            try {
                const { data, error } = await supabase.from('ai_configs').select('*')
                if (!error && data && data.length > 0) {
                    const dbConfigs = {}
                    data.forEach(item => dbConfigs[item.key] = item.value)
                    const provider = dbConfigs.ai_provider || configData.ai_provider
                    configData = {
                        ai_provider: provider,
                        api_key: dbConfigs[`${provider}_api_key`] || configData.api_key,
                        model: dbConfigs[`${provider}_model`] || configData.model,
                        system_prompt: dbConfigs[`${provider}_system_prompt`] || configData.system_prompt,
                        ai_prefix: dbConfigs.ai_prefix || configData.ai_prefix,
                        ai_bot_enabled: dbConfigs.ai_bot_enabled === 'true'
                    }
                    console.log(`✅ [Admin] Configs de IA carregadas do DB. Provedor: ${configData.ai_provider}`)
                } else {
                    console.log(`⚠️ [Admin] Usando configs hardcoded (DB vazio ou erro). Provedor: ${configData.ai_provider}`)
                }
            } catch (dbErr) {
                console.log(`⚠️ [Admin] DB indisponível, usando hardcoded: ${dbErr?.message}`)
            }
        } else {
            // Tenants usam a nova tabela 'whatsapp_tenant_configs'
            const { data: tenantDataArray, error } = await supabase.from('whatsapp_tenant_configs').select('*').eq('tenant_id', tenantId).limit(1)
            if (error) throw error
            const data = tenantDataArray && tenantDataArray.length > 0 ? tenantDataArray[0] : null
            
            configData = {
                ai_provider: data?.ai_provider || 'gemini',
                api_key: data?.api_key || '',
                model: data?.model || '',
                system_prompt: data?.system_prompt || 'Você é o assistente virtual da Red Comercial.',
                ai_prefix: data?.ai_prefix || '',
                ai_bot_enabled: data?.ai_enabled === true // Corrigido para 'ai_enabled' (coluna da tabela)
            }
        }
        
        const session = sessions.get(tenantId)
        if (session) {
            session.aiConfigs = configData
            console.log(`✅ Configurações de IA carregadas para Tenant ${tenantId}. Provedor: ${configData.ai_provider}`)
        }
    } catch (err) {
        console.error(`Erro ao carregar configs de IA para Tenant ${tenantId}:`, err)
        const session = sessions.get(tenantId)
        if (session) {
            // Para admin: usa hardcoded. Para tenants: usa fallback padrão
            session.aiConfigs = tenantId === 'admin' ? { ...ADMIN_CONFIGS } : {
                ai_provider: 'gemini',
                api_key: process.env.GEMINI_API_KEY || '',
                model: 'gemini-1.5-flash',
                system_prompt: 'Você é um assistente virtual prestativo e descontraído.',
                ai_prefix: '',
                ai_bot_enabled: false
            }
        }
    }
}

async function getTenantContext(tenantId) {
    try {
        // Busca dados básicos do tenant
        const { data: tenant, error: tenantError } = await supabase.from('tenants').select('nome, descricao, tipo, endereco, cidade').eq('id', tenantId).single()
        if (tenantError) throw tenantError
        
        // Busca produtos/cardápio/serviços (Simplificado)
        const { data: products, error: productsError } = await supabase.from('products').select('nome, preco, estoque_atual').eq('tenant_id', tenantId).limit(20)
        if (productsError) console.error("Erro ao buscar produtos:", productsError) // Não impede o contexto de ser gerado

        let context = `Nome da Empresa: ${tenant?.nome || 'Empresa'}\n`
        context += `Ramo de Atividade: ${tenant?.tipo || 'Comércio'}\n`
        context += `Descrição da Empresa: ${tenant?.descricao || ''}\n`
        context += `Endereço: ${tenant?.endereco || ''}, ${tenant?.cidade || ''}\n`
        
        if (products && products.length > 0) {
            context += `\nPRODUTOS/SERVIÇOS DISPONÍVEIS:\n`
            products.forEach(p => {
                context += `- ${p.nome}: R$ ${p.preco ? p.preco.toFixed(2) : 'Sob consulta'} (Estoque: ${p.estoque_atual || 'Sob consulta'})\n`
            })
        }
        
        return context
    } catch (err) {
        console.error(`Erro ao buscar contexto para Tenant ${tenantId}:`, err)
        return "Dados da empresa temporariamente indisponíveis. Por favor, tente novamente mais tarde."
    }
}

async function getAIResponse(text, configs) {
    const provider = configs.ai_provider || 'gemini'
    try {
        if (!configs.api_key || !configs.model) {
            console.warn(`IA (Tenant): API Key ou Modelo não configurado para o provedor ${provider}.`)
            return "Desculpe, meu cérebro de IA não está totalmente configurado no momento. Por favor, avise o administrador!"
        }

        if (provider === 'gemini') {
            const genAI = new GoogleGenerativeAI(configs.api_key)
            const model = genAI.getGenerativeModel({ 
                model: configs.model,
                systemInstruction: configs.system_prompt // Gemini SDK aceita systemInstruction
            })
            const result = await model.generateContent(text)
            return result.response.text()
        } 
        
        // Lógica para Groq e OpenRouter via Fetch (OpenAI Compatible)
        let apiUrl = ""
        if (provider === 'groq') {
            apiUrl = "https://api.groq.com/openai/v1/chat/completions"
        } else if (provider === 'openrouter') {
            apiUrl = "https://openrouter.ai/api/v1/chat/completions"
        } else {
            return "Provedor de IA desconhecido."
        }

        const response = await fetch(apiUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${configs.api_key}`,
                'HTTP-Referer': 'https://redcomercial.com.br', // Recomendado pelo OpenRouter
                'X-Title': 'Red Comercial Bot'
            },
            body: JSON.stringify({
                model: configs.model,
                messages: [
                    { role: "system", content: configs.system_prompt },
                    { role: "user", content: text }
                ]
            })
        })

        const data = await response.json()
        if (data.error) {
            console.error(`Erro da API ${provider}:`, data.error)
            return null // Fallback acionado pelo chamador
        }
        return data.choices?.[0]?.message?.content || null

    } catch (err) {
        console.error(`Erro na IA (Multi-Tenant, Provedor: ${provider}):`, err)
        return null // Fallback acionado pelo chamador
    }
}

// ── Endpoints da API ──

// Aliases para o Admin (Legacy/Global support)
app.get('/status', (req, res) => res.redirect('/status/admin'))
app.post('/start', (req, res) => res.redirect(307, '/start/admin'))
app.post('/stop', (req, res) => res.redirect(307, '/stop/admin'))
app.get('/groups', (req, res) => res.redirect('/groups/admin'))
app.post('/send', (req, res) => res.redirect(307, '/send/admin'))
app.post('/ai/reload', (req, res) => res.redirect(307, '/ai/reload/admin'))

app.get('/status/:tenantId', (req, res) => {
    const { tenantId } = req.params
    const session = sessions.get(tenantId)
    if (!session) {
        return res.json({ status: 'disconnected', qr: null, message: 'Sessão não encontrada ou desconectada.' })
    }
    res.json({ status: session.status, qr: session.lastQr, message: `Status da sessão para ${tenantId}` })
})

app.post('/start/:tenantId', async (req, res) => {
    const { tenantId } = req.params
    if (sessions.has(tenantId) && sessions.get(tenantId).status !== 'disconnected') {
        return res.json({ success: true, message: 'Sessão já está rodando ou em processo de conexão.', status: sessions.get(tenantId).status })
    }
    connectToWhatsApp(tenantId)
    res.json({ success: true, message: 'Iniciando conexão para o tenant...', status: 'connecting' })
})

app.post('/stop/:tenantId', async (req, res) => {
    const { tenantId } = req.params
    const session = sessions.get(tenantId)
    
    // Força a exclusão do dirted folder sempre que alguém pedir stop (Reset Manual Admin)
    const authPath = path.join(__dirname, `auth_info_baileys/tenant_${tenantId}`)
    
    if (session && session.sock) {
        try {
            await session.sock.logout() // Isso deve disparar o 'connection.update' com DisconnectReason.loggedOut
            console.log(`Sessão do Tenant ${tenantId} desconectada via logout.`)
            res.json({ success: true, message: 'Sessão desconectada com sucesso.' })
        } catch (e) {
            console.error(`Erro ao fazer logout do Tenant ${tenantId}:`, e)
            res.status(500).json({ success: false, message: 'Erro ao desconectar a sessão.' })
        }
    } else {
        // Se a sessão em RAM morreu mas a pasta corrompida existe, a API deve limpar a pasta pra poder reconectar depois
        if (fs.existsSync(authPath)) {
             fs.rmSync(authPath, { recursive: true, force: true })
             console.log(`Limpeza manual da pasta de auth pendente do Tenant ${tenantId}.`)
        }
        res.json({ success: true, message: 'Nenhuma sessão ativa para este tenant (Pastas limpas se existiam).' })
    }
})

app.post('/ai/reload/:tenantId', async (req, res) => {
    const { tenantId } = req.params
    console.log(`🔄 Recarregando configurações de IA para Tenant ${tenantId} manualmente...`)
    await loadTenantAIConfigs(tenantId)
    res.json({ success: true, message: `Configurações de IA para Tenant ${tenantId} recarregadas.` })
})

app.post('/ai/list-models', async (req, res) => {
    const { api_key, provider } = req.body
    if (!api_key || !provider) return res.status(400).json({ error: 'API Key e Provedor necessários' })
    
    try {
        let apiUrl = ""
        let headers = {}
        
        if (provider === 'gemini') {
            apiUrl = `https://generativelanguage.googleapis.com/v1beta/models?key=${api_key}`
        } else if (provider === 'groq') {
            apiUrl = "https://api.groq.com/openai/v1/models"
            headers = { "Authorization": `Bearer ${api_key}` }
        } else if (provider === 'openrouter') {
            apiUrl = "https://openrouter.ai/api/v1/models"
            headers = { "Authorization": `Bearer ${api_key}` }
        } else {
            return res.status(400).json({ error: 'Provedor de IA inválido.' })
        }

        const response = await fetch(apiUrl, { headers })
        const data = await response.json()
        
        if (data.error) {
            throw new Error(data.error.message || 'Erro ao buscar modelos')
        }

        let models = []
        if (provider === 'gemini') {
            models = data.models
                .filter(m => m.supportedGenerationMethods.includes('generateContent'))
                .map(m => ({ id: m.name.replace('models/', ''), name: m.displayName }))
        } else {
            // Groq e OpenRouter retornam array 'data'
            models = (data.data || []).map(m => ({
                id: m.id,
                name: m.id // Geralmente o id é o nome técnico (ex: gpt-3.5-turbo)
            }))
        }

        res.json({ success: true, models })
    } catch (err) {
        console.error('Erro ao listar modelos:', err)
        res.status(500).json({ error: err.message })
    }
})

app.get('/groups/:tenantId', async (req, res) => {
    const { tenantId } = req.params
    const session = sessions.get(tenantId)
    
    if (!session || session.status !== 'authenticated') {
        return res.status(503).json({ success: false, error: 'WhatsApp não está conectado para este tenant' })
    }

    try {
        if (typeof session.sock.groupFetchAllParticipating !== 'function') {
            return res.status(503).json({ success: false, error: 'Socket não suporta listagem de grupos' })
        }
        const groupMetadata = await session.sock.groupFetchAllParticipating()
        const groups = Object.values(groupMetadata).map(group => ({
            id: group.id,
            subject: group.subject
        }))
        res.json({ success: true, groups })
    } catch (err) {
        console.error(`Erro ao buscar grupos (Tenant ${tenantId}):`, err?.message || err)
        res.status(500).json({ success: false, error: 'Erro ao buscar grupos.' })
    }
})

app.post('/send/:tenantId', async (req, res) => {
    const { tenantId } = req.params
    const session = sessions.get(tenantId)

    if (!session || session.status !== 'authenticated') {
        return res.status(503).json({ success: false, error: 'WhatsApp não está conectado para este tenant' })
    }

    try {
        const { number, message } = req.body
        if (!number || !message) {
            return res.status(400).json({ error: 'Número e mensagem são obrigatórios' })
        }

        let formattedNumber = number
        if (!formattedNumber.includes('@')) {
            if (formattedNumber.includes('-') || formattedNumber.length > 15) {
                formattedNumber = `${formattedNumber}@g.us`
            } else {
                formattedNumber = `${formattedNumber}@s.whatsapp.net`
            }
        }
        
        await session.sock.sendMessage(formattedNumber, { text: message })
        console.log(`Mensagem enviada pelo Tenant ${tenantId} para ${number}`)
        
        res.json({ success: true, status: 'Enviado' })
    } catch (err) {
        console.error(`Erro de envio (Tenant ${tenantId}):`, err)
        res.status(500).json({ error: err.message })
    }
})

const PORT = process.env.WHATSAPP_PORT || 3001
app.listen(PORT, () => console.log(`🚀 Multi-Tenant WhatsApp Service rodando na porta ${PORT}`))
