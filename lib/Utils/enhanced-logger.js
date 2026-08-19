"use strict"

/**
 * Enhanced Logger for Ryze
 * Sistema de logging optimizado con colores y categorías
 */

Object.defineProperty(exports, "__esModule", { value: true })

const pino_1 = require("pino")

// Niveles de log personalizados
const LOG_LEVELS = {
    fatal: 60,
    error: 50,
    warn: 40,
    info: 30,
    debug: 20,
    trace: 10,
    silent: Infinity
}

// Colores ANSI para terminal
const COLORS = {
    reset: '\x1b[0m',
    bold: '\x1b[1m',
    dim: '\x1b[2m',
    
    // Colores por nivel
    fatal: '\x1b[35m\x1b[1m',  // Magenta bold
    error: '\x1b[31m',         // Rojo
    warn: '\x1b[33m',          // Amarillo
    info: '\x1b[36m',          // Cyan
    debug: '\x1b[34m',         // Azul
    trace: '\x1b[90m',         // Gris
    
    // Colores para categorías
    socket: '\x1b[32m',        // Verde
    message: '\x1b[33m',       // Amarillo
    media: '\x1b[35m',         // Magenta
    group: '\x1b[36m',         // Cyan
    auth: '\x1b[31m',          // Rojo
    cache: '\x1b[34m'          // Azul
}

// Emojis para categorías
const CATEGORY_ICONS = {
    socket: '🔌',
    message: '💬',
    media: '📎',
    group: '👥',
    auth: '🔐',
    cache: '📦',
    queue: '📋',
    error: '❌',
    warn: '⚠️',
    info: 'ℹ️',
    debug: '🔍',
    success: '✅'
}

/**
 * Formatea tiempo en formato legible
 */
function formatTime(date = new Date()) {
    return date.toLocaleTimeString('es-ES', {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false
    })
}

/**
 * Formatea el mensaje para consola con colores
 */
function formatConsoleMessage(level, category, message, data) {
    const time = formatTime()
    const levelColor = COLORS[level] || COLORS.info
    const categoryColor = COLORS[category] || COLORS.reset
    const icon = CATEGORY_ICONS[category] || CATEGORY_ICONS[level] || ''
    
    let formatted = `${COLORS.dim}[${time}]${COLORS.reset} `
    formatted += `${levelColor}${level.toUpperCase().padEnd(5)}${COLORS.reset} `
    
    if (category) {
        formatted += `${categoryColor}${icon} ${category}${COLORS.reset} `
    }
    
    formatted += message
    
    if (data && Object.keys(data).length > 0) {
        const dataStr = JSON.stringify(data, null, 0)
        if (dataStr.length < 100) {
            formatted += ` ${COLORS.dim}${dataStr}${COLORS.reset}`
        }
    }
    
    return formatted
}

/**
 * Logger mejorado para Ryze
 */
class RyzeLogger {
    constructor(options = {}) {
        this.options = {
            level: options.level || 'info',
            prettyPrint: options.prettyPrint !== false,
            category: options.category || 'baileys',
            colors: options.colors !== false,
            timestamps: options.timestamps !== false,
            ...options
        }

        this.category = this.options.category
        this.filters = new Set(options.filters || [])
        this.history = []
        this.maxHistory = options.maxHistory || 1000

        // Crear logger de pino subyacente (sin pino-pretty para evitar dependencia extra)
        this.pino = pino_1.default({
            level: this.options.level
        })
    }

    /**
     * Log genérico
     */
    _log(level, messageOrData, data = {}) {
        let message = ''
        let logData = data

        if (typeof messageOrData === 'string') {
            message = messageOrData
        } else if (typeof messageOrData === 'object') {
            logData = messageOrData
            message = messageOrData.msg || ''
        }

        // Aplicar filtros
        if (this.filters.size > 0) {
            const shouldFilter = [...this.filters].some(f => 
                message.includes(f) || JSON.stringify(logData).includes(f)
            )
            if (shouldFilter) return
        }

        // Guardar en historial
        this._addToHistory(level, message, logData)

        // Log a consola si es pretty print
        if (this.options.prettyPrint) {
            console.log(formatConsoleMessage(level, this.category, message, logData))
        } else {
            this.pino[level]({ ...logData, category: this.category }, message)
        }
    }

