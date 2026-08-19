"use strict"

/**
 * Enhanced Session Cache for Ryze
 * Sistema de caché optimizado para sesiones
 */

Object.defineProperty(exports, "__esModule", { value: true })

const LRUCache_1 = require("lru-cache")
const promises_1 = require("fs/promises")
const path_1 = require("path")

// Configuración de caché
const CACHE_CONFIG = {
    // Caché en memoria
    MEMORY: {
        MAX_SIZE: 10000,
        TTL: 30 * 60 * 1000,  // 30 minutos
        STALE_TTL: 5 * 60 * 1000  // 5 minutos stale
    },
    
    // Caché de sesiones Signal
    SIGNAL: {
        MAX_SIZE: 5000,
        TTL: 60 * 60 * 1000  // 1 hora
    },
    
    // Caché de grupos
    GROUPS: {
        MAX_SIZE: 500,
        TTL: 15 * 60 * 1000  // 15 minutos
    },
    
    // Caché de perfiles
    PROFILES: {
        MAX_SIZE: 1000,
        TTL: 60 * 60 * 1000  // 1 hora
    },
    
    // Persistencia
    PERSIST_INTERVAL: 5 * 60 * 1000,  // 5 minutos
    PERSIST_ON_SIZE: 100  // Persistir cuando hay 100 cambios
}

/**
 * Caché multi-nivel con persistencia
 */
class EnhancedCache {
    constructor(name, options = {}) {
        this.name = name
        this.options = { ...CACHE_CONFIG.MEMORY, ...options }
        this.persistPath = options.persistPath
        this.dirty = new Set()
        this.persistTimer = null
        this.stats = {
            hits: 0,
            misses: 0,
            sets: 0,
            deletes: 0
        }

        // Caché principal LRU
        this.cache = new LRUCache_1.LRUCache({
            max: this.options.MAX_SIZE,
            ttl: this.options.TTL,
            allowStale: true,
            updateAgeOnGet: true,
            updateAgeOnHas: true
        })

        // Caché de hot keys (acceso frecuente)
        this.hotCache = new Map()
        this.hotCacheMaxSize = Math.floor(this.options.MAX_SIZE * 0.1)
        this.accessCount = new Map()

        if (this.persistPath) {
            this._startPersistence()
        }
    }

    /**
     * Obtiene un valor
     */
    get(key) {
        // Primero buscar en hot cache
        if (this.hotCache.has(key)) {
            this.stats.hits++
            this._trackAccess(key)
            return this.hotCache.get(key)
        }

        // Buscar en caché principal
        const value = this.cache.get(key)
        
        if (value !== undefined) {
            this.stats.hits++
            this._trackAccess(key)
            
            // Promocionar a hot cache si es frecuentemente accedido
            if (this._isHotKey(key)) {
                this._addToHotCache(key, value)
            }
            
            return value
        }

        this.stats.misses++
        return undefined
    }

    /**
     * Establece un valor
     */
    set(key, value, ttl = undefined) {
        this.cache.set(key, value, { ttl: ttl || this.options.TTL })
        this.stats.sets++
        
        // Actualizar hot cache si existe
        if (this.hotCache.has(key)) {
            this.hotCache.set(key, value)
        }

        // Marcar como dirty para persistencia
        if (this.persistPath) {
            this.dirty.add(key)
            
            if (this.dirty.size >= CACHE_CONFIG.PERSIST_ON_SIZE) {
                this._persist()
            }
        }
    }

    /**
     * Elimina un valor
     */
    delete(key) {
        this.cache.delete(key)
        this.hotCache.delete(key)
        this.accessCount.delete(key)
        this.dirty.delete(key)
        this.stats.deletes++
    }

    /**
     * Verifica si existe
     */
    has(key) {
        return this.hotCache.has(key) || this.cache.has(key)
    }

    /**
     * Obtiene múltiples valores
     */
    getMany(keys) {
        const result = {}
        const missing = []

        for (const key of keys) {
            const value = this.get(key)
            if (value !== undefined) {
                result[key] = value
            } else {
                missing.push(key)
            }
        }

        return { found: result, missing }
    }

    /**
     * Establece múltiples valores
     */
    setMany(entries) {
        for (const [key, value] of Object.entries(entries)) {
            this.set(key, value)
        }
    }

    /**
     * Rastreo de accesos para hot cache
     */
    _trackAccess(key) {
        const count = (this.accessCount.get(key) || 0) + 1
        this.accessCount.set(key, count)

        // Limpiar accesos antiguos periódicamente
        if (this.accessCount.size > this.options.MAX_SIZE) {
            this._cleanupAccessCount()
        }
    }

    /**
     * Determina si una key es "hot"
     */
    _isHotKey(key) {
        const count = this.accessCount.get(key) || 0
        return count >= 3
    }

