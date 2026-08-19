"use strict"

/**
 * Anti-Ban Utilities for Ryze
 * Sistema avanzado de protección contra baneos
 */

Object.defineProperty(exports, "__esModule", { value: true })

const crypto_1 = require("crypto")

// Configuración de delays anti-ban (optimizado para velocidad)
const ANTI_BAN_CONFIG = {
    // Delays entre mensajes (ms)
    MIN_MESSAGE_DELAY: 300,
    MAX_MESSAGE_DELAY: 800,
    
    // Delays para typing
    MIN_TYPING_DELAY: 500,
    MAX_TYPING_DELAY: 1500,
    
    // Delays para grupos
    GROUP_MESSAGE_DELAY: 500,
    GROUP_MAX_MESSAGES_PER_MINUTE: 40,
    
    // Delays para broadcast
    BROADCAST_DELAY: 1500,
    BROADCAST_MAX_PER_HOUR: 300,
    
    // Configuración de presencia
    PRESENCE_UPDATE_INTERVAL: 30000,
    
    // Jitter aleatorio (variación)
    JITTER_PERCENT: 0.3
}

/**
 * Genera un delay aleatorio dentro de un rango con jitter
 */
function randomDelay(min, max) {
    const base = Math.floor(Math.random() * (max - min + 1)) + min
    const jitter = base * ANTI_BAN_CONFIG.JITTER_PERCENT * (Math.random() - 0.5)
    return Math.max(min, Math.floor(base + jitter))
}

/**
 * Delay inteligente para mensajes
 */
async function messageDelay(isGroup = false) {
    const delay = isGroup 
        ? randomDelay(ANTI_BAN_CONFIG.GROUP_MESSAGE_DELAY, ANTI_BAN_CONFIG.GROUP_MESSAGE_DELAY * 2)
        : randomDelay(ANTI_BAN_CONFIG.MIN_MESSAGE_DELAY, ANTI_BAN_CONFIG.MAX_MESSAGE_DELAY)
    
    return new Promise(resolve => setTimeout(resolve, delay))
}

/**
 * Delay para simular typing realista
 * Basado en la longitud del mensaje
 */
async function typingDelay(messageLength = 50) {
    // Aproximadamente 40-60 palabras por minuto
    const wordsPerMinute = 50 + (Math.random() * 20 - 10)
    const avgWordLength = 5
    const estimatedWords = messageLength / avgWordLength
    const typingTime = (estimatedWords / wordsPerMinute) * 60 * 1000
    
    const minDelay = ANTI_BAN_CONFIG.MIN_TYPING_DELAY
    const calculatedDelay = Math.max(minDelay, Math.min(typingTime, ANTI_BAN_CONFIG.MAX_TYPING_DELAY))
    
    return new Promise(resolve => setTimeout(resolve, calculatedDelay))
}

/**
 * Rate Limiter para controlar el flujo de mensajes
 */
class RateLimiter {
    constructor(maxRequests, windowMs) {
        this.maxRequests = maxRequests
        this.windowMs = windowMs
        this.requests = new Map()
    }

    /**
     * Verifica si se puede enviar un mensaje
     */
    canSend(jid) {
        const now = Date.now()
        const key = jid || 'global'
        
        if (!this.requests.has(key)) {
            this.requests.set(key, [])
        }
        
        const timestamps = this.requests.get(key)
        
        // Limpiar timestamps antiguos
        const validTimestamps = timestamps.filter(ts => now - ts < this.windowMs)
        this.requests.set(key, validTimestamps)
        
        return validTimestamps.length < this.maxRequests
    }

    /**
     * Registra un envío
     */
    recordSend(jid) {
        const key = jid || 'global'
        
        if (!this.requests.has(key)) {
            this.requests.set(key, [])
        }
        
        this.requests.get(key).push(Date.now())
    }

    /**
     * Obtiene el tiempo de espera recomendado
     */
    getWaitTime(jid) {
        const key = jid || 'global'
        
        if (!this.requests.has(key)) return 0
        
        const timestamps = this.requests.get(key)
        if (timestamps.length < this.maxRequests) return 0
        
        const oldestValid = timestamps[timestamps.length - this.maxRequests]
        const waitTime = this.windowMs - (Date.now() - oldestValid)
        
        return Math.max(0, waitTime)
    }

    /**
     * Espera hasta poder enviar
     */
    async waitForSlot(jid) {
        const waitTime = this.getWaitTime(jid)
        if (waitTime > 0) {
            await new Promise(resolve => setTimeout(resolve, waitTime + randomDelay(100, 500)))
        }
        this.recordSend(jid)
    }

