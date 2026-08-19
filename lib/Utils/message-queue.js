"use strict"

/**
 * Advanced Queue System for Ryze
 * Sistema de colas con prioridad y rate limiting
 */

Object.defineProperty(exports, "__esModule", { value: true })

const LRUCache_1 = require("lru-cache")

// Niveles de prioridad
const PRIORITY = {
    CRITICAL: 0,    // Mensajes del sistema
    HIGH: 1,        // Respuestas directas
    NORMAL: 2,      // Mensajes normales
    LOW: 3,         // Broadcasts, bulk
    BACKGROUND: 4   // Tareas en segundo plano
}

// Configuración de colas (optimizado para velocidad)
const QUEUE_CONFIG = {
    MAX_QUEUE_SIZE: 1000,
    PROCESS_INTERVAL: 50,
    
    // Rate limits por tipo
    RATE_LIMITS: {
        message: { count: 100, window: 60000 },     // 100/min
        group: { count: 40, window: 60000 },        // 40/min por grupo
        media: { count: 50, window: 60000 },        // 50/min
        broadcast: { count: 200, window: 3600000 }, // 200/hora
    },
    
    // Delays entre mensajes por tipo
    DELAYS: {
        message: 300,
        group: 500,
        media: 800,
        broadcast: 1500
    }
}

/**
 * Item en la cola
 */
