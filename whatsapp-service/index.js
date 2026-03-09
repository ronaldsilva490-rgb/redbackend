const express = require('express')
const cors = require('cors')
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, Browsers, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys')
const pino = require('pino')
const QRCode = require('qrcode')

const app = express()
app.use(cors())
app.use(express.json())

let sock = null
let currentQr = null
let qrStatus = 'disconnected' // 'connecting', 'qrcode', 'authenticated'

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
}

// Inicializa no boot
connectToWhatsApp()

// Endpoints
app.get('/status', (req, res) => {
    res.json({
        status: qrStatus,
        qr: currentQr
    })
})

app.get('/groups', async (req, res) => {
    try {
        if (qrStatus !== 'authenticated' || !sock) {
            return res.status(503).json({ error: 'WhatsApp não está conectado' })
        }
        const groupMetadata = await sock.groupFetchAllParticipating()
        const groups = Object.values(groupMetadata).map(group => ({
            id: group.id,
            subject: group.subject
        }))
        res.json({ success: true, groups })
    } catch (err) {
        console.error('Erro ao buscar grupos:', err)
        res.status(500).json({ error: err.message })
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
