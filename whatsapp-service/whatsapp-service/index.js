require('dotenv').config()
const express = require('express')
const cors = require('cors')
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion,
    jidDecode, Browsers, downloadMediaMessage } = require('@whiskeysockets/baileys')
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

// ── UUID fixo do Admin ──
const ADMIN_TENANT_ID = process.env.ADMIN_TENANT_ID || 'admin'

// ── Gerenciador de Sessões (Multi-Tenant) ──
const sessions = new Map()

// ── Memória em RAM ──
const conversationBuffers = new Map()   // aprendizado
const recentMessages = new Map()        // janela deslizante (últimas 15 msgs por conversa)
const lastBotMessageTime = new Map()    // cooldown por conversa
const MAX_BUFFER_MESSAGES = 8           // aumentado de 5 → 8 para contexto melhor
const MAX_WINDOW_MESSAGES = 15          // janela deslizante

// ── Cache de Versão Baileys ──
let cachedBaileysVersion = null
let fetchVersionPromise = null

async function getBaileysVersion() {
    if (cachedBaileysVersion) return cachedBaileysVersion
    if (fetchVersionPromise) return fetchVersionPromise
    fetchVersionPromise = fetchLatestBaileysVersion().then(v => {
        cachedBaileysVersion = v
        return v
    }).catch(() => ({ version: [2, 3000, 1015901307], isLatest: true }))
    return fetchVersionPromise
}

// ── Anti-crash ──
process.on('uncaughtException', (err) => console.error('❌ [CRITICAL] Uncaught Exception:', err?.message || err))
process.on('unhandledRejection', (reason) => console.error('❌ [CRITICAL] Unhandled Rejection:', reason?.message || reason))


// ═══════════════════════════════════════════════════════════════════
// 🎙️  TTS — Microsoft Edge (GRATUITO, sem key, PT-BR Neural)
// ═══════════════════════════════════════════════════════════════════