class QueueItem {
    constructor(task, priority = PRIORITY.NORMAL, metadata = {}) {
        this.id = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`
        this.task = task
        this.priority = priority
        this.metadata = metadata
        this.createdAt = Date.now()
        this.attempts = 0
        this.maxAttempts = metadata.maxAttempts || 3
        this.status = 'pending'
    }
}

/**
 * Cola de mensajes con prioridad
 */
class MessageQueue {
    constructor(logger, config = {}) {
        this.logger = logger
        this.config = { ...QUEUE_CONFIG, ...config }
        this.queue = []
        this.processing = false
        this.paused = false
        this.rateLimiters = new Map()
        this.processTimer = null
        
        // Estadísticas
        this.stats = {
            totalQueued: 0,
            totalProcessed: 0,
            totalFailed: 0,
            averageWaitTime: 0
        }
        
        // Cache de últimos mensajes enviados (para evitar duplicados)
        this.recentMessages = new LRUCache_1.LRUCache({
            max: 500,
            ttl: 300000 // 5 minutos
        })
    }

    /**
     * Agrega un task a la cola
     */
    enqueue(task, priority = PRIORITY.NORMAL, metadata = {}) {
        if (this.queue.length >= this.config.MAX_QUEUE_SIZE) {
            this.logger?.warn('Queue is full, dropping oldest low priority items')
            this._dropLowPriority()
        }

        const item = new QueueItem(task, priority, metadata)
        
        // Verificar duplicados
        const hash = this._hashTask(task, metadata)
        if (this.recentMessages.has(hash) && !metadata.allowDuplicate) {
            this.logger?.debug({ hash }, 'Duplicate message detected, skipping')
            return null
        }

        // Insertar en orden de prioridad
        let inserted = false
        for (let i = 0; i < this.queue.length; i++) {
            if (this.queue[i].priority > priority) {
                this.queue.splice(i, 0, item)
                inserted = true
                break
            }
        }

        if (!inserted) {
            this.queue.push(item)
        }

        this.stats.totalQueued++
        this.recentMessages.set(hash, true)

        this.logger?.debug({ 
            id: item.id, 
            priority, 
            queueSize: this.queue.length 
        }, 'Task enqueued')

        // Iniciar procesamiento si no está activo
        if (!this.processing && !this.paused) {
            this._startProcessing()
        }

        return item.id
    }

    /**
     * Genera hash para detectar duplicados
     */
    _hashTask(task, metadata) {
        const data = JSON.stringify({ 
            jid: metadata.jid, 
            content: typeof task === 'function' ? metadata.contentHash : task 
        })
        return Buffer.from(data).toString('base64').substr(0, 32)
    }

    /**
     * Elimina items de baja prioridad cuando la cola está llena
     */
    _dropLowPriority() {
        // Ordenar por prioridad (mayor = menor prioridad)
        this.queue.sort((a, b) => b.priority - a.priority)
        
        // Eliminar 10% de la cola (items de menor prioridad)
        const toDrop = Math.ceil(this.queue.length * 0.1)
        const dropped = this.queue.splice(0, toDrop)
        
        this.logger?.warn({ dropped: dropped.length }, 'Dropped low priority items')
    }

    /**
     * Inicia el procesamiento de la cola
     */
    _startProcessing() {
        if (this.processTimer) return

        this.processing = true
        this.processTimer = setInterval(() => this._processNext(), this.config.PROCESS_INTERVAL)
    }

    /**
     * Detiene el procesamiento
     */
    _stopProcessing() {
        if (this.processTimer) {
            clearInterval(this.processTimer)
            this.processTimer = null
        }
        this.processing = false
    }

    /**
     * Procesa el siguiente item en la cola
     */
    async _processNext() {
        if (this.paused || this.queue.length === 0) {
            if (this.queue.length === 0) {
                this._stopProcessing()
            }
            return
        }

        const item = this.queue.shift()
        if (!item) return

        item.status = 'processing'
        item.attempts++

        const waitTime = Date.now() - item.createdAt
        this._updateAverageWaitTime(waitTime)

        try {
            // Verificar rate limit
            const type = item.metadata.type || 'message'
            await this._checkRateLimit(type, item.metadata.jid)

            // Ejecutar task
            const result = typeof item.task === 'function' 
                ? await item.task() 
                : item.task

            item.status = 'completed'
            this.stats.totalProcessed++

            this.logger?.debug({ id: item.id, waitTime }, 'Task completed')

            // Delay después de procesar
            const delay = this.config.DELAYS[type] || this.config.DELAYS.message
            await this._delay(delay)

            return result

        } catch (error) {
            this.logger?.error({ id: item.id, error: error.message }, 'Task failed')

            if (item.attempts < item.maxAttempts) {
                // Re-encolar con menor prioridad
                item.priority = Math.min(item.priority + 1, PRIORITY.BACKGROUND)
                item.status = 'pending'
                this.queue.push(item)
                this.logger?.debug({ id: item.id, attempts: item.attempts }, 'Task re-queued')
            } else {
                item.status = 'failed'
                this.stats.totalFailed++
                this.logger?.warn({ id: item.id }, 'Task permanently failed')
            }
        }
    }

    /**
     * Verifica y aplica rate limiting
     */
    async _checkRateLimit(type, jid) {
        const limit = this.config.RATE_LIMITS[type] || this.config.RATE_LIMITS.message
        const key = jid ? `${type}:${jid}` : type

        if (!this.rateLimiters.has(key)) {
            this.rateLimiters.set(key, [])
        }

        const timestamps = this.rateLimiters.get(key)
        const now = Date.now()

        // Limpiar timestamps antiguos
        const valid = timestamps.filter(ts => now - ts < limit.window)
        this.rateLimiters.set(key, valid)

        // Verificar si excede el límite
        if (valid.length >= limit.count) {
            const oldestValid = valid[valid.length - limit.count]
            const waitTime = limit.window - (now - oldestValid)
            
            if (waitTime > 0) {
                this.logger?.debug({ key, waitTime }, 'Rate limited, waiting')
                await this._delay(waitTime)
            }
        }

        // Registrar timestamp
        valid.push(now)
    }

    /**
     * Actualiza tiempo de espera promedio
     */
    _updateAverageWaitTime(newTime) {
        const total = this.stats.totalProcessed
        this.stats.averageWaitTime = (this.stats.averageWaitTime * total + newTime) / (total + 1)
    }

    /**
     * Delay helper
     */
    _delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms))
    }

    /**
     * Pausa el procesamiento
     */
    pause() {
        this.paused = true
        this.logger?.info('Queue paused')
    }

    /**
     * Reanuda el procesamiento
     */
    resume() {
        this.paused = false
        if (this.queue.length > 0 && !this.processing) {
            this._startProcessing()
        }
        this.logger?.info('Queue resumed')
    }

    /**
     * Limpia la cola
     */
    clear(priority = null) {
        if (priority !== null) {
            this.queue = this.queue.filter(item => item.priority !== priority)
        } else {
            this.queue = []
        }
        this.logger?.info({ cleared: true, remaining: this.queue.length }, 'Queue cleared')
    }

    /**
     * Obtiene estadísticas
     */
    getStats() {
        return {
            ...this.stats,
            currentQueueSize: this.queue.length,
            isProcessing: this.processing,
            isPaused: this.paused,
            pendingByPriority: {
                critical: this.queue.filter(i => i.priority === PRIORITY.CRITICAL).length,
                high: this.queue.filter(i => i.priority === PRIORITY.HIGH).length,
                normal: this.queue.filter(i => i.priority === PRIORITY.NORMAL).length,
                low: this.queue.filter(i => i.priority === PRIORITY.LOW).length,
                background: this.queue.filter(i => i.priority === PRIORITY.BACKGROUND).length
            }
        }
    }

    /**
     * Limpieza
     */
    cleanup() {
        this._stopProcessing()
        this.queue = []
        this.rateLimiters.clear()
    }
}

/**
 * Crea una cola de mensajes preconfigurada
 */
function createMessageQueue(logger, customConfig = {}) {
    return new MessageQueue(logger, customConfig)
}

exports.PRIORITY = PRIORITY
exports.QUEUE_CONFIG = QUEUE_CONFIG
exports.QueueItem = QueueItem
exports.MessageQueue = MessageQueue
exports.createMessageQueue = createMessageQueue