    /**
     * Agrega al hot cache
     */
    _addToHotCache(key, value) {
        if (this.hotCache.size >= this.hotCacheMaxSize) {
            // Eliminar la entrada menos accedida
            let minKey = null
            let minCount = Infinity

            for (const [k] of this.hotCache) {
                const count = this.accessCount.get(k) || 0
                if (count < minCount) {
                    minCount = count
                    minKey = k
                }
            }

            if (minKey) {
                this.hotCache.delete(minKey)
            }
        }

        this.hotCache.set(key, value)
    }

    /**
     * Limpia el contador de accesos
     */
    _cleanupAccessCount() {
        const entries = [...this.accessCount.entries()]
        entries.sort((a, b) => b[1] - a[1])
        
        this.accessCount.clear()
        entries.slice(0, this.options.MAX_SIZE / 2).forEach(([k, v]) => {
            this.accessCount.set(k, Math.floor(v / 2))  // Decay
        })
    }

    /**
     * Inicia la persistencia automática
     */
    _startPersistence() {
        this.persistTimer = setInterval(() => {
            if (this.dirty.size > 0) {
                this._persist()
            }
        }, CACHE_CONFIG.PERSIST_INTERVAL)
    }

    /**
     * Persiste el caché a disco
     */
    async _persist() {
        if (!this.persistPath || this.dirty.size === 0) return

        try {
            const data = {}
            for (const key of this.dirty) {
                const value = this.cache.get(key)
                if (value !== undefined) {
                    data[key] = value
                }
            }

            const filePath = path_1.join(this.persistPath, `${this.name}-cache.json`)
            
            // Leer datos existentes
            let existing = {}
            try {
                const content = await promises_1.readFile(filePath, 'utf8')
                existing = JSON.parse(content)
            } catch {}

            // Merge con nuevos datos
            const merged = { ...existing, ...data }
            
            await promises_1.writeFile(filePath, JSON.stringify(merged), 'utf8')
            this.dirty.clear()

        } catch (error) {
            console.error('Cache persist error:', error)
        }
    }

    /**
     * Carga el caché desde disco
     */
    async load() {
        if (!this.persistPath) return

        try {
            const filePath = path_1.join(this.persistPath, `${this.name}-cache.json`)
            const content = await promises_1.readFile(filePath, 'utf8')
            const data = JSON.parse(content)

            for (const [key, value] of Object.entries(data)) {
                this.cache.set(key, value)
            }

        } catch (error) {
            // Archivo no existe, está bien
        }
    }

    /**
     * Obtiene estadísticas
     */
    getStats() {
        const hitRate = this.stats.hits / (this.stats.hits + this.stats.misses) || 0
        
        return {
            ...this.stats,
            hitRate: (hitRate * 100).toFixed(2) + '%',
            size: this.cache.size,
            hotCacheSize: this.hotCache.size,
            dirtyKeys: this.dirty.size
        }
    }

    /**
     * Limpia todo el caché
     */
    clear() {
        this.cache.clear()
        this.hotCache.clear()
        this.accessCount.clear()
        this.dirty.clear()
    }

    /**
     * Limpieza
     */
    cleanup() {
        if (this.persistTimer) {
            clearInterval(this.persistTimer)
        }
        this._persist()
        this.clear()
    }
}

/**
 * Gestor de cachés para diferentes tipos de datos
 */
class CacheManager {
    constructor(baseDir, logger) {
        this.baseDir = baseDir
        this.logger = logger
        
        this.caches = {
            signal: new EnhancedCache('signal', { 
                ...CACHE_CONFIG.SIGNAL,
                persistPath: baseDir 
            }),
            groups: new EnhancedCache('groups', { 
                ...CACHE_CONFIG.GROUPS,
                persistPath: baseDir 
            }),
            profiles: new EnhancedCache('profiles', { 
                ...CACHE_CONFIG.PROFILES,
                persistPath: baseDir 
            }),
            messages: new EnhancedCache('messages', CACHE_CONFIG.MEMORY),
            misc: new EnhancedCache('misc', CACHE_CONFIG.MEMORY)
        }
    }

    /**
     * Carga todos los cachés desde disco
     */
    async loadAll() {
        await Promise.all([
            this.caches.signal.load(),
            this.caches.groups.load(),
            this.caches.profiles.load()
        ])
        this.logger?.info('All caches loaded')
    }

    /**
     * Obtiene un caché específico
     */
    getCache(name) {
        return this.caches[name]
    }

    /**
     * Obtiene estadísticas de todos los cachés
     */
    getAllStats() {
        const stats = {}
        for (const [name, cache] of Object.entries(this.caches)) {
            stats[name] = cache.getStats()
        }
        return stats
    }

    /**
     * Limpia todos los cachés
     */
    clearAll() {
        for (const cache of Object.values(this.caches)) {
            cache.clear()
        }
    }

    /**
     * Limpieza
     */
    async cleanup() {
        for (const cache of Object.values(this.caches)) {
            cache.cleanup()
        }
    }
}

exports.CACHE_CONFIG = CACHE_CONFIG
exports.EnhancedCache = EnhancedCache
exports.CacheManager = CacheManager
