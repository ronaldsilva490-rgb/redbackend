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

// ── UUID fixo do Admin (tratado como tenant real em todo o código) ──
const ADMIN_TENANT_ID = process.env.ADMIN_TENANT_ID || 'admin'

// ── Gerenciador de Sessões (Multi-Tenant) ──
const sessions = new Map()

// ── Memória Contínua em RAM (Rolling Summary & Learning) ──
// Map: conversation_id -> { tenantId, messages: [ { author, authorJid, text } ] }
const conversationBuffers = new Map()
const MAX_BUFFER_MESSAGES = 5 

// ── Cache de Versão do Baileys para Estabilidade ──
let cachedBaileysVersion = null
let fetchVersionPromise = null

async function getBaileysVersion() {
    if (cachedBaileysVersion) return cachedBaileysVersion
    if (fetchVersionPromise) return fetchVersionPromise
    
    fetchVersionPromise = fetchLatestBaileysVersion().then(v => {
        cachedBaileysVersion = v
        return v
    }).catch(err => {
        console.error(`[CACHE VERSION] Erro ao buscar versão, usando default:`, err.message)
        return { version: [2, 3000, 1015901307], isLatest: true }
    })
    return fetchVersionPromise
}

// ── Prevenção de crash silencioso do processo Node ──
process.on('uncaughtException', (err) => {
    console.error('❌ [CRITICAL] Uncaught Exception:', err?.message || err)
})
process.on('unhandledRejection', (reason) => {
    console.error('❌ [CRITICAL] Unhandled Rejection:', reason?.message || reason)
})

