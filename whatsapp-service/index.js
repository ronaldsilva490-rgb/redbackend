require('dotenv').config()
const express = require('express')
const cors = require('cors')
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, makeInMemoryStore, jidDecode, Browsers } = require('@whiskeysockets/baileys')
const { GoogleGenerativeAI } = require('@google/generative-ai')
const { createClient } = require('@supabase/supabase-js')
const QRCode = require('qrcode')
const pino = require('pino')

const app = express()
app.use(cors())
app.use(express.json())

// ── Configuração Supabase ──
const supabase = createClient(
    process.env.SUPABASE_URL || "",
    process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY || ""
)

let sock = null
let currentQr = null
let qrStatus = 'disconnected' 

// ── Estado da IA em Memória ──
let aiConfigs = {
    ai_provider: 'gemini',
    gemini_api_key: process.env.GEMINI_API_KEY || "",
    gemini_model: "",
    groq_api_key: "",
    groq_model: "",
    openrouter_api_key: "",
    openrouter_model: "",
    gemini_system_prompt: "Você é o assistente virtual da Red Comercial. Responda de forma prestativa e descontraída.",
    ai_bot_enabled: "false"
}
let genAI = null
let aiModel = null

async function loadAIConfigs() {
    try {
        const { data, error } = await supabase.from('ai_configs').select('*')
        if (!error && data) {
            data.forEach(item => {
                aiConfigs[item.key] = item.value
            })
            console.log('✅ Configurações de IA carregadas do Banco de Dados.')
            initAIModel()
        }
    } catch (err) {
        console.error('Erro ao carregar configs de IA:', err)
    }
}

function initAIModel() {
    const provider = aiConfigs.ai_provider || 'gemini'
    console.log(`🤖 Inicializando Provedor de IA: ${provider}`)
    
    if (provider === 'gemini') {
        if (aiConfigs.gemini_api_key && aiConfigs.gemini_model) {
            genAI = new GoogleGenerativeAI(aiConfigs.gemini_api_key)
            aiModel = genAI.getGenerativeModel({ 
                model: aiConfigs.gemini_model,
                systemInstruction: aiConfigs.gemini_system_prompt
            })
        } else {
            aiModel = null
        }
    } else {
        // Para Groq e OpenRouter, não usamos SDK específico aqui (usamos fetch no call)
        aiModel = provider 
    }
}