    /**
     * Limpia entradas antiguas
     */
    cleanup() {
        const now = Date.now()
        for (const [key, timestamps] of this.requests.entries()) {
            const valid = timestamps.filter(ts => now - ts < this.windowMs)
            if (valid.length === 0) {
                this.requests.delete(key)
            } else {
                this.requests.set(key, valid)
            }
        }
    }
}

/**
 * Gestor de presencia para simular actividad humana
 */
class PresenceManager {
    constructor(sock, logger) {
        this.sock = sock
        this.logger = logger
        this.activeChats = new Set()
        this.presenceInterval = null
    }

    /**
     * Simula presencia humana en un chat
     */
    async simulatePresence(jid, action = 'composing') {
        try {
            await this.sock.sendPresenceUpdate(action, jid)
            
            // Agregar a chats activos temporalmente
            this.activeChats.add(jid)
            
            setTimeout(() => {
                this.activeChats.delete(jid)
                this.sock.sendPresenceUpdate('paused', jid).catch(() => {})
            }, randomDelay(3000, 8000))
            
        } catch (error) {
            this.logger?.debug({ error }, 'Error updating presence')
        }
    }

    /**
     * Envía mensaje con presencia simulada
     */
    async sendWithPresence(jid, sendFunc, messageContent) {
        // Simular typing
        await this.simulatePresence(jid, 'composing')
        
        // Delay basado en longitud del mensaje
        const length = typeof messageContent === 'string' 
            ? messageContent.length 
            : JSON.stringify(messageContent).length
        
        await typingDelay(length)
        
        // Enviar mensaje
        const result = await sendFunc()
        
        // Pausar después de enviar
        setTimeout(() => {
            this.sock.sendPresenceUpdate('paused', jid).catch(() => {})
        }, randomDelay(500, 1500))
        
        return result
    }

    /**
     * Inicia actualizaciones periódicas de presencia
     */
    startPeriodicPresence() {
        if (this.presenceInterval) return
        
        this.presenceInterval = setInterval(() => {
            // Actualizar presencia general cada cierto tiempo
            this.sock.sendPresenceUpdate('available').catch(() => {})
        }, ANTI_BAN_CONFIG.PRESENCE_UPDATE_INTERVAL)
    }

    /**
     * Detiene las actualizaciones periódicas
     */
    stopPeriodicPresence() {
        if (this.presenceInterval) {
            clearInterval(this.presenceInterval)
            this.presenceInterval = null
        }
    }
}

/**
 * Generador de fingerprint único para la sesión
 * Ayuda a evitar detección de múltiples sesiones
 */
function generateSessionFingerprint() {
    const timestamp = Date.now()
    const random = crypto_1.randomBytes(8).toString('hex')
    return `${timestamp}-${random}`
}

/**
 * Valida si un JID parece legítimo
 */
function isValidJid(jid) {
    if (!jid || typeof jid !== 'string') return false
    
    // Patrones válidos
    const patterns = [
        /^\d+@s\.whatsapp\.net$/,           // Usuario normal
        /^\d+-\d+@g\.us$/,                   // Grupo
        /^\d+@broadcast$/,                   // Broadcast
        /^status@broadcast$/,                // Estado
        /^\d+@lid$/                          // LID
    ]
    
    return patterns.some(pattern => pattern.test(jid))
}

/**
 * Sanitiza el contenido del mensaje para evitar detecciones
 */
function sanitizeMessage(text) {
    if (!text || typeof text !== 'string') return text
    
    // Remover caracteres invisibles sospechosos
    let sanitized = text.replace(/[\u200B-\u200D\uFEFF]/g, '')
    
    // Remover exceso de saltos de línea
    sanitized = sanitized.replace(/\n{4,}/g, '\n\n\n')
    
    // Remover espacios excesivos
    sanitized = sanitized.replace(/ {3,}/g, '  ')
    
    return sanitized.trim()
}

// Rate limiters predefinidos
const globalRateLimiter = new RateLimiter(100, 60000)       // 100 mensajes/minuto global
const groupRateLimiter = new RateLimiter(20, 60000)         // 20 mensajes/minuto por grupo
const broadcastRateLimiter = new RateLimiter(200, 3600000)  // 200 broadcasts/hora

exports.ANTI_BAN_CONFIG = ANTI_BAN_CONFIG
exports.randomDelay = randomDelay
exports.messageDelay = messageDelay
exports.typingDelay = typingDelay
exports.RateLimiter = RateLimiter
exports.PresenceManager = PresenceManager
exports.generateSessionFingerprint = generateSessionFingerprint
exports.isValidJid = isValidJid
exports.sanitizeMessage = sanitizeMessage
exports.globalRateLimiter = globalRateLimiter
exports.groupRateLimiter = groupRateLimiter
exports.broadcastRateLimiter = broadcastRateLimiter