// ── Funções de Conexão WhatsApp (Multi-Tenant) ──
async function connectToWhatsApp(tenantId) {
    console.log(`[STEP 1/6] 📡 connectToWhatsApp chamado para Tenant: ${tenantId}`)
    const authPath = path.join(__dirname, `auth_info_baileys/tenant_${tenantId}`)

    console.log(`[STEP 2/6] 📁 authPath = ${authPath} | existe: ${fs.existsSync(authPath)}`)
    if (!fs.existsSync(authPath)) {
        fs.mkdirSync(authPath, { recursive: true })
        console.log(`[STEP 2/6] ✅ Diretório criado.`)
    }

    console.log(`[STEP 3/6] 🔑 Carregando useMultiFileAuthState...`)
    const { state, saveCreds } = await useMultiFileAuthState(authPath)
    console.log(`[STEP 3/6] ✅ Auth state carregado. Registrado: ${!!state?.creds?.registered}`)

    console.log(`[STEP 4/6] 🌐 Buscando versão do Baileys (Cacheable)...`)
    const { version } = await getBaileysVersion()
    console.log(`[STEP 4/6] ✅ Versão: ${version.join('.')}`)

    console.log(`[STEP 5/6] 🔌 Criando socket makeWASocket...`)
    const sock = makeWASocket({
        version,
        auth: state,
        printQRInTerminal: true, 
        browser: Browsers.macOS('Desktop'),
        logger: pino({ level: 'warn' }),
        connectTimeoutMs: 60000, // Aumentado para 60s
        defaultQueryTimeoutMs: 60000,
        keepAliveIntervalMs: 30000
    })
    console.log(`[STEP 5/6] ✅ Socket criado.`)

    const session = { sock, aiConfigs: null, lastQr: null, status: 'connecting' }
    sessions.set(tenantId, session)
    console.log(`[STEP 6/6] ✅ Sessão registrada no Map. Total de sessões ativas: ${sessions.size}`)

    // Carrega configs de IA do Tenant
    await loadTenantAIConfigs(tenantId)

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update
        console.log(`[CONNECTION.UPDATE] Tenant: ${tenantId} | connection: ${connection} | qr: ${!!qr} | statusCode: ${(lastDisconnect?.error)?.output?.statusCode}`)

        if (qr) {
            console.log(`[QR] Gerando base64 do QR para Tenant: ${tenantId}...`)
            session.lastQr = await QRCode.toDataURL(qr)
            session.status = 'qrcode'
            console.log(`[QR] ✅ QR Code gerado com sucesso para Tenant: ${tenantId}`)
            try {
                await supabase.from('whatsapp_sessions').upsert({
                    tenant_id: tenantId,
                    status: 'qrcode',
                    qr: session.lastQr,
                    updated_at: new Date()
                }, { onConflict: 'tenant_id' })
            } catch (_) { } // silencia erros de FK para tenants não cadastrados
        }

        if (connection === 'close') {
            const statusCode = (lastDisconnect?.error)?.output?.statusCode
            console.log(`❌ Conexão Fechada (Tenant: ${tenantId}). Status Code: ${statusCode}`)
            session.status = 'disconnected'
            session.lastQr = null

            if (statusCode === DisconnectReason.loggedOut) {
                console.log(`🚫 Tenant ${tenantId} deslogado. Limpando...`)
                sessions.delete(tenantId)
                try { await supabase.from('whatsapp_sessions').delete().eq('tenant_id', tenantId) } catch (_) { }
                if (fs.existsSync(authPath)) fs.rmSync(authPath, { recursive: true, force: true })

            } else if (statusCode === 428) {
                console.log(`⚠️ Tenant ${tenantId}: auth corrompida (428). Reiniciando fresh...`)
                sessions.delete(tenantId)
                try { await supabase.from('whatsapp_sessions').delete().eq('tenant_id', tenantId) } catch (_) { }
                if (fs.existsSync(authPath)) fs.rmSync(authPath, { recursive: true, force: true })
                setTimeout(() => connectToWhatsApp(tenantId), 2000)

            } else {
                console.log(`🔄 Reconectando Tenant ${tenantId}...`)
                connectToWhatsApp(tenantId)
            }
        } else if (connection === 'open') {
            console.log(`✅ Conexão Aberta (Tenant: ${tenantId})`)
            session.status = 'authenticated'
            session.lastQr = null
            try {
                await supabase.from('whatsapp_sessions').upsert({
                    tenant_id: tenantId,
                    status: 'authenticated',
                    phone: sock.user.id,
                    qr: null,
                    updated_at: new Date()
                }, { onConflict: 'tenant_id' })
            } catch (_) { } // silencia erros de FK para tenants não cadastrados
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
            const configs = session.aiConfigs || {}
            const keyword = configs.ai_prefix?.trim() || ""
            const normalizeText = (text) => text ? text.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase() : ""
            const normContent = normalizeText(content)
            const normKeyword = normalizeText(keyword)
            const containsKeyword = Boolean(normKeyword && normContent.includes(normKeyword))

            // Log de diagnóstico para o problema da "primeira chamada"
            if (isGroup || containsKeyword) {
                console.log(`[CHECK] Tenant: ${tenantId} | Bot Ativo: ${configs.ai_bot_enabled} | Keyword: "${keyword}" | Encontrou: ${containsKeyword}`)
            }

            // ───────────────── SISTEMA DE APRENDIZADO (Rolling Summary & Profiling) ─────────────────
            const author = msg.pushName || (msg.key.remoteJid.split('@')[0])
            const authorJid = msg.key.participant || msg.key.remoteJid // JID real de quem enviou
            
            if (content) {
                const bufferKey = `${tenantId}_${remoteJid}`
                if (!conversationBuffers.has(bufferKey)) {
                    conversationBuffers.set(bufferKey, { tenantId, messages: [] })
                }
                const buffer = conversationBuffers.get(bufferKey)
                
                // Salva no buffer (PRESERVANDO MENÇÕES para a IA correlacionar tags)
                let textForBuffer = content.trim() 
                if (textForBuffer.length > 2) {
                    buffer.messages.push({ author, authorJid, text: textForBuffer })
                    console.log(`[LEARN BUFFER] Mensagem de ${author} (${authorJid}) adicionada para ${remoteJid} (${buffer.messages.length}/${MAX_BUFFER_MESSAGES})`)
                }

                // Gatilho: Se atingiu o limite, dispara aprendizado em background
                if (buffer.messages.length >= MAX_BUFFER_MESSAGES) {
                    console.log(`[LEARN] 🚀 Limite atingido para ${remoteJid}. Analisando conversa...`)
                    const messagesToAnalyze = [...buffer.messages]
                    buffer.messages = [] 
                    learnFromConversation(tenantId, remoteJid, messagesToAnalyze, session.aiConfigs).catch(err => {
                        console.error(`[BG LEARN] Erro ao aprender com a conversa ${remoteJid}:`, err?.message)
                    })
                }
            }
            // ─────────────────────────────────────────────────────────────────────────

            if (isGroup) {
                console.log(`📩 [DEBUG GRUPO - Tenant ${tenantId}] text: "${content.substring(0, 30)}..."`)
                console.log(`   - isMentioned: ${isMentioned}, isReplyToMe: ${isReplyToMe}, containsKeyword: ${containsKeyword}, keywordSetada: "${keyword}"`)
            }

            // Responde se: Ativo + (PV ou Menção ou Resposta ou Keyword)
            const isBotEnabled = String(session.aiConfigs?.ai_bot_enabled) === 'true'
            if (isBotEnabled && (!isGroup || isMentioned || isReplyToMe || containsKeyword)) {
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

                // Busca Memória e Perfis (RAG Evoluído)
                let conversationMemory = ""
                let senderProfile = ""
                let currentVibe = "Séria" // Default
                
                try {
                    // 1. Busca resumo, vibe, tipo de grupo e tópicos do dia
                    const { data: convData } = await supabase.from('whatsapp_conversation_contexts')
                        .select('summary, vibe, group_type, daily_topics, communication_style')
                        .eq('tenant_id', tenantId).eq('conversation_id', remoteJid).single()
                    
                    if (convData?.summary) {
                        conversationMemory = `\n\n[CONTEXTO DA CONVERSA: ${convData.summary}]`
                        if (convData.group_type) conversationMemory += `\n[TIPO DE GRUPO: ${convData.group_type}]`
                        if (convData.daily_topics) conversationMemory += `\n[ASSUNTOS DO DIA: ${convData.daily_topics}]`
                        if (convData.communication_style) conversationMemory += `\n[ESTILO/GÍRIAS DO GRUPO: ${convData.communication_style}]`
                    }
                    if (convData?.vibe) {
                        currentVibe = convData.vibe
                        console.log(`[RAG] 📈 Vibe: "${currentVibe}" | Estilo: "${convData.communication_style}"`)
                    }

                    // 2. Busca perfil de quem está falando agora
                    const senderJid = msg.key.participant || msg.key.remoteJid
                    const { data: profData } = await supabase.from('whatsapp_contact_profiles')
                        .select('*, communication_style').eq('tenant_id', tenantId).eq('contact_id', senderJid).single()
                    
                    if (profData) {
                        const nicknames = profData.metadata?.nicknames || []
                        senderProfile = `\n\n[PERFIL DO INTERLOCUTOR: Nome: ${profData.full_name || author}, Apelidos: ${nicknames.join(', ')}, Estilo Pessoal/Gírias: ${profData.communication_style || 'Neutro'}]`
                        console.log(`[RAG] 👤 Conhecimento sobre ${senderJid} injetado`)
                    }
                } catch (e) { 
                    console.error(`[RAG ERROR] Falha ao buscar dados:`, e.message)
                }

                const contextCombined = `${conversationMemory}${senderProfile}`
                
                // Instrução de mimetismo
                const styleInstruction = `\n\n[INSTRUÇÃO DE ESTILO: A VIBE é ${currentVibe}. Use as GÍRIAS e o ESTILO local se for descontraído. Se houver APELIDOS, use-os esporadicamente. Aja como um MEMBRO do grupo, não um assistente robótico.]`

                const systemPrompt = session.aiConfigs?.system_prompt || "Você é um assistente virtual descontraído."

                if (tenantId === ADMIN_TENANT_ID) {
                    fullPrompt = `INSTRUÇÕES:\n${systemPrompt}${contextCombined}${styleInstruction}\n\nPERGUNTA: ${cleanText || "Oi!"}`
                } else {
                    const businessContext = await getTenantContext(tenantId)
                    fullPrompt = `CONTEXTO DA EMPRESA:\n${businessContext}\n\nINSTRUÇÕES:\n${systemPrompt}${contextCombined}${styleInstruction}\n\nPERGUNTA: ${cleanText || "Oi!"}`
                }

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

async function learnFromConversation(tenantId, conversationId, newMessages, aiConfigs) {
    if (!aiConfigs || !aiConfigs.api_key) return
    console.log(`[LEARN] 🧠 Analisando Dinâmica Social em ${conversationId}...`)
    
    try {
        const { data: currentContext } = await supabase.from('whatsapp_conversation_contexts')
            .select('*').eq('tenant_id', tenantId).eq('conversation_id', conversationId).single()
        
        let oldSummary = currentContext?.summary || "Nenhuma fofoca gravada."
        let transcript = newMessages.map(m => `${m.author} (${m.authorJid}): ${m.text}`).join('\n')

        const prompt = `Você é um Analista de Comportamento e Sócio-Linguística.
RESUMO ATUAL: "${oldSummary}"
MENSAGENS RECENTES:
${transcript}

Sua tarefa é retornar um JSON (APENAS O JSON) para atualizar o sistema de memória ativa:
1. "summary": Novo resumo unindo o contexto anterior e as novas falas.
2. "vibe": O humor predominante (ex: "Zoeira", "Sério", "Discussão", "Gargalhadas").
3. "group_type": Categoria do grupo (ex: "Amigos", "Trabalho", "Família", "Negócios").
4. "daily_topics": Principais assuntos debatidos agora.
5. "style": Gírias e termos regionais mais usados (ex: "macho", "cuida", "vixe").
6. "profiles": Lista de { "jid", "nicknames": [], "traits", "style_note" }.
   - Identifique quem é quem pelas tags @id se houver.
   - Associe apelidos a quem foi marcado!
7. "proactive_thought": Uma opinião curta e espontânea sobre o assunto se algo for MUITO engraçado ou bizarro. Deixe vazio na maioria das vezes.

Retorne APENAS o JSON puro.`

        const aiResponse = await getAIResponse(prompt, aiConfigs, "Você é um membro observador do grupo. Responda apenas com JSON puro.")
        
        if (aiResponse) {
            try {
                const cleanJson = aiResponse.replace(/```json|```/g, '').trim()
                const result = JSON.parse(cleanJson)

                // 4. Salva Contexto com IA Avançada
                await supabase.from('whatsapp_conversation_contexts').upsert({
                    tenant_id: tenantId,
                    conversation_id: conversationId,
                    summary: result.summary || oldSummary,
                    vibe: result.vibe || "Neutro",
                    group_type: result.group_type || "Geral",
                    daily_topics: result.daily_topics || "",
                    communication_style: result.style || "",
                    updated_at: new Date()
                }, { onConflict: 'tenant_id, conversation_id' })

                // 5. Atualiza Perfis
                if (result.profiles) {
                    for (const p of result.profiles) {
                        if (p.jid) {
                            const { data: existing } = await supabase.from('whatsapp_contact_profiles')
                                .select('metadata').eq('tenant_id', tenantId).eq('contact_id', p.jid).single()
                            
                            let meta = existing?.metadata || {}
                            if (!meta.nicknames) meta.nicknames = []
                            if (p.nicknames) p.nicknames.forEach(n => { if (!meta.nicknames.includes(n)) meta.nicknames.push(n) })
                            
                            await supabase.from('whatsapp_contact_profiles').upsert({
                                tenant_id: tenantId,
                                contact_id: p.jid,
                                nickname: meta.nicknames[0] || null,
                                personality_traits: p.traits || null,
                                communication_style: p.style_note || null,
                                metadata: meta,
                                updated_at: new Date()
                            }, { onConflict: 'tenant_id, contact_id' })
                        }
                    }
                }

                // 6. Intervenção Proativa (Rara)
                const shouldBeProactive = Math.random() < (currentContext?.proactive_frequency || 0.05)
                if (shouldBeProactive && result.proactive_thought && result.proactive_thought.length > 5) {
                    console.log(`[PROACTIVE] 🤖 IA decidiu dar um pitaco: "${result.proactive_thought}"`)
                    const session = sessions.get(tenantId)
                    if (session?.sock) {
                        // Envia o pensamento como se fosse um comentário espontâneo
                        setTimeout(async () => {
                            await session.sock.sendMessage(conversationId, { text: result.proactive_thought })
                        }, 5000) // Delay pra parecer natural
                    }
                }

                console.log(`[LEARN] ✅ Dinâmica social atualizada para ${conversationId}`)
            } catch (jsonErr) {
                console.warn(`[LEARN] ⚠️ Erro ao processar JSON:`, jsonErr.message)
            }
        }
    } catch (err) {
        console.error(`[LEARN] ❌ Erro:`, err)
    }
}

async function loadTenantAIConfigs(tenantId) {
    try {
        let configData = {}
        const isAdmin = tenantId === ADMIN_TENANT_ID

        if (isAdmin) {
            // Admin usa a tabela legada 'ai_configs' (key, value)
            const { data, error } = await supabase.from('ai_configs').select('*')
            const configs = {}
            if (!error && data) data.forEach(item => configs[item.key] = item.value)

            const provider = configs.ai_provider || 'gemini'
            configData = {
                ai_provider: provider,
                api_key: configs[`${provider}_api_key`] || process.env.GEMINI_API_KEY || '',
                model: configs[`${provider}_model`] || 'gemini-1.5-flash',
                system_prompt: configs[`${provider}_system_prompt`] || 'Você é o assistente RED.IA, da RED Corporation.',
                ai_prefix: configs.ai_prefix || '',
                ai_bot_enabled: configs.ai_bot_enabled === 'true'
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
                ai_bot_enabled: data?.ai_enabled === true
            }
        }

        const session = sessions.get(tenantId)
        if (session) {
            session.aiConfigs = configData
            console.log(`✅ Configs de IA carregadas para Tenant ${tenantId}. Provedor: ${configData.ai_provider}`)
        }
    } catch (err) {
        console.error(`Erro ao carregar configs de IA para Tenant ${tenantId}:`, err?.message)
        const session = sessions.get(tenantId)
        if (session) {
            session.aiConfigs = {
                ai_provider: 'gemini',
                api_key: process.env.GEMINI_API_KEY || '',
                model: 'gemini-1.5-flash',
                system_prompt: 'Você é um assistente virtual prestativo.',
                ai_prefix: '',
                ai_bot_enabled: false
            }
        }
    }
}

async function getTenantContext(tenantId) {
    if (tenantId === ADMIN_TENANT_ID) return ""
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

async function getAIResponse(text, configs, overrideSystemPrompt = null) {
    const provider = configs.ai_provider || 'gemini'
    const systemPrompt = overrideSystemPrompt || configs.system_prompt || "Você é um assistente virtual prestativo."
    
    try {
        if (!configs.api_key || !configs.model) {
            console.warn(`IA (Tenant): API Key ou Modelo não configurado para o provedor ${provider}.`)
            return "Desculpe, meu cérebro de IA não está totalmente configurado no momento. Por favor, avise o administrador!"
        }

        if (provider === 'gemini') {
            const genAI = new GoogleGenerativeAI(configs.api_key)
            const model = genAI.getGenerativeModel({
                model: configs.model,
                systemInstruction: systemPrompt // Usa o override ou o padrão do banco
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
                'Authorization': `Bearer ${configs.api_key}`,
                'Content-Type': 'application/json',
                'HTTP-Referer': 'https://redcomercial.com.br',
                'X-Title': 'Red Comercial AI'
            },
            body: JSON.stringify({
                model: configs.model,
                messages: [
                    { role: "system", content: systemPrompt },
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
app.post('/ai/reload', async (req, res) => {
    console.log(`🔄 Recarregando configurações de IA para o Admin (Global)...`)
    await loadTenantAIConfigs(ADMIN_TENANT_ID)
    res.json({ success: true, message: 'Configurações de IA do Admin recarregadas.' })
})

app.get('/status/:tenantId', (req, res) => {
    const { tenantId } = req.params
    const session = sessions.get(tenantId)
    if (!session) {
        return res.json({ status: 'disconnected', qr: null, message: 'Sessão não encontrada ou desconectada.' })
    }
    res.json({ status: session.status, qr: session.lastQr, message: `Status da sessão para ${tenantId}` })
})

app.post('/start/:tenantId', async (req, res) => {
    try {
        const { tenantId } = req.params
        console.log(`[API /start] Recebido para tenantId: "${tenantId}"`)
        const existing = sessions.get(tenantId)
        console.log(`[API /start] Sessão existente: ${!!existing} | status: ${existing?.status}`)
        
        if (existing && existing.status !== 'disconnected' && existing.status !== 'error') {
            console.log(`[API /start] Sessão já ativa (${existing.status}), ignorando novo start.`)
            return res.json({ success: true, message: 'Sessão já está rodando ou em processo de conexão.', status: existing.status })
        }

        console.log(`[API /start] Chamando connectToWhatsApp('${tenantId}')...`)
        
        // Retorna ANTES de carregar tudo pra evitar timeout de 15s do painel (Erro 500)
        res.json({ success: true, message: 'Iniciando conexão para o tenant...', status: 'connecting' })

        connectToWhatsApp(tenantId).catch(err => {
            console.error(`[BG CONN] Falha crítica ao iniciar conexão para ${tenantId}:`, err)
        })
        return
    } catch (err) {
        console.error(`[API /start] Erro interno 500:`, err)
        if (!res.headersSent) {
            res.status(500).json({ success: false, error: err.message || 'Erro interno no microserviço' })
        }
    }
})

app.post('/stop/:tenantId', async (req, res) => {
    const { tenantId } = req.params
    console.log(`[API /stop] Recebido para tenantId: "${tenantId}"`)
    const session = sessions.get(tenantId)
    const authPath = path.join(__dirname, `auth_info_baileys/tenant_${tenantId}`)

    console.log(`[API /stop] Sessão ativa: ${!!session} | authPath existe: ${fs.existsSync(authPath)}`)
    if (session && session.sock) {
        try {
            await session.sock.logout()
            console.log(`[API /stop] ✅ logout() executado para Tenant: ${tenantId}`)
            res.json({ success: true, message: 'Sessão desconectada com sucesso.' })
        } catch (e) {
            console.error(`[API /stop] ❌ Erro ao fazer logout do Tenant ${tenantId}:`, e?.message)
            // Força limpeza mesmo em caso de erro
            sessions.delete(tenantId)
            if (fs.existsSync(authPath)) fs.rmSync(authPath, { recursive: true, force: true })
            console.log(`[API /stop] 🧹 Limpeza forçada após erro de logout.`)
            res.json({ success: true, message: 'Sessão limpa após erro de logout.' })
        }
    } else {
        if (fs.existsSync(authPath)) {
            fs.rmSync(authPath, { recursive: true, force: true })
            console.log(`[API /stop] 🧹 Pasta de auth removida para Tenant: ${tenantId}`)
        }
        res.json({ success: true, message: 'Nenhuma sessão ativa. Pastas limpas.' })
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
