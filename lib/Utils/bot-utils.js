"use strict"

/**
 * Bot Utilities for Ryze
 * Utilidades específicas para desarrollo de bots
 */

Object.defineProperty(exports, "__esModule", { value: true })

const WABinary_1 = require("../WABinary")
const crypto_1 = require("crypto")

/**
 * Parsea comandos de mensajes
 */
function parseCommand(text, prefix = '.') {
    if (!text || typeof text !== 'string') {
        return { isCommand: false }
    }

    const trimmed = text.trim()
    
    // Verificar si empieza con el prefijo
    if (!trimmed.startsWith(prefix)) {
        return { isCommand: false }
    }

    // Extraer comando y argumentos
    const withoutPrefix = trimmed.slice(prefix.length)
    const parts = withoutPrefix.split(/\s+/)
    const command = parts[0].toLowerCase()
    const args = parts.slice(1)
    const fullArgs = withoutPrefix.slice(command.length).trim()

    // Parsear flags (--flag o -f)
    const flags = {}
    const cleanArgs = []

    for (const arg of args) {
        if (arg.startsWith('--')) {
            const [key, value] = arg.slice(2).split('=')
            flags[key] = value || true
        } else if (arg.startsWith('-') && arg.length === 2) {
            flags[arg.slice(1)] = true
        } else {
            cleanArgs.push(arg)
        }
    }

    return {
        isCommand: true,
        command,
        args: cleanArgs,
        fullArgs,
        flags,
        raw: text,
        prefix
    }
}

/**
 * Extrae menciones de un mensaje
 */
function extractMentions(message) {
    const mentions = []
    
    // Menciones en mensaje extendido
    const extendedText = message.extendedTextMessage
    if (extendedText?.contextInfo?.mentionedJid) {
        mentions.push(...extendedText.contextInfo.mentionedJid)
    }

    // Menciones directas
    if (message.mentionedJid) {
        mentions.push(...message.mentionedJid)
    }

    // Buscar @números en el texto
    const text = extractText(message)
    if (text) {
        const phoneMatches = text.match(/@(\d+)/g)
        if (phoneMatches) {
            phoneMatches.forEach(match => {
                const phone = match.slice(1)
                const jid = `${phone}@s.whatsapp.net`
                if (!mentions.includes(jid)) {
                    mentions.push(jid)
                }
            })
        }
    }

    return [...new Set(mentions)]
}

/**
 * Extrae texto de diferentes tipos de mensajes
 */
function extractText(message) {
    if (!message) return ''

    // Mensaje directo
    if (typeof message === 'string') return message

    // Diferentes tipos de mensajes
    const textSources = [
        message.conversation,
        message.extendedTextMessage?.text,
        message.imageMessage?.caption,
        message.videoMessage?.caption,
        message.documentMessage?.caption,
        message.buttonsResponseMessage?.selectedButtonId,
        message.listResponseMessage?.singleSelectReply?.selectedRowId,
        message.templateButtonReplyMessage?.selectedId
    ]

    return textSources.find(t => t) || ''
}

/**
 * Extrae información del mensaje citado (reply)
 */
function extractQuotedMessage(message) {
    const contextInfo = 
        message.extendedTextMessage?.contextInfo ||
        message.imageMessage?.contextInfo ||
        message.videoMessage?.contextInfo ||
        message.documentMessage?.contextInfo ||
        message.stickerMessage?.contextInfo

    if (!contextInfo?.quotedMessage) {
        return null
    }

    return {
        message: contextInfo.quotedMessage,
        stanzaId: contextInfo.stanzaId,
        participant: contextInfo.participant,
        remoteJid: contextInfo.remoteJid,
        text: extractText(contextInfo.quotedMessage)
    }
}

/**
 * Verifica si el remitente es admin del grupo
 */
async function isGroupAdmin(sock, jid, participantJid) {
    try {
        if (!WABinary_1.isJidGroup(jid)) return false

        const metadata = await sock.groupMetadata(jid)
        const participant = metadata.participants.find(
            p => WABinary_1.jidNormalizedUser(p.id) === WABinary_1.jidNormalizedUser(participantJid)
        )

        return participant?.admin === 'admin' || participant?.admin === 'superadmin'
    } catch {
        return false
    }
}

