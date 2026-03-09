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
    gemini_api_key: process.env.GEMINI_API_KEY || "",
    gemini_model: "",
    gemini_system_prompt: "Você é o assistente virtual da Red Comercial. Responda de forma prestativa e descontraída.",
    ai_bot_enabled: "false"
}
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
    if (aiConfigs.gemini_api_key && aiConfigs.gemini_model) {
        const genAI = new GoogleGenerativeAI(aiConfigs.gemini_api_key)
        aiModel = genAI.getGenerativeModel({ 
            model: aiConfigs.gemini_model,
            systemInstruction: aiConfigs.gemini_system_prompt
        })
    } else {
        aiModel = null
    }
}

async function getGeminiResponse(text) {
    try {
        if (!aiModel) return null
        const result = await aiModel.generateContent(text)
        return result.response.text()
    } catch (err) {
        console.error('Erro Gemini:', err)
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
        const botId = botNumber.split('@')[0]
        console.log(`🤖 Bot ID: ${botNumber}`)

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

            const isMentioned = !!contextInfo?.mentionedJid?.some(jid => jid.includes(botId))
            const isReplyToMe = !!contextInfo?.participant?.includes(botId)
            
            if (isGroup) {
                console.log(`📩 [DEBUG GRUPO] RemoteJid: ${remoteJid}`)
                console.log(`   - Texto: "${content}"`)
                console.log(`   - ContextInfo detectado: ${contextInfo ? 'Sim' : 'Não'}`)
                if (contextInfo) {
                    console.log(`   - mentionedJid: ${JSON.stringify(contextInfo.mentionedJid)}`)
                    console.log(`   - participant (reply): ${contextInfo.participant}`)
                }
                console.log(`   - containsBotId: ${content.includes(botId)}`)
            }

            // Responde se: 1. Bot Ativo | 2. PV | 3. Grupo + Menção | 4. Grupo + Resposta ao Bot | 5. Contém ID do Bot no texto
            const shouldRespond = aiConfigs.ai_bot_enabled === 'true' && (!isGroup || isMentioned || isReplyToMe || content.includes(botId))
            
            if (isGroup) {
                console.log(`   - isMentioned: ${isMentioned}, isReplyToMe: ${isReplyToMe}, shouldRespond: ${shouldRespond}`)
            }

            if (shouldRespond) {
                console.log(`🤖 IA: Processando mensagem de ${remoteJid}`)
                
                const cleanText = content.replace(new RegExp(`@${botId}`, 'g'), '').trim()
                
                const response = await getGeminiResponse(cleanText || "Oi!")
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
    const { api_key } = req.body
    if (!api_key) return res.status(400).json({ error: 'API Key necessária' })
    
    try {
        // Busca os modelos reais da API do Google
        const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${api_key}`)
        const data = await response.json()
        
        if (data.error) {
            throw new Error(data.error.message || 'Erro ao buscar modelos')
        }

        // Filtra modelos que suportam geração de conteúdo (generateContent)
        const models = data.models
            .filter(m => m.supportedGenerationMethods.includes('generateContent'))
            .map(m => ({
                id: m.name.replace('models/', ''),
                name: m.displayName
            }))

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