async function textToSpeech(text, voice = null) {
    try {
        // Lazy-load edge-tts-universal
        const { EdgeTTS } = require('edge-tts-universal')
        const selectedVoice = voice || process.env.TTS_VOICE || 'pt-BR-ThalitaMultilingualNeural'

        // Limpa markdown e formatação antes de sintetizar
        const cleanText = text
            .replace(/\*\*(.*?)\*\*/g, '$1')
            .replace(/\*(.*?)\*/g, '$1')
            .replace(/```[\s\S]*?```/g, '')
            .replace(/`(.*?)`/g, '$1')
            .replace(/#{1,6}\s/g, '')
            .trim()

        if (!cleanText || cleanText.length < 2) return null

        const tts = new EdgeTTS(cleanText, selectedVoice)
        const result = await tts.synthesize()
        return Buffer.concat(result.audio)
    } catch (err) {
        console.error('[TTS] Erro:', err?.message)
        return null
    }
}

// Decide se vai responder em áudio ou texto
function shouldSendAudio(responseText, context, configs, lastMessageWasAudio) {
    // Nunca áudio para respostas longas ou técnicas
    if (responseText.length > 250) return false
    // Nunca áudio se contém código ou lista
    if (responseText.includes('```') || responseText.includes('\n-')) return false

    // Sempre áudio se alguém mandou áudio (espelha comportamento)
    if (lastMessageWasAudio) return true

    // Chance configurável (default 25%)
    const chance = parseFloat(configs.audio_response_chance || '0.25')
    return Math.random() < chance
}


// ═══════════════════════════════════════════════════════════════════
// 🔊  STT — Transcrição de Áudio (Groq Whisper — gratuito)
// ═══════════════════════════════════════════════════════════════════

async function transcribeAudio(audioBuffer, configs) {
    // Tenta Groq Whisper primeiro (mais rápido, gratuito)
    const groqKey = process.env.GROQ_API_KEY || configs.groq_key || ''
    if (groqKey) {
        try {
            const { FormData, Blob } = await import('node:buffer').catch(() => ({}))
            const formData = new (require('form-data'))()
            formData.append('file', audioBuffer, { filename: 'audio.ogg', contentType: 'audio/ogg' })
            formData.append('model', 'whisper-large-v3-turbo')
            formData.append('language', 'pt')
            formData.append('response_format', 'text')

            const resp = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${groqKey}`, ...formData.getHeaders() },
                body: formData
            })
            if (resp.ok) {
                const text = await resp.text()
                console.log(`[STT] Transcrição Groq: "${text.substring(0, 80)}..."`)
                return text.trim()
            }
        } catch (err) {
            console.error('[STT] Groq falhou, tentando Gemini:', err?.message)
        }
    }

    // Fallback: Gemini (sem custo extra se já tem key)
    if (configs.api_key && configs.ai_provider === 'gemini') {
        try {
            const genAI = new GoogleGenerativeAI(configs.api_key)
            const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' })
            const result = await model.generateContent([
                'Transcreva este áudio em português brasileiro. Retorne APENAS a transcrição, sem comentários.',
                { inlineData: { mimeType: 'audio/ogg', data: audioBuffer.toString('base64') } }
            ])
            return result.response.text().trim()
        } catch (err) {
            console.error('[STT] Gemini falhou:', err?.message)
        }
    }

    return null
}


// ═══════════════════════════════════════════════════════════════════
// 👁️  Visão — Análise de Imagens (Gemini Vision)
// ═══════════════════════════════════════════════════════════════════

async function analyzeImage(imageBuffer, caption, context, configs) {
    if (!configs.api_key) return null
    try {
        const sharp = require('sharp')
        // Redimensiona para economizar tokens
        const resized = await sharp(imageBuffer)
            .resize(1024, 1024, { fit: 'inside', withoutEnlargement: true })
            .jpeg({ quality: 80 })
            .toBuffer()

        const genAI = new GoogleGenerativeAI(configs.api_key)
        const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' })

        const vibe = context?.vibe || 'Neutro'
        const style = context?.communication_style || ''
        const prompt = `Você é um membro deste grupo no WhatsApp. Alguém mandou uma foto${caption ? ` com legenda: "${caption}"` : ' sem legenda'}.

Vibe do grupo: ${vibe}. Estilo/Gírias: ${style || 'neutro'}.

Reaja à foto de forma NATURAL e CURTA — máx 2 frases — como um ser humano responderia no WhatsApp.
- Se for engraçada: faça uma piada ou ria
- Se for bonita: comente genuinamente
- Se for comida: reaja com fome ou elogie
- Se for situação: dê sua opinião
- NUNCA descreva a imagem como se fosse IA analisando
- NUNCA use bullet points ou formatação
- Responda em português brasileiro`

        const result = await model.generateContent([
            prompt,
            { inlineData: { mimeType: 'image/jpeg', data: resized.toString('base64') } }
        ])
        return result.response.text().trim()
    } catch (err) {
        console.error('[VISION] Erro:', err?.message)
        return null
    }
}


// ═══════════════════════════════════════════════════════════════════
// 🧠  MOTOR DE DECISÃO — Devo responder esta mensagem?
// ═══════════════════════════════════════════════════════════════════

async function getRelevanceScore(content, context, configs) {
    if (!content || content.length < 5) return 0
    try {
        const prompt = `Grupo: "${context?.group_type || 'geral'}"
Vibe atual: "${context?.vibe || 'neutro'}"
Assuntos recorrentes: "${context?.recurring_topics || ''}"
Mensagem recebida: "${content.substring(0, 200)}"

Numa escala de 0 a 10, qual a probabilidade de um membro humano ativo deste grupo responder espontaneamente a esta mensagem?
Considere: perguntas abertas = alto, saudações genéricas = baixo, assunto do grupo = alto, mensagem privada entre dois = baixo.
Responda APENAS com um número inteiro.`

        // Usa modelo pequeno/rápido para não gastar tokens do modelo principal
        const fastConfigs = {
            ...configs,
            model: configs.fast_model || (configs.ai_provider === 'groq' ? 'llama-3.1-8b-instant' : configs.model)
        }
        const resp = await getAIResponse(prompt, fastConfigs, 'Você é um classificador. Responda apenas com um número de 0 a 10.')
        const score = parseInt(resp?.trim())
        return isNaN(score) ? 5 : Math.min(10, Math.max(0, score))
    } catch {
        return 5
    }
}

async function shouldRespond(tenantId, remoteJid, content, msgType, context, session, isMentioned, isReplyToMe, containsKeyword, isGroup) {
    const configs = session.aiConfigs || {}

    // Hard YES — sempre responde
    if (!isGroup) return { respond: true, reason: 'dm' }
    if (isMentioned) return { respond: true, reason: 'mentioned' }
    if (isReplyToMe) return { respond: true, reason: 'reply' }
    if (containsKeyword) return { respond: true, reason: 'keyword' }

    // Hard NO
    if (!content && msgType === 'stickerMessage') return { respond: false, reason: 'sticker_only' }
    if (content && content.length < 4) return { respond: false, reason: 'too_short' }

    // Cooldown — não responde se falou há menos de N segundos nesse grupo
    const cooldownMs = parseInt(configs.response_cooldown_ms || '40000')
    const lastTime = lastBotMessageTime.get(`${tenantId}_${remoteJid}`) || 0
    if (Date.now() - lastTime < cooldownMs) return { respond: false, reason: 'cooldown' }

    // Score de relevância
    const score = await getRelevanceScore(content, context, configs)
    const threshold = parseInt(configs.relevance_threshold || '6')
    console.log(`[SCORE] "${content.substring(0, 40)}" → ${score}/${threshold}`)
    return { respond: score >= threshold, reason: 'score', score }
}


// ═══════════════════════════════════════════════════════════════════
// 👤  IDENTIDADE — Resolve JIDs para nomes reais
// ═══════════════════════════════════════════════════════════════════

async function buildPeopleMap(tenantId) {
    try {
        const { data } = await supabase
            .from('whatsapp_contact_profiles')
            .select('contact_id, full_name, nickname, metadata')
            .eq('tenant_id', tenantId)

        const map = {}
        for (const p of data || []) {
            const nicks = p.metadata?.nicknames || []
            map[p.contact_id] = {
                name: nicks[0] || p.nickname || p.full_name || p.contact_id.split('@')[0].split(':')[0],
                nicknames: nicks,
                jid: p.contact_id
            }
        }
        return map
    } catch { return {} }
}

function enrichTranscriptWithNames(messages, peopleMap) {
    return messages.map(m => {
        let text = m.text
        // Substitui @5585999... por @NomeReal
        Object.entries(peopleMap).forEach(([jid, info]) => {
            const number = jid.split('@')[0].split(':')[0]
            text = text.replace(new RegExp(`@${number}`, 'g'), `@${info.name}`)
        })
        const displayName = peopleMap[m.authorJid]?.name || m.author
        return `${displayName}: ${text}`
    }).join('\n')
}


// ═══════════════════════════════════════════════════════════════════
// 🕐  COMPORTAMENTO HUMANO — delays, typing, presença
// ═══════════════════════════════════════════════════════════════════

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

function randomBetween(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min }

function getHumanDelay(textLength) {
    const hour = new Date().getHours()
    // Madrugada: lento (dormindo kk)
    if (hour >= 1 && hour < 7) return randomBetween(6000, 18000)
    // Horário comercial: ágil
    if (hour >= 9 && hour < 18) return randomBetween(600, 2500)
    // Noite/madrugada leve
    return randomBetween(1500, 5000)
}

function getTypingDuration(textLength) {
    // ~180 chars/min no celular + variação humana
    const base = (textLength / 180) * 60000
    const jitter = randomBetween(-800, 1200)
    return Math.min(Math.max(base + jitter, 800), 9000)
}

// Envia mensagem COM comportamento humano
async function humanSend(sock, jid, text, quotedMsg = null, asAudio = false, ttsBuffer = null) {
    try {
        // 1. Marca como lido
        if (quotedMsg?.key) {
            await sock.readMessages([quotedMsg.key]).catch(() => {})
        }

        // 2. Pausa antes de começar a digitar (lê antes de responder)
        await sleep(getHumanDelay(text.length))

        // 3. Inicia "digitando..."
        await sock.sendPresenceUpdate('composing', jid).catch(() => {})

        // 4. Aguarda proporcionalmente ao tamanho da resposta
        await sleep(getTypingDuration(text.length))

        // 5. Para de digitar
        await sock.sendPresenceUpdate('paused', jid).catch(() => {})

        // 6. Envia
        if (asAudio && ttsBuffer) {
            await sock.sendMessage(jid, {
                audio: ttsBuffer,
                mimetype: 'audio/mpeg',
                ptt: true  // mensagem de voz, não arquivo
            }, quotedMsg ? { quoted: quotedMsg } : {})
            console.log(`[SEND] 🎙️ Áudio enviado para ${jid}`)
        } else {
            await sock.sendMessage(jid, { text }, quotedMsg ? { quoted: quotedMsg } : {})
            console.log(`[SEND] 💬 Texto enviado para ${jid}`)
        }
    } catch (err) {
        console.error('[HUMAN SEND] Erro:', err?.message)
        // Fallback sem comportamento humano
        await sock.sendMessage(jid, { text }, quotedMsg ? { quoted: quotedMsg } : {}).catch(() => {})
    }
}

// Reação com emoji
async function sendReaction(sock, msg, vibe) {
    const reactionMap = {
        'Zoeira':    ['😂', '💀', '🔥', '😭', '💯'],
        'Sério':     ['👍', '✅', '💯', '👀'],
        'Discussão': ['😮', '🤔', '👀', '⚠️'],
        'Relaxado':  ['❤️', '😊', '🙌', '✨'],
        'Trabalho':  ['👍', '💪', '✅', '🤝']
    }
    const opts = reactionMap[vibe] || ['👍', '😂', '❤️', '🔥']
    const emoji = opts[Math.floor(Math.random() * opts.length)]
    try {
        await sock.sendMessage(msg.key.remoteJid, {
            react: { text: emoji, key: msg.key }
        })
        console.log(`[REACT] ${emoji} em ${msg.key.remoteJid}`)
    } catch (err) {
        console.error('[REACT] Erro:', err?.message)
    }
}

// Anti-repetição de vocabulário
function extractKeyWords(text) {
    const stopwords = new Set(['para','com','que','uma','por','mais','isso','aqui','voce','essa','nao','sim','mas','pois','como','quando','onde','quem','qual','sem','seu','sua','meu','minha','eles','elas','isso','este','esta','aquele','aquela'])
    return text.toLowerCase()
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z\s]/g, '')
        .split(/\s+/)
        .filter(w => w.length > 4 && !stopwords.has(w))
        .slice(0, 6)
        .join(', ')
}


// ═══════════════════════════════════════════════════════════════════
// 🔌  CONEXÃO WHATSAPP (Multi-Tenant)
// ═══════════════════════════════════════════════════════════════════

async function connectToWhatsApp(tenantId) {
    console.log(`[STEP 1/6] 📡 connectToWhatsApp chamado para Tenant: ${tenantId}`)
    const authPath = path.join(__dirname, `auth_info_baileys/tenant_${tenantId}`)

    console.log(`[STEP 2/6] 📁 authPath = ${authPath} | existe: ${fs.existsSync(authPath)}`)
    if (!fs.existsSync(authPath)) {
        fs.mkdirSync(authPath, { recursive: true })
    }

    console.log(`[STEP 3/6] 🔑 Carregando useMultiFileAuthState...`)
    const { state, saveCreds } = await useMultiFileAuthState(authPath)

    console.log(`[STEP 4/6] 🌐 Buscando versão do Baileys...`)
    const { version } = await getBaileysVersion()

    console.log(`[STEP 5/6] 🔌 Criando socket...`)
    const sock = makeWASocket({
        version,
        auth: state,
        printQRInTerminal: true,
        browser: Browsers.macOS('Desktop'),
        logger: pino({ level: 'warn' }),
        connectTimeoutMs: 60000,
        defaultQueryTimeoutMs: 60000,
        keepAliveIntervalMs: 30000
    })

    const session = { sock, aiConfigs: null, lastQr: null, status: 'connecting' }
    sessions.set(tenantId, session)
    console.log(`[STEP 6/6] ✅ Sessão registrada. Total: ${sessions.size}`)

    await loadTenantAIConfigs(tenantId)

    // ── Connection Update ──
    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update
        console.log(`[CONNECTION] Tenant: ${tenantId} | ${connection} | qr: ${!!qr}`)

        if (qr) {
            session.lastQr = await QRCode.toDataURL(qr)
            session.status = 'qrcode'
            try {
                await supabase.from('whatsapp_sessions').upsert({
                    tenant_id: tenantId, status: 'qrcode', qr: session.lastQr, updated_at: new Date()
                }, { onConflict: 'tenant_id' })
            } catch (_) {}
        }

        if (connection === 'close') {
            const statusCode = (lastDisconnect?.error)?.output?.statusCode
            session.status = 'disconnected'
            session.lastQr = null

            if (statusCode === DisconnectReason.loggedOut) {
                sessions.delete(tenantId)
                try { await supabase.from('whatsapp_sessions').delete().eq('tenant_id', tenantId) } catch (_) {}
                if (fs.existsSync(authPath)) fs.rmSync(authPath, { recursive: true, force: true })
            } else if (statusCode === 428) {
                sessions.delete(tenantId)
                try { await supabase.from('whatsapp_sessions').delete().eq('tenant_id', tenantId) } catch (_) {}
                if (fs.existsSync(authPath)) fs.rmSync(authPath, { recursive: true, force: true })
                setTimeout(() => connectToWhatsApp(tenantId), 2000)
            } else {
                connectToWhatsApp(tenantId)
            }
        } else if (connection === 'open') {
            session.status = 'authenticated'
            session.lastQr = null
            console.log(`✅ Conectado (Tenant: ${tenantId})`)
            try {
                await supabase.from('whatsapp_sessions').upsert({
                    tenant_id: tenantId, status: 'authenticated',
                    phone: sock.user.id, qr: null, updated_at: new Date()
                }, { onConflict: 'tenant_id' })
            } catch (_) {}
        }
    })

    sock.ev.on('creds.update', saveCreds)

    // ══════════════════════════════════════════════════════════════
    // 📩  LISTENER DE MENSAGENS — Versão Humanizada Full
    // ══════════════════════════════════════════════════════════════
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return

        const botNumber = jidDecode(sock.user.id)?.user + '@s.whatsapp.net'
        const botLid = sock.user.lid || ''
        const botId = botNumber.split('@')[0].split(':')[0]
        const botLidShort = botLid.split('@')[0].split(':')[0]

        for (const msg of messages) {
            if (!msg.message || msg.key.fromMe) continue

            const remoteJid = msg.key.remoteJid
            const isGroup = remoteJid.endsWith('@g.us')
            const msgType = Object.keys(msg.message)[0]
            const author = msg.pushName || (msg.key.remoteJid.split('@')[0])
            const authorJid = msg.key.participant || msg.key.remoteJid

            // ── Extração de Conteúdo ──
            let content = ""
            let lastMessageWasAudio = false
            let isMediaMessage = false

            if (msgType === 'conversation') content = msg.message.conversation
            else if (msgType === 'extendedTextMessage') content = msg.message.extendedTextMessage.text
            else if (msgType === 'buttonsResponseMessage') content = msg.message.buttonsResponseMessage.selectedButtonId
            else if (msgType === 'listResponseMessage') content = msg.message.listResponseMessage.singleSelectReply.selectedRowId
            else if (msgType === 'audioMessage' || msgType === 'pttMessage') {
                lastMessageWasAudio = true
                isMediaMessage = true
            } else if (msgType === 'imageMessage') {
                content = msg.message.imageMessage?.caption || ''
                isMediaMessage = true
            } else if (msgType === 'stickerMessage') {
                isMediaMessage = true
            } else if (msg.message[msgType]?.text) content = msg.message[msgType].text
            else if (msg.message[msgType]?.caption) content = msg.message[msgType].caption

            // ── Janela Deslizante (últimas N mensagens) ──
            const windowKey = `${tenantId}_${remoteJid}`
            if (!recentMessages.has(windowKey)) recentMessages.set(windowKey, [])
            const window = recentMessages.get(windowKey)
            if (content || lastMessageWasAudio) {
                window.push({
                    author,
                    authorJid,
                    text: lastMessageWasAudio ? '[áudio]' : content,
                    ts: new Date().toISOString()
                })
                if (window.length > MAX_WINDOW_MESSAGES) window.shift()
            }

            // ── contextInfo e menções ──
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
            const isReplyToMe = !!(contextInfo?.participant?.includes(botId) ||
                (botLidShort && contextInfo?.participant?.includes(botLidShort)))

            const configs = session.aiConfigs || {}
            const keyword = configs.ai_prefix?.trim() || ""
            const normalizeText = (t) => t ? t.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase() : ""
            const containsKeyword = Boolean(keyword && normalizeText(content).includes(normalizeText(keyword)))

            // ── Buffer de Aprendizado ──
            if (content && content.length > 2) {
                const bufferKey = `${tenantId}_${remoteJid}`
                if (!conversationBuffers.has(bufferKey)) conversationBuffers.set(bufferKey, { tenantId, messages: [] })
                const buffer = conversationBuffers.get(bufferKey)
                buffer.messages.push({ author, authorJid, text: content.trim() })

                if (buffer.messages.length >= MAX_BUFFER_MESSAGES) {
                    const toAnalyze = [...buffer.messages]
                    buffer.messages = []
                    learnFromConversation(tenantId, remoteJid, toAnalyze, session.aiConfigs).catch(err =>
                        console.error(`[BG LEARN] Erro:`, err?.message))
                }
            }

            const isBotEnabled = String(session.aiConfigs?.ai_bot_enabled) === 'true'
            if (!isBotEnabled) continue

            // ── Sticker: reação emoji com chance ──
            if (msgType === 'stickerMessage') {
                if (Math.random() < 0.35) {
                    let convCtx = null
                    try {
                        const { data } = await supabase.from('whatsapp_conversation_contexts')
                            .select('vibe').eq('tenant_id', tenantId).eq('conversation_id', remoteJid).single()
                        convCtx = data
                    } catch (_) {}
                    await sendReaction(sock, msg, convCtx?.vibe || 'Relaxado')
                }
                continue
            }

            // ── Busca contexto da conversa ──
            let convData = null
            try {
                const { data } = await supabase.from('whatsapp_conversation_contexts')
                    .select('summary, vibe, group_type, daily_topics, communication_style, recurring_topics, bot_style_notes, last_bot_words, people_map')
                    .eq('tenant_id', tenantId).eq('conversation_id', remoteJid).single()
                convData = data
            } catch (_) {}

            // ── Motor de Decisão ──
            const decision = await shouldRespond(
                tenantId, remoteJid, content, msgType, convData,
                session, isMentioned, isReplyToMe, containsKeyword, isGroup
            )

            // Reação passiva com emoji (mesmo sem responder, às vezes reage)
            if (!decision.respond && isGroup && Math.random() < 0.08 && content.length > 10) {
                await sendReaction(sock, msg, convData?.vibe || 'Relaxado')
                continue
            }

            if (!decision.respond) continue

            console.log(`🤖 IA (Tenant ${tenantId}): Respondendo — motivo: ${decision.reason}`)

            // ── Processa Mídia ──
            let mediaContext = ""
            let transcribedAudio = null

            if (msgType === 'audioMessage' || msgType === 'pttMessage') {
                try {
                    const audioBuffer = await downloadMediaMessage(msg, 'buffer', {})
                    transcribedAudio = await transcribeAudio(audioBuffer, configs)
                    if (transcribedAudio) {
                        mediaContext = `[ÁUDIO TRANSCRITO DE ${author}]: "${transcribedAudio}"`
                        content = transcribedAudio
                        console.log(`[STT] ✅ Transcrito: "${transcribedAudio.substring(0, 60)}"`)
                    } else {
                        await humanSend(sock, remoteJid, "não consegui ouvir direito não 😅", msg)
                        continue
                    }
                } catch (err) {
                    console.error('[MEDIA] Erro no áudio:', err?.message)
                    continue
                }
            }

            if (msgType === 'imageMessage') {
                try {
                    const imageBuffer = await downloadMediaMessage(msg, 'buffer', {})
                    const imageResponse = await analyzeImage(imageBuffer, content, convData, configs)
                    if (imageResponse) {
                        lastBotMessageTime.set(`${tenantId}_${remoteJid}`, Date.now())
                        const useAudio = shouldSendAudio(imageResponse, convData, configs, false)
                        if (useAudio) {
                            const ttsBuffer = await textToSpeech(imageResponse)
                            await humanSend(sock, remoteJid, imageResponse, msg, true, ttsBuffer)
                        } else {
                            await humanSend(sock, remoteJid, imageResponse, msg)
                        }
                        continue
                    }
                } catch (err) {
                    console.error('[MEDIA] Erro na imagem:', err?.message)
                }
            }

            // ── Limpa menções e keyword do texto ──
            let cleanText = content.replace(new RegExp(`@${botId}`, 'g'), '').trim()
            if (botLidShort) cleanText = cleanText.replace(new RegExp(`@${botLidShort}`, 'g'), '').trim()
            if (containsKeyword && keyword) {
                const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
                cleanText = cleanText.replace(new RegExp(escaped, 'gi'), '').trim()
            }

            // ── Monta Contexto Completo ──
            const peopleMap = await buildPeopleMap(tenantId)
            const windowMessages = recentMessages.get(windowKey) || []
            const conversationThread = windowMessages
                .slice(-10)
                .map(m => {
                    const displayName = peopleMap[m.authorJid]?.name || m.author
                    return `${displayName}: ${m.text}`
                })
                .join('\n')

            // Perfil de quem está falando
            let senderProfile = ""
            try {
                const senderJid = msg.key.participant || msg.key.remoteJid
                const { data: profData } = await supabase.from('whatsapp_contact_profiles')
                    .select('full_name, nickname, personality_traits, communication_style, metadata')
                    .eq('tenant_id', tenantId).eq('contact_id', senderJid).single()

                if (profData) {
                    const nicks = profData.metadata?.nicknames || []
                    senderProfile = `\n[QUEM ESTÁ FALANDO: ${profData.full_name || author}${nicks.length ? `, apelidos: ${nicks.join(', ')}` : ''}, personalidade: ${profData.personality_traits || 'desconhecida'}, estilo: ${profData.communication_style || 'neutro'}]`
                }
            } catch (_) {}

            // Pessoas conhecidas no grupo
            const knownPeople = Object.values(peopleMap)
                .slice(0, 10)
                .map(p => `${p.name}${p.nicknames.length ? ` (também chamado de ${p.nicknames.join('/')})` : ''}`)
                .join(', ')

            // Palavras que já usou (anti-repetição)
            const lastWords = convData?.last_bot_words || ''

            const systemPrompt = configs.system_prompt || "Você é um membro deste grupo no WhatsApp."

            // ── PROMPT PRINCIPAL HUMANIZADO ──
            const humanSystemPrompt = `${systemPrompt}

REGRAS DE COMPORTAMENTO HUMANO (SIGA À RISCA):
- Responda de forma CURTA e natural — máx 2-3 frases, salvo se perguntarem algo complexo
- NUNCA use bullet points, listas, numerações ou formatação markdown
- NUNCA comece com o nome de quem perguntou ("Oi João,...")
- NUNCA diga que é uma IA, assistente ou robô
- NUNCA repita estas palavras/expressões que você acabou de usar: ${lastWords || 'nenhuma ainda'}
- Use gírias do grupo com MODERAÇÃO — não force, deixe fluir naturalmente
- Às vezes faça uma pergunta de volta para manter a conversa
- Reaja emocionalmente quando for natural (surpresa, concordância, discordância, humor)
- Se não souber algo, diga casualmente ("não sei não", "aí me pegou")
- Responda sempre em português brasileiro informal

PESSOAS DESTE GRUPO QUE VOCÊ CONHECE:
${knownPeople || 'ainda aprendendo os nomes'}
${senderProfile}

CONTEXTO E VIBE:
${convData?.summary ? `Histórico: ${convData.summary}` : ''}
${convData?.vibe ? `Vibe atual: ${convData.vibe}` : ''}
${convData?.group_type ? `Tipo de grupo: ${convData.group_type}` : ''}
${convData?.communication_style ? `Estilo/Gírias do grupo: ${convData.communication_style}` : ''}
${convData?.bot_style_notes ? `Como se comunicar aqui: ${convData.bot_style_notes}` : ''}
${convData?.recurring_topics ? `Assuntos recorrentes: ${convData.recurring_topics}` : ''}

ÚLTIMAS MENSAGENS DA CONVERSA:
${conversationThread || '(início da conversa)'}
${mediaContext ? `\n${mediaContext}` : ''}`

            let fullPrompt
            if (tenantId === ADMIN_TENANT_ID) {
                fullPrompt = `PERGUNTA/MENSAGEM: ${cleanText || "Oi!"}`
            } else {
                const businessContext = await getTenantContext(tenantId)
                fullPrompt = `CONTEXTO DA EMPRESA:\n${businessContext}\n\nPERGUNTA/MENSAGEM: ${cleanText || "Oi!"}`
            }

            // ── Chama IA ──
            try {
                const response = await getAIResponse(fullPrompt, configs, humanSystemPrompt)

                if (response) {
                    // Atualiza cooldown e palavras usadas
                    lastBotMessageTime.set(`${tenantId}_${remoteJid}`, Date.now())
                    const usedWords = extractKeyWords(response)
                    supabase.from('whatsapp_conversation_contexts')
                        .update({ last_bot_words: usedWords })
                        .eq('tenant_id', tenantId).eq('conversation_id', remoteJid)
                        .then(() => {}).catch(() => {})

                    // Decide áudio ou texto
                    const useAudio = shouldSendAudio(response, convData, configs, lastMessageWasAudio)

                    if (useAudio) {
                        const ttsBuffer = await textToSpeech(response)
                        if (ttsBuffer) {
                            await humanSend(sock, remoteJid, response, msg, true, ttsBuffer)
                        } else {
                            // TTS falhou, envia texto mesmo
                            await humanSend(sock, remoteJid, response, msg)
                        }
                    } else {
                        await humanSend(sock, remoteJid, response, msg)
                    }
                } else {
                    await humanSend(sock, remoteJid, "eita, deu ruim aqui 😅", msg)
                }
            } catch (err) {
                console.error(`Erro IA (Tenant ${tenantId}):`, err)
                await sock.sendMessage(remoteJid, { text: "eita, deu ruim aqui 😅" }, { quoted: msg }).catch(() => {})
            }
        }
    })
}


// ═══════════════════════════════════════════════════════════════════
// 🧠  APRENDIZADO — Dinâmica Social Avançada
// ═══════════════════════════════════════════════════════════════════

async function learnFromConversation(tenantId, conversationId, newMessages, aiConfigs) {
    if (!aiConfigs || !aiConfigs.api_key) return
    console.log(`[LEARN] 🧠 Analisando dinâmica em ${conversationId}...`)

    try {
        const { data: currentContext } = await supabase.from('whatsapp_conversation_contexts')
            .select('*').eq('tenant_id', tenantId).eq('conversation_id', conversationId).single()

        const oldSummary = currentContext?.summary || "Sem histórico."
        const oldMsgCount = currentContext?.message_count || 0

        // Resolve JIDs para nomes antes de analisar
        const peopleMap = await buildPeopleMap(tenantId)
        const enrichedTranscript = enrichTranscriptWithNames(newMessages, peopleMap)

        const prompt = `Você é um Sociolinguista analisando a dinâmica de um grupo de WhatsApp.

RESUMO ANTERIOR: "${oldSummary}"

TRANSCRIPT RECENTE (nomes já resolvidos):
${enrichedTranscript}

Retorne APENAS um JSON puro (sem markdown, sem backticks) com:
{
  "summary": "resumo conciso unindo contexto anterior + novas falas (máx 4 frases)",
  "vibe": "um dos: Zoeira | Sério | Trabalho | Família | Discussão | Relaxado | Misto",
  "group_type": "categoria: Amigos | Trabalho | Família | Negócios | Comunidade | Outro",
  "daily_topics": "principais assuntos discutidos agora em poucas palavras",
  "recurring_topics": "assuntos que aparecem FREQUENTEMENTE neste grupo",
  "communication_style": "gírias, expressões regionais e termos mais usados (ex: 'macho', 'oxe', 'mano')",
  "bot_style_notes": "instrução curta de como o bot deve se comunicar NESTE grupo especificamente",
  "people_updates": [
    {
      "jid": "jid completo da pessoa",
      "confirmed_name": "nome mais usado pelo grupo para esta pessoa",
      "nicknames": ["apelido1", "apelido2"],
      "personality_traits": "como esta pessoa se comunica",
      "communication_style": "gírias e expressões específicas desta pessoa"
    }
  ],
  "proactive_thought": "comentário espontâneo SE algo for muito engraçado ou relevante — vazio na maioria das vezes"
}`

        const aiResponse = await getAIResponse(prompt, aiConfigs, "Você é um analista de comportamento social. Responda apenas com JSON puro.")

        if (aiResponse) {
            const cleanJson = aiResponse.replace(/```json|```/g, '').trim()
            const result = JSON.parse(cleanJson)

            // Salva contexto atualizado
            await supabase.from('whatsapp_conversation_contexts').upsert({
                tenant_id: tenantId,
                conversation_id: conversationId,
                summary: result.summary || oldSummary,
                vibe: result.vibe || "Neutro",
                group_type: result.group_type || "Geral",
                daily_topics: result.daily_topics || "",
                recurring_topics: result.recurring_topics || currentContext?.recurring_topics || "",
                communication_style: result.communication_style || "",
                bot_style_notes: result.bot_style_notes || "",
                message_count: oldMsgCount + newMessages.length,
                updated_at: new Date()
            }, { onConflict: 'tenant_id, conversation_id' })

            // Atualiza perfis de pessoas
            if (result.people_updates) {
                for (const p of result.people_updates) {
                    if (!p.jid) continue
                    const { data: existing } = await supabase.from('whatsapp_contact_profiles')
                        .select('metadata').eq('tenant_id', tenantId).eq('contact_id', p.jid).single()

                    let meta = existing?.metadata || {}
                    if (!meta.nicknames) meta.nicknames = []
                    if (p.nicknames) {
                        p.nicknames.forEach(n => { if (n && !meta.nicknames.includes(n)) meta.nicknames.push(n) })
                    }

                    await supabase.from('whatsapp_contact_profiles').upsert({
                        tenant_id: tenantId,
                        contact_id: p.jid,
                        full_name: p.confirmed_name || null,
                        nickname: meta.nicknames[0] || null,
                        personality_traits: p.personality_traits || null,
                        communication_style: p.communication_style || null,
                        metadata: meta,
                        updated_at: new Date()
                    }, { onConflict: 'tenant_id, contact_id' })
                }
            }

            // Intervenção proativa (rara, máx 5% das vezes)
            const proactiveChance = currentContext?.proactive_frequency || 0.05
            if (result.proactive_thought && result.proactive_thought.length > 5 && Math.random() < proactiveChance) {
                console.log(`[PROACTIVE] 🤖 Pitaco: "${result.proactive_thought}"`)
                const session = sessions.get(tenantId)
                if (session?.sock && session.status === 'authenticated') {
                    setTimeout(async () => {
                        // Re-verifica a sessão dentro do timeout
                        const s = sessions.get(tenantId)
                        if (!s?.sock || s.status !== 'authenticated') return
                        try {
                            const ttsBuffer = await textToSpeech(result.proactive_thought)
                            if (ttsBuffer) {
                                await s.sock.sendMessage(conversationId, {
                                    audio: ttsBuffer, mimetype: 'audio/mpeg', ptt: true
                                })
                            } else {
                                await s.sock.sendMessage(conversationId, { text: result.proactive_thought })
                            }
                        } catch (e) { console.error('[PROACTIVE] Erro:', e?.message) }
                    }, randomBetween(5000, 15000))
                }
            }

            console.log(`[LEARN] ✅ Contexto atualizado para ${conversationId}`)
        }
    } catch (err) {
        console.error(`[LEARN] ❌ Erro:`, err?.message)
    }
}


// ═══════════════════════════════════════════════════════════════════
// ⚙️  CONFIGS E CONTEXTO DE TENANT
// ═══════════════════════════════════════════════════════════════════

async function loadTenantAIConfigs(tenantId) {
    try {
        let configData = {}
        const isAdmin = tenantId === ADMIN_TENANT_ID

        if (isAdmin) {
            const { data, error } = await supabase.from('ai_configs').select('*')
            const configs = {}
            if (!error && data) data.forEach(item => configs[item.key] = item.value)

            const provider = configs.ai_provider || 'gemini'
            configData = {
                ai_provider: provider,
                api_key: configs[`${provider}_api_key`] || process.env.GEMINI_API_KEY || '',
                model: configs[`${provider}_model`] || 'gemini-1.5-flash',
                system_prompt: configs[`${provider}_system_prompt`] || 'Você é a RED, membro ativa deste grupo.',
                ai_prefix: configs.ai_prefix || '',
                ai_bot_enabled: configs.ai_bot_enabled === 'true',
                audio_response_chance: configs.audio_response_chance || '0.25',
                relevance_threshold: configs.relevance_threshold || '6',
                response_cooldown_ms: configs.response_cooldown_ms || '40000'
            }
        } else {
            const { data: tenantDataArray, error } = await supabase.from('whatsapp_tenant_configs')
                .select('*').eq('tenant_id', tenantId).limit(1)
            if (error) throw error
            const data = tenantDataArray?.[0] || null

            configData = {
                ai_provider: data?.ai_provider || 'gemini',
                api_key: data?.api_key || '',
                model: data?.model || '',
                system_prompt: data?.system_prompt || 'Você é um assistente virtual.',
                ai_prefix: data?.ai_prefix || '',
                ai_bot_enabled: data?.ai_enabled === true,
                audio_response_chance: data?.audio_response_chance || '0.25',
                relevance_threshold: data?.relevance_threshold || '6',
                response_cooldown_ms: data?.response_cooldown_ms || '40000',
                groq_key: data?.groq_key || process.env.GROQ_API_KEY || ''
            }
        }

        const session = sessions.get(tenantId)
        if (session) {
            session.aiConfigs = configData
            console.log(`✅ Configs carregadas para Tenant ${tenantId} — Provider: ${configData.ai_provider}`)
        }
    } catch (err) {
        console.error(`Erro ao carregar configs (Tenant ${tenantId}):`, err?.message)
        const session = sessions.get(tenantId)
        if (session) {
            session.aiConfigs = {
                ai_provider: 'gemini',
                api_key: process.env.GEMINI_API_KEY || '',
                model: 'gemini-1.5-flash',
                system_prompt: 'Você é um assistente virtual.',
                ai_prefix: '',
                ai_bot_enabled: false
            }
        }
    }
}

async function getTenantContext(tenantId) {
    if (tenantId === ADMIN_TENANT_ID) return ""
    try {
        const { data: tenant } = await supabase.from('tenants')
            .select('nome, descricao, tipo, endereco, cidade').eq('id', tenantId).single()

        const { data: products } = await supabase.from('products')
            .select('nome, preco, estoque_atual').eq('tenant_id', tenantId).limit(20)

        let context = `Nome: ${tenant?.nome || 'Empresa'}\nRamo: ${tenant?.tipo || 'Comércio'}\nDescrição: ${tenant?.descricao || ''}\nEndereço: ${tenant?.endereco || ''}, ${tenant?.cidade || ''}\n`

        if (products?.length) {
            context += `\nPRODUTOS/SERVIÇOS:\n`
            products.forEach(p => {
                context += `- ${p.nome}: R$ ${p.preco ? p.preco.toFixed(2) : 'Sob consulta'} (Estoque: ${p.estoque_atual || 'Sob consulta'})\n`
            })
        }
        return context
    } catch (err) {
        console.error(`Erro contexto Tenant ${tenantId}:`, err)
        return ""
    }
}


// ═══════════════════════════════════════════════════════════════════
// 🤖  GET AI RESPONSE
// ═══════════════════════════════════════════════════════════════════

async function getAIResponse(text, configs, overrideSystemPrompt = null) {
    const provider = configs.ai_provider || 'gemini'
    const systemPrompt = overrideSystemPrompt || configs.system_prompt || "Você é um assistente virtual."

    try {
        if (!configs.api_key || !configs.model) {
            console.warn(`IA: Key/Modelo não configurado para ${provider}`)
            return "eita, não tô configurada direito não 😅"
        }

        if (provider === 'gemini') {
            const genAI = new GoogleGenerativeAI(configs.api_key)
            const model = genAI.getGenerativeModel({
                model: configs.model,
                systemInstruction: systemPrompt
            })
            const result = await model.generateContent(text)
            return result.response.text()
        }

        const urlMap = {
            groq: 'https://api.groq.com/openai/v1/chat/completions',
            openrouter: 'https://openrouter.ai/api/v1/chat/completions',
            nvidia: 'https://integrate.api.nvidia.com/v1/chat/completions',
            ollama: `${process.env.OLLAMA_PROXY_URL || 'http://automais.ddns.net:11434'}/v1/chat/completions`,
            mistral: 'https://api.mistral.ai/v1/chat/completions',
            cerebras: 'https://api.cerebras.ai/v1/chat/completions',
        }

        const apiUrl = urlMap[provider]
        if (!apiUrl) return "Provedor desconhecido."

        const response = await fetch(apiUrl, {
            method: 'POST',
            headers: {
                ...(provider !== 'ollama' ? { 'Authorization': `Bearer ${configs.api_key}` } : {}),
                'Content-Type': 'application/json',
                'HTTP-Referer': 'https://redcomercial.com.br',
                'X-Title': 'Red Comercial AI'
            },
            body: JSON.stringify({
                model: configs.model,
                messages: [
                    { role: "system", content: systemPrompt },
                    { role: "user", content: text }
                ],
                max_tokens: 512
            })
        })

        const data = await response.json()
        if (data.error) {
            console.error(`Erro API ${provider}:`, data.error)
            return null
        }
        return data.choices?.[0]?.message?.content || null

    } catch (err) {
        console.error(`Erro IA (${provider}):`, err)
        return null
    }
}


// ═══════════════════════════════════════════════════════════════════
// 🌐  ENDPOINTS DA API
// ═══════════════════════════════════════════════════════════════════

app.get('/status', (req, res) => res.redirect('/status/admin'))
app.post('/start', (req, res) => res.redirect(307, '/start/admin'))
app.post('/stop', (req, res) => res.redirect(307, '/stop/admin'))
app.get('/groups', (req, res) => res.redirect('/groups/admin'))
app.post('/send', (req, res) => res.redirect(307, '/send/admin'))
app.post('/ai/reload', async (req, res) => {
    await loadTenantAIConfigs(ADMIN_TENANT_ID)
    res.json({ success: true, message: 'Configs do Admin recarregadas.' })
})

app.get('/status/:tenantId', (req, res) => {
    const session = sessions.get(req.params.tenantId)
    if (!session) return res.json({ status: 'disconnected', qr: null })
    res.json({ status: session.status, qr: session.lastQr })
})

app.post('/start/:tenantId', async (req, res) => {
    try {
        const { tenantId } = req.params
        const existing = sessions.get(tenantId)
        if (existing && existing.status !== 'disconnected' && existing.status !== 'error') {
            return res.json({ success: true, message: 'Sessão já ativa.', status: existing.status })
        }
        res.json({ success: true, message: 'Iniciando...', status: 'connecting' })
        connectToWhatsApp(tenantId).catch(err => console.error(`[BG CONN] Falha para ${tenantId}:`, err))
    } catch (err) {
        if (!res.headersSent) res.status(500).json({ success: false, error: err.message })
    }
})

app.post('/stop/:tenantId', async (req, res) => {
    const { tenantId } = req.params
    const session = sessions.get(tenantId)
    const authPath = path.join(__dirname, `auth_info_baileys/tenant_${tenantId}`)

    if (session?.sock) {
        try {
            await session.sock.logout()
            res.json({ success: true, message: 'Desconectado.' })
        } catch (e) {
            sessions.delete(tenantId)
            if (fs.existsSync(authPath)) fs.rmSync(authPath, { recursive: true, force: true })
            res.json({ success: true, message: 'Limpo após erro.' })
        }
    } else {
        if (fs.existsSync(authPath)) fs.rmSync(authPath, { recursive: true, force: true })
        res.json({ success: true, message: 'Nenhuma sessão ativa.' })
    }
})

app.post('/ai/reload/:tenantId', async (req, res) => {
    await loadTenantAIConfigs(req.params.tenantId)
    res.json({ success: true })
})

app.post('/ai/list-models', async (req, res) => {
    const { api_key, provider } = req.body
    if (!api_key || !provider) return res.status(400).json({ error: 'API Key e Provedor necessários' })

    try {
        const urlMap = {
            groq: 'https://api.groq.com/openai/v1/models',
            openrouter: 'https://openrouter.ai/api/v1/models',
            nvidia: 'https://integrate.api.nvidia.com/v1/models'
        }

        if (provider === 'gemini') {
            const resp = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${api_key}`)
            const data = await resp.json()
            const models = data.models
                .filter(m => m.supportedGenerationMethods?.includes('generateContent'))
                .map(m => ({ id: m.name.replace('models/', ''), name: m.displayName }))
            return res.json({ success: true, models })
        }

        if (provider === 'ollama') {
            const ollamaUrl = process.env.OLLAMA_PROXY_URL || 'http://automais.ddns.net:11434'
            const ollamaRes = await fetch(`${ollamaUrl}/api/tags`)
            const ollamaData = await ollamaRes.json()
            const models = (ollamaData.models || []).map(m => ({ id: m.name, name: m.name }))
            return res.json({ success: true, models })
        }

        const apiUrl = urlMap[provider]
        if (!apiUrl) return res.status(400).json({ error: 'Provedor inválido.' })

        const response = await fetch(apiUrl, { headers: { 'Authorization': `Bearer ${api_key}` } })
        const data = await response.json()
        if (data.error) throw new Error(data.error.message)
        const models = (data.data || []).map(m => ({ id: m.id, name: m.id }))
        res.json({ success: true, models })
    } catch (err) {
        res.status(500).json({ error: err.message })
    }
})