/**
 * Verifica si el bot es admin del grupo
 */
async function isBotAdmin(sock, jid) {
    const botJid = sock.user?.id
    if (!botJid) return false
    return isGroupAdmin(sock, jid, botJid)
}

/**
 * Obtiene el JID del remitente real
 */
function getSenderJid(msg) {
    const isGroup = WABinary_1.isJidGroup(msg.key.remoteJid)
    return isGroup ? msg.key.participant : msg.key.remoteJid
}

/**
 * Formatea un JID para mostrar
 */
function formatJid(jid) {
    if (!jid) return 'Desconocido'
    const decoded = WABinary_1.jidDecode(jid)
    return decoded?.user || jid.split('@')[0] || jid
}

/**
 * Genera un ID único para mensajes
 */
function generateMessageId() {
    const timestamp = Date.now().toString(36)
    const random = crypto_1.randomBytes(8).toString('hex')
    return `${timestamp}-${random}`.toUpperCase()
}

/**
 * Limita texto a una longitud máxima
 */
function truncateText(text, maxLength = 100, suffix = '...') {
    if (!text || text.length <= maxLength) return text
    return text.slice(0, maxLength - suffix.length) + suffix
}

/**
 * Escapa caracteres especiales de Markdown
 */
function escapeMarkdown(text) {
    if (!text) return ''
    return text.replace(/([*_`\[\]()])/g, '\\$1')
}

/**
 * Formatea número de teléfono
 */
function formatPhoneNumber(jid) {
    const number = jid.replace(/[^0-9]/g, '')
    
    // Formato internacional básico
    if (number.length >= 10) {
        const countryCode = number.slice(0, -10)
        const areaCode = number.slice(-10, -7)
        const first = number.slice(-7, -4)
        const last = number.slice(-4)
        
        return `+${countryCode} ${areaCode} ${first} ${last}`
    }
    
    return number
}

/**
 * Cooldown manager para comandos
 */
class CooldownManager {
    constructor() {
        this.cooldowns = new Map()
    }

    /**
     * Verifica si está en cooldown
     */
    isOnCooldown(key, cooldownMs) {
        const expiry = this.cooldowns.get(key)
        if (!expiry) return false
        
        if (Date.now() < expiry) {
            return true
        }
        
        this.cooldowns.delete(key)
        return false
    }

    /**
     * Establece cooldown
     */
    setCooldown(key, cooldownMs) {
        this.cooldowns.set(key, Date.now() + cooldownMs)
    }

    /**
     * Obtiene tiempo restante de cooldown
     */
    getRemainingTime(key) {
        const expiry = this.cooldowns.get(key)
        if (!expiry) return 0
        return Math.max(0, expiry - Date.now())
    }

    /**
     * Limpia cooldowns expirados
     */
    cleanup() {
        const now = Date.now()
        for (const [key, expiry] of this.cooldowns) {
            if (now >= expiry) {
                this.cooldowns.delete(key)
            }
        }
    }
}

/**
 * Permission manager simple
 */
class PermissionManager {
    constructor(config = {}) {
        this.owners = new Set(config.owners || [])
        this.admins = new Set(config.admins || [])
        this.banned = new Set(config.banned || [])
        this.premiums = new Set(config.premiums || [])
    }

    isOwner(jid) {
        return this.owners.has(WABinary_1.jidNormalizedUser(jid))
    }

    isAdmin(jid) {
        const normalized = WABinary_1.jidNormalizedUser(jid)
        return this.admins.has(normalized) || this.owners.has(normalized)
    }

    isBanned(jid) {
        return this.banned.has(WABinary_1.jidNormalizedUser(jid))
    }

    isPremium(jid) {
        return this.premiums.has(WABinary_1.jidNormalizedUser(jid))
    }

    addOwner(jid) { this.owners.add(WABinary_1.jidNormalizedUser(jid)) }
    removeOwner(jid) { this.owners.delete(WABinary_1.jidNormalizedUser(jid)) }
    
    addAdmin(jid) { this.admins.add(WABinary_1.jidNormalizedUser(jid)) }
    removeAdmin(jid) { this.admins.delete(WABinary_1.jidNormalizedUser(jid)) }
    
    ban(jid) { this.banned.add(WABinary_1.jidNormalizedUser(jid)) }
    unban(jid) { this.banned.delete(WABinary_1.jidNormalizedUser(jid)) }
    
    addPremium(jid) { this.premiums.add(WABinary_1.jidNormalizedUser(jid)) }
    removePremium(jid) { this.premiums.delete(WABinary_1.jidNormalizedUser(jid)) }

    toJSON() {
        return {
            owners: [...this.owners],
            admins: [...this.admins],
            banned: [...this.banned],
            premiums: [...this.premiums]
        }
    }
}

/**
 * Genera respuesta formateada
 */
function createReply(options) {
    const { 
        text, 
        mentions = [], 
        quoted = null,
        buttons = null,
        footer = null,
        title = null
    } = options

    const message = { text }

    if (mentions.length > 0) {
        message.mentions = mentions
    }

    if (quoted) {
        message.quoted = quoted
    }

    return message
}

/**
 * Parser de tiempo (1h, 30m, 2d, etc)
 */
function parseTime(timeStr) {
    if (!timeStr || typeof timeStr !== 'string') return 0

    const units = {
        s: 1000,
        m: 60 * 1000,
        h: 60 * 60 * 1000,
        d: 24 * 60 * 60 * 1000,
        w: 7 * 24 * 60 * 60 * 1000
    }

    const match = timeStr.match(/^(\d+)([smhdw])$/i)
    if (!match) return 0

    const value = parseInt(match[1])
    const unit = match[2].toLowerCase()

    return value * (units[unit] || 0)
}

/**
 * Formatea duración en ms a texto legible
 */
function formatDuration(ms) {
    const seconds = Math.floor(ms / 1000)
    const minutes = Math.floor(seconds / 60)
    const hours = Math.floor(minutes / 60)
    const days = Math.floor(hours / 24)

    if (days > 0) return `${days}d ${hours % 24}h`
    if (hours > 0) return `${hours}h ${minutes % 60}m`
    if (minutes > 0) return `${minutes}m ${seconds % 60}s`
    return `${seconds}s`
}

/**
 * Responde a un mensaje con la MÍNIMA latencia posible.
 * A diferencia de PresenceManager/typingDelay (que simulan escritura y añaden
 * delays anti-ban), esta función envía la respuesta de inmediato y, de forma
 * opcional y NO bloqueante, marca el mensaje original como leído en paralelo.
 *
 * @param {object} sock - El socket de Ryzewa (retorno de makeWASocket)
 * @param {string} jid - JID del chat al que responder
 * @param {object|string} content - Contenido del mensaje (o string para texto)
 * @param {object} [opts]
 * @param {object} [opts.quoted] - Mensaje a citar (msg completo con .key)
 * @param {boolean} [opts.markRead=false] - Marcar el citado como leído en paralelo
 * @returns {Promise<object>} El mensaje enviado
 *
 * ponytail: no simula "escribiendo…" a propósito — ese es el coste que paga
 * quien quiere apariencia humana. Para máxima velocidad se omite.
 */
async function sendFast(sock, jid, content, opts = {}) {
    const { quoted = null, markRead = false } = opts
    const message = typeof content === 'string' ? { text: content } : content

    // fire-and-forget: no esperamos el receipt para no añadir latencia
    if (markRead && quoted?.key) {
        sock.readMessages([quoted.key]).catch(() => {})
    }

    return sock.sendMessage(jid, message, quoted ? { quoted } : {})
}


exports.parseCommand = parseCommand
exports.extractMentions = extractMentions
exports.extractText = extractText
exports.extractQuotedMessage = extractQuotedMessage
exports.isGroupAdmin = isGroupAdmin
exports.isBotAdmin = isBotAdmin
exports.getSenderJid = getSenderJid
exports.formatJid = formatJid
exports.generateMessageId = generateMessageId
exports.truncateText = truncateText
exports.escapeMarkdown = escapeMarkdown
exports.formatPhoneNumber = formatPhoneNumber
exports.CooldownManager = CooldownManager
exports.PermissionManager = PermissionManager
exports.createReply = createReply
exports.parseTime = parseTime
exports.formatDuration = formatDuration
exports.sendFast = sendFast