    /**
     * Agrega al historial
     */
    _addToHistory(level, message, data) {
        this.history.push({
            timestamp: new Date().toISOString(),
            level,
            category: this.category,
            message,
            data
        })

        if (this.history.length > this.maxHistory) {
            this.history.shift()
        }
    }

    // Métodos de log por nivel
    fatal(messageOrData, data) { this._log('fatal', messageOrData, data) }
    error(messageOrData, data) { this._log('error', messageOrData, data) }
    warn(messageOrData, data) { this._log('warn', messageOrData, data) }
    info(messageOrData, data) { this._log('info', messageOrData, data) }
    debug(messageOrData, data) { this._log('debug', messageOrData, data) }
    trace(messageOrData, data) { this._log('trace', messageOrData, data) }

    /**
     * Log de éxito
     */
    success(message, data = {}) {
        const formatted = `${COLORS.reset}${CATEGORY_ICONS.success} ${message}${COLORS.reset}`
        this._log('info', formatted, data)
    }

    /**
     * Crea un child logger con categoría específica
     */
    child(bindings) {
        const childLogger = new RyzeLogger({
            ...this.options,
            category: bindings.class || bindings.category || this.category
        })
        return childLogger
    }

    /**
     * Cambia el nivel de log dinámicamente
     */
    setLevel(level) {
        this.options.level = level
        this.pino.level = level
    }

    /**
     * Agrega un filtro
     */
    addFilter(pattern) {
        this.filters.add(pattern)
    }

    /**
     * Remueve un filtro
     */
    removeFilter(pattern) {
        this.filters.delete(pattern)
    }

    /**
     * Obtiene el historial de logs
     */
    getHistory(options = {}) {
        let history = [...this.history]

        if (options.level) {
            history = history.filter(h => h.level === options.level)
        }

        if (options.category) {
            history = history.filter(h => h.category === options.category)
        }

        if (options.since) {
            const sinceDate = new Date(options.since)
            history = history.filter(h => new Date(h.timestamp) >= sinceDate)
        }

        if (options.limit) {
            history = history.slice(-options.limit)
        }

        return history
    }

    /**
     * Limpia el historial
     */
    clearHistory() {
        this.history = []
    }

    /**
     * Exporta logs a string
     */
    exportLogs(format = 'json') {
        if (format === 'json') {
            return JSON.stringify(this.history, null, 2)
        }

        return this.history.map(h => 
            `[${h.timestamp}] ${h.level.toUpperCase()} [${h.category}] ${h.message}`
        ).join('\n')
    }

    /**
     * Mide el tiempo de una operación
     */
    time(label) {
        const start = Date.now()
        return {
            end: (message) => {
                const duration = Date.now() - start
                this.debug(`${message || label}: ${duration}ms`, { duration, label })
                return duration
            }
        }
    }

    /**
     * Log condicional
     */
    if(condition, level, message, data) {
        if (condition) {
            this[level](message, data)
        }
    }

    /**
     * Log con rate limiting
     */
    throttle(key, message, data, intervalMs = 5000) {
        if (!this._throttleCache) {
            this._throttleCache = new Map()
        }

        const now = Date.now()
        const lastLog = this._throttleCache.get(key) || 0

        if (now - lastLog >= intervalMs) {
            this._throttleCache.set(key, now)
            this.info(message, data)
        }
    }
}

/**
 * Crea un logger preconfigurado para Ryze
 */
function createLogger(options = {}) {
    return new RyzeLogger({
        level: process.env.LOG_LEVEL || 'info',
        prettyPrint: process.env.NODE_ENV !== 'production',
        ...options
    })
}

/**
 * Logger por defecto
 */
const defaultLogger = createLogger({ category: 'ryze' })

exports.LOG_LEVELS = LOG_LEVELS
exports.COLORS = COLORS
exports.CATEGORY_ICONS = CATEGORY_ICONS
exports.RyzeLogger = RyzeLogger
exports.createLogger = createLogger
exports.default = defaultLogger
