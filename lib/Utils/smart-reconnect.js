"use strict"

/**
 * Smart Reconnection System for Ryze
 * Sistema inteligente de reconexión con backoff exponencial
 */

Object.defineProperty(exports, "__esModule", { value: true })

const Types_1 = require("../Types")

// Configuración de reconexión
const RECONNECT_CONFIG = {
    // Intentos máximos
    MAX_RETRIES: 15,
    
    // Delays base (ms)
    INITIAL_DELAY: 1000,
    MAX_DELAY: 300000,  // 5 minutos máximo
    
    // Factor de backoff
    BACKOFF_FACTOR: 1.5,
    
    // Jitter para evitar thundering herd
    JITTER_FACTOR: 0.3,
    
    // Tiempo para considerar conexión estable
    STABLE_CONNECTION_TIME: 60000,  // 1 minuto
    
    // Razones que permiten reconexión
    RECOVERABLE_REASONS: [
        Types_1.DisconnectReason.connectionClosed,
        Types_1.DisconnectReason.connectionLost,
        Types_1.DisconnectReason.connectionReplaced,
        Types_1.DisconnectReason.timedOut,
        Types_1.DisconnectReason.restartRequired
    ],
    
    // Razones que NO permiten reconexión
    FATAL_REASONS: [
        Types_1.DisconnectReason.loggedOut,
        Types_1.DisconnectReason.badSession,
        Types_1.DisconnectReason.multideviceMismatch
    ]
}

/**
 * Clase para manejar reconexiones inteligentes
 */
class SmartReconnect {
    constructor(logger, config = {}) {
        this.logger = logger
        this.config = { ...RECONNECT_CONFIG, ...config }
        this.retryCount = 0
        this.lastConnectTime = null
        this.lastDisconnectReason = null
        this.connectionStable = false
        this.reconnectTimer = null
        this.healthCheckInterval = null
        this.stats = {
            totalReconnects: 0,
            successfulReconnects: 0,
            failedReconnects: 0,
            lastSuccessfulConnect: null,
            averageDowntime: 0
        }
    }

    /**
     * Calcula el delay para el próximo intento
     */
    calculateDelay() {
        const baseDelay = this.config.INITIAL_DELAY * Math.pow(this.config.BACKOFF_FACTOR, this.retryCount)
        const cappedDelay = Math.min(baseDelay, this.config.MAX_DELAY)
        
        // Añadir jitter aleatorio
        const jitter = cappedDelay * this.config.JITTER_FACTOR * (Math.random() - 0.5)
        
        return Math.floor(cappedDelay + jitter)
    }

    /**
     * Determina si se debe intentar reconectar
     */
    shouldReconnect(reason, statusCode) {
        // Si es razón fatal, no reconectar
        if (this.config.FATAL_REASONS.includes(statusCode)) {
            this.logger?.warn({ reason, statusCode }, 'Fatal disconnect reason - not reconnecting')
            return { shouldReconnect: false, reason: 'Fatal error - session invalidated' }
        }

        // Si se agotaron los intentos
        if (this.retryCount >= this.config.MAX_RETRIES) {
            this.logger?.error({ retryCount: this.retryCount }, 'Max retries exceeded')
            return { shouldReconnect: false, reason: 'Max retries exceeded' }
        }

        // Si es razón recuperable
        if (this.config.RECOVERABLE_REASONS.includes(statusCode)) {
            return { shouldReconnect: true, delay: this.calculateDelay() }
        }

        // Por defecto, intentar reconectar con precaución
        return { shouldReconnect: true, delay: this.calculateDelay() * 2 }
    }

    /**
     * Maneja el evento de desconexión
     */
    async handleDisconnect(reason, statusCode, reconnectCallback) {
        this.lastDisconnectReason = { reason, statusCode, time: Date.now() }
        this.connectionStable = false

        const decision = this.shouldReconnect(reason, statusCode)

        if (!decision.shouldReconnect) {
            this.logger?.info({ reason: decision.reason }, 'Not attempting reconnection')
            return { reconnecting: false, reason: decision.reason }
        }

        this.retryCount++
        this.stats.totalReconnects++

        const delay = decision.delay

        this.logger?.info({ 
            attempt: this.retryCount, 
            maxRetries: this.config.MAX_RETRIES,
            delay,
            reason 
        }, 'Scheduling reconnection')

        // Programar reconexión
        return new Promise((resolve) => {
            this.reconnectTimer = setTimeout(async () => {
                try {
                    await reconnectCallback()
                    this.onSuccessfulReconnect()
                    resolve({ reconnecting: true, success: true })
                } catch (error) {
                    this.stats.failedReconnects++
                    this.logger?.error({ error }, 'Reconnection failed')
                    resolve({ reconnecting: true, success: false, error })
                }
            }, delay)
        })
    }