app.get('/groups/:tenantId', async (req, res) => {
    const session = sessions.get(req.params.tenantId)
    if (!session || session.status !== 'authenticated')
        return res.status(503).json({ success: false, error: 'WhatsApp não conectado' })

    try {
        const groupMetadata = await session.sock.groupFetchAllParticipating()
        const groups = Object.values(groupMetadata).map(g => ({ id: g.id, subject: g.subject }))
        res.json({ success: true, groups })
    } catch (err) {
        res.status(500).json({ success: false, error: 'Erro ao buscar grupos.' })
    }
})

app.post('/send/:tenantId', async (req, res) => {
    const session = sessions.get(req.params.tenantId)
    if (!session || session.status !== 'authenticated')
        return res.status(503).json({ success: false, error: 'WhatsApp não conectado' })

    try {
        const { number, message } = req.body
        if (!number || !message) return res.status(400).json({ error: 'Número e mensagem obrigatórios' })

        let jid = number
        if (!jid.includes('@')) {
            jid = (jid.includes('-') || jid.length > 15) ? `${jid}@g.us` : `${jid}@s.whatsapp.net`
        }

        await session.sock.sendMessage(jid, { text: message })
        res.json({ success: true })
    } catch (err) {
        res.status(500).json({ error: err.message })
    }
})

const PORT = process.env.WHATSAPP_PORT || 3001
app.listen(PORT, () => console.log(`🚀 RED I.A WhatsApp Service rodando na porta ${PORT}`))