async function getAIResponse(text) {
    const provider = aiConfigs.ai_provider || 'gemini'
    try {
        if (!aiModel) return null

        if (provider === 'gemini') {
            const result = await aiModel.generateContent(text)
            return result.response.text()
        } 
        
        // Lógica para Groq e OpenRouter via Fetch (OpenAI Compatible)
        let apiUrl = ""
        let apiKey = ""
        let model = ""
        
        if (provider === 'groq') {
            apiUrl = "https://api.groq.com/openai/v1/chat/completions"
            apiKey = aiConfigs.groq_api_key
            model = aiConfigs.groq_model
        } else if (provider === 'openrouter') {
            apiUrl = "https://openrouter.ai/api/v1/chat/completions"
            apiKey = aiConfigs.openrouter_api_key
            model = aiConfigs.openrouter_model
        }

        if (!apiKey || !model) return null

        const response = await fetch(apiUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`,
                'HTTP-Referer': 'https://redcomercial.com.br', // Recomendado pelo OpenRouter
                'X-Title': 'Red Comercial Bot'
            },
            body: JSON.stringify({
                model: model,
                messages: [
                    { role: "system", content: aiConfigs.gemini_system_prompt },
                    { role: "user", content: text }
                ]
            })
        })

        const data = await response.json()
        return data.choices?.[0]?.message?.content || null

    } catch (err) {
        console.error(`Erro na IA (${provider}):`, err)
        return "Eita, deu um revertério aqui na minha cabeça agora! Tenta de novo mais tarde, viu? 🤯"
    }
}

async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('/data/auth_info_baileys')
    const { version, isLatest } = await fetchLatestBaileysVersion()
    console.log(`Usando WhatsApp Web v${version.join('.')} (Latest: ${isLatest})`)
    
    sock = makeWASocket({
        version,
        auth: state,
        logger: pino({ level: 'info' }),
        printQRInTerminal: true,
        browser: Browsers.macOS('Desktop')
    })

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update
        
        if (qr) {
            qrStatus = 'qrcode'
            try {
                currentQr = await QRCode.toDataURL(qr)
                console.log('🔗 Novo QR Code gerado.')
            } catch (err) {
                console.error('Erro ao gerar base64', err)
            }
        }

        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect.error)?.output?.statusCode !== DisconnectReason.loggedOut
            console.log('🔴 Conexão encerrada. Reconectando:', shouldReconnect)
            qrStatus = 'disconnected'
            currentQr = null
            if (shouldReconnect) connectToWhatsApp()
        } else if (connection === 'open') {
            console.log('🟢 WhatsApp Conectado!')
            qrStatus = 'authenticated'
            currentQr = null
        }
    })

    sock.ev.on('creds.update', saveCreds)

    // ── Listener de Mensagens (IA Bot) ──
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return
        
        const botNumber = jidDecode(sock.user.id)?.user + '@s.whatsapp.net'
        const botLid = sock.user.lid || ''
        const botId = botNumber.split('@')[0].split(':')[0]
        const botLidShort = botLid.split('@')[0].split(':')[0]
        
        console.log(`🤖 Bot ID: ${botNumber} | LID: ${botLid} | BotClean: ${botId} | LidClean: ${botLidShort}`)

        for (const msg of messages) {
            if (!msg.message || msg.key.fromMe) continue

            const remoteJid = msg.key.remoteJid
            const isGroup = remoteJid.endsWith('@g.us')
            
            // Extração resiliente de conteúdo e contexto
            const m = msg.message
            const content = m.conversation || m.extendedTextMessage?.text || m.imageMessage?.caption || m.videoMessage?.caption || 
                          m.viewOnceMessage?.message?.imageMessage?.caption || m.viewOnceMessage?.message?.videoMessage?.caption ||
                          m.viewOnceMessageV2?.message?.imageMessage?.caption || m.viewOnceMessageV2?.message?.videoMessage?.caption || ""
            
            const contextInfo = m.extendedTextMessage?.contextInfo || m.imageMessage?.contextInfo || m.videoMessage?.contextInfo ||
                              m.viewOnceMessage?.message?.imageMessage?.contextInfo || m.viewOnceMessage?.message?.videoMessage?.contextInfo ||
                              m.viewOnceMessageV2?.message?.imageMessage?.contextInfo || m.viewOnceMessageV2?.message?.videoMessage?.contextInfo

            // Verifica menção pelo ID tradicional (JID) ou pelo novo LID
            const isMentioned = !!contextInfo?.mentionedJid?.some(jid => 
                jid.includes(botId) || (botLidShort && jid.includes(botLidShort))
            )
            const isReplyToMe = !!(contextInfo?.participant?.includes(botId) || (botLidShort && contextInfo?.participant?.includes(botLidShort)))
            
            if (isGroup) {
                console.log(`📩 [DEBUG GRUPO] text: "${content.substring(0,30)}..."`)
                console.log(`   - mentionedJid: ${JSON.stringify(contextInfo?.mentionedJid)}`)
                console.log(`   - isMentioned: ${isMentioned}, isReplyToMe: ${isReplyToMe}`)
            }

            // Responde se: 1. Bot Ativo | 2. PV | 3. Grupo + Menção | 4. Grupo + Resposta ao Bot
            if (aiConfigs.ai_bot_enabled === 'true' && (!isGroup || isMentioned || isReplyToMe)) {
                console.log(`🤖 IA: Processando mensagem de ${remoteJid}`)
                
                // Limpa tanto o JID quanto o LID do texto
                let cleanText = content.replace(new RegExp(`@${botId}`, 'g'), '').trim()
                if (botLidShort) {
                    cleanText = cleanText.replace(new RegExp(`@${botLidShort}`, 'g'), '').trim()
                }
                
                const response = await getAIResponse(cleanText || "Oi!")
                if (response) {
                    await sock.sendMessage(remoteJid, { text: response }, { quoted: msg })
                }
            }
        }
    })
}

// Inicializa no boot
connectToWhatsApp()
loadAIConfigs()

// Endpoints
app.get('/status', (req, res) => {
    res.json({
        status: qrStatus,
        qr: currentQr,
        ai: {
            enabled: aiConfigs.ai_bot_enabled === 'true',
            model: aiConfigs.gemini_model
        }
    })
})

app.post('/ai/reload', (req, res) => {
    console.log('🔄 Recarregando configurações de IA manualmente...')
    loadAIConfigs()
    res.json({ success: true })
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

app.get('/groups', async (req, res) => {
    try {
        if (qrStatus !== 'authenticated' || !sock) {
            return res.status(503).json({ success: false, error: 'WhatsApp não está conectado' })
        }
        // Verifica se o método existe antes de chamar
        if (typeof sock.groupFetchAllParticipating !== 'function') {
            return res.status(503).json({ success: false, error: 'Socket não suporta listagem de grupos nesta versão' })
        }
        const groupMetadata = await sock.groupFetchAllParticipating()
        const groups = Object.values(groupMetadata).map(group => ({
            id: group.id,
            subject: group.subject
        }))
        res.json({ success: true, groups })
    } catch (err) {
        console.error('Erro ao buscar grupos (sem derrubar conexão):', err?.message || err)
        // Retorna erro SEM deixar o crash propagar pro socket principal
        res.status(500).json({ success: false, error: 'Erro ao buscar grupos: ' + (err?.message || 'desconhecido') })
    }
})

app.post('/send', async (req, res) => {
    try {
        if (qrStatus !== 'authenticated') {
            return res.status(503).json({ error: 'WhatsApp não está conectado' })
        }

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
        
        await sock.sendMessage(formattedNumber, { text: message })
        console.log(`Mensagem enviada para ${number}`)
        
        res.json({ success: true, status: 'Enviado' })
    } catch (err) {
        console.error('Erro de envio:', err)
        res.status(500).json({ error: err.message })
    }
})

app.listen(3001, () => {
    console.log('✅ Microserviço WhatsApp rodando na porta 3001')
})