    /**
     * Llamar cuando la conexión es exitosa
     */
    onSuccessfulReconnect() {
        const previousRetries = this.retryCount
        this.retryCount = 0
        this.lastConnectTime = Date.now()
        this.stats.successfulReconnects++
        this.stats.lastSuccessfulConnect = new Date().toISOString()

        this.logger?.info({ previousRetries }, 'Successfully reconnected')

        // Marcar como estable después del tiempo configurado
        setTimeout(() => {
            if (this.lastConnectTime && Date.now() - this.lastConnectTime >= this.config.STABLE_CONNECTION_TIME) {
                this.connectionStable = true
                this.logger?.debug('Connection marked as stable')
            }
        }, this.config.STABLE_CONNECTION_TIME)
    }

    /**
     * Cancela cualquier reconexión pendiente
     */
    cancelPendingReconnect() {
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer)
            this.reconnectTimer = null
        }
    }

    /**
     * Reinicia el contador de intentos
     */
    reset() {
        this.retryCount = 0
        this.lastDisconnectReason = null
        this.cancelPendingReconnect()
    }

    /**
     * Obtiene estadísticas de reconexión
     */
    getStats() {
        return {
            ...this.stats,
            currentRetryCount: this.retryCount,
            isStable: this.connectionStable,
            lastDisconnect: this.lastDisconnectReason
        }
    }

    /**
     * Inicia health check periódico
     */
    startHealthCheck(pingCallback, interval = 30000) {
        this.stopHealthCheck()
        
        this.healthCheckInterval = setInterval(async () => {
            try {
                await pingCallback()
                this.logger?.debug('Health check passed')
            } catch (error) {
                this.logger?.warn({ error }, 'Health check failed')
            }
        }, interval)
    }

    /**
     * Detiene health check
     */
    stopHealthCheck() {
        if (this.healthCheckInterval) {
            clearInterval(this.healthCheckInterval)
            this.healthCheckInterval = null
        }
    }

    /**
     * Limpieza
     */
    cleanup() {
        this.cancelPendingReconnect()
        this.stopHealthCheck()
    }
}

/**
 * Crea un manejador de conexión con reconexión automática
 */
function createConnectionHandler(sock, logger, options = {}) {
    const reconnect = new SmartReconnect(logger, options)

    return {
        reconnect,
        
        /**
         * Maneja actualizaciones de conexión
         */
        async handleConnectionUpdate(update, startSock) {
            const { connection, lastDisconnect, qr } = update

            if (connection === 'close') {
                const statusCode = lastDisconnect?.error?.output?.statusCode
                const reason = lastDisconnect?.error?.message || 'Unknown'

                const result = await reconnect.handleDisconnect(reason, statusCode, startSock)
                return result
            }

            if (connection === 'open') {
                reconnect.onSuccessfulReconnect()
                return { connected: true }
            }

            if (qr) {
                // Reset retry count cuando se muestra QR nuevo
                reconnect.reset()
                return { qr }
            }

            return update
        },

        /**
         * Obtiene estado de la conexión
         */
        getStatus() {
            return {
                stats: reconnect.getStats(),
                isHealthy: reconnect.connectionStable && reconnect.retryCount === 0
            }
        }
    }
}

/**
 * Wrapper para ejecutar con retry automático
 */
async function withRetry(fn, options = {}) {
    const {
        maxRetries = 3,
        delay = 1000,
        backoff = 2,
        onRetry = null
    } = options

    let lastError

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            return await fn()
        } catch (error) {
            lastError = error

            if (attempt === maxRetries) {
                throw error
            }

            const waitTime = delay * Math.pow(backoff, attempt)
            
            if (onRetry) {
                onRetry(error, attempt + 1, waitTime)
            }

            await new Promise(resolve => setTimeout(resolve, waitTime))
        }
    }

    throw lastError
}

exports.RECONNECT_CONFIG = RECONNECT_CONFIG
exports.SmartReconnect = SmartReconnect
exports.createConnectionHandler = createConnectionHandler
exports.withRetry = withRetry
