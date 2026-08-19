"use strict"

var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod }
}

Object.defineProperty(exports, "__esModule", { value: true })

const crypto_1 = require("crypto")
const node_cache_1 = __importDefault(require("@cacheable/node-cache"))
const Defaults_1 = require("../Defaults")
const LRUCache_1 = require("lru-cache") 
const crypto_2 = require("./crypto")
const generics_1 = require("./generics")
const mutex_1 = require("async-mutex") 

const OPTIMIZED_CACHE_CONFIG = {
    stdTTL: 10 * 60,
    useClones: false,
    deleteOnExpire: true,
    checkperiod: 60,
}

const hotKeyCache = new Map()
const HOT_KEY_MAX_SIZE = 500
const HOT_KEY_TTL = 30000

function makeCacheableSignalKeyStore(store, logger, _cache) {
    const cache = _cache || new node_cache_1.default(OPTIMIZED_CACHE_CONFIG)
    
    const cacheLock = new mutex_1.Semaphore(1)
    
    const keyAccessCount = new Map()
    const HOT_KEY_THRESHOLD = 3
    
    function getUniqueId(type, id) {
        return `${type}.${id}`
    }
    
    function isHotKey(uniqueId) {
        const count = keyAccessCount.get(uniqueId) || 0
        return count >= HOT_KEY_THRESHOLD
    }
    
    function trackKeyAccess(uniqueId) {
        const count = (keyAccessCount.get(uniqueId) || 0) + 1
        keyAccessCount.set(uniqueId, count)
        
        if (keyAccessCount.size > 1000) {
            const entries = [...keyAccessCount.entries()]
            entries.sort((a, b) => b[1] - a[1])
            keyAccessCount.clear()
            entries.slice(0, 500).forEach(([k, v]) => keyAccessCount.set(k, v))
        }
    }
    
    function getFromHotCache(uniqueId) {
        const entry = hotKeyCache.get(uniqueId)
        if (entry && Date.now() - entry.time < HOT_KEY_TTL) {
            return entry.value
        }
        hotKeyCache.delete(uniqueId)
        return undefined
    }
    
    function setHotCache(uniqueId, value) {
        if (hotKeyCache.size >= HOT_KEY_MAX_SIZE) {
            const entries = [...hotKeyCache.entries()]
            entries.sort((a, b) => a[1].time - b[1].time)
            entries.slice(0, 100).forEach(([k]) => hotKeyCache.delete(k))
        }
        hotKeyCache.set(uniqueId, { value, time: Date.now() })
    }
    
    return {
        async get(type, ids) {
            const data = {}
            const idsToFetch = []
            
            for (const id of ids) {
                const uniqueId = getUniqueId(type, id)
                trackKeyAccess(uniqueId)
                
                const hotValue = getFromHotCache(uniqueId)
                if (hotValue !== undefined) {
                    data[id] = hotValue
                    continue
                }
                
                const item = cache.get(uniqueId)
                if (typeof item !== 'undefined') {
                    data[id] = item
                    if (isHotKey(uniqueId)) {
                        setHotCache(uniqueId, item)
                    }
                } else {
                    idsToFetch.push(id)
                }
            }
            
            if (idsToFetch.length) {
                const [, release] = await cacheLock.acquire()
                try {
                    logger?.trace({ items: idsToFetch.length }, 'loading from store')
                    const fetched = await store.get(type, idsToFetch)
                    for (const id of idsToFetch) {
                        const item = fetched[id]
                        if (item) {
                            const uniqueId = getUniqueId(type, id)
                            data[id] = item
                            cache.set(uniqueId, item)
                            if (isHotKey(uniqueId)) {
                                setHotCache(uniqueId, item)
                            }
                        }
                    }
                } finally {
                    release()
                }
            }
            return data
        },
        async set(data) {
            const [, release] = await cacheLock.acquire()
            try {
                let keys = 0
                for (const type in data) {
                    for (const id in data[type]) {
                        const uniqueId = getUniqueId(type, id)
                        const value = data[type][id]
                        cache.set(uniqueId, value)
                        if (value !== null) {
                            setHotCache(uniqueId, value)
                        } else {
                            hotKeyCache.delete(uniqueId)
                        }
                        keys += 1
                    }
                }
                logger?.trace({ keys }, 'updated cache')
                await store.set(data)
            } finally {
                release()
            }
        },
        async clear() {
            hotKeyCache.clear()
            keyAccessCount.clear()
            await cache.flushAll()
            await store.clear?.call(store)
        }
    }
}

const preKeyMutex = new mutex_1.Mutex()
const signedPreKeyMutex = new mutex_1.Mutex()

/**
 * Get the appropriate mutex for the key type
 */
const getPreKeyMutex = (keyType) => {
    return keyType === 'signed-pre-key' ? signedPreKeyMutex : preKeyMutex
}

/**
 * Handles pre-key operations with mutex protection
 */
async function handlePreKeyOperations(data, keyType, transactionCache, mutations, logger, isInTransaction, state) {
    const mutex = getPreKeyMutex(keyType)
    await mutex.runExclusive(async () => {
        const keyData = data[keyType]
        if (!keyData)
            return
            
        transactionCache[keyType] = transactionCache[keyType] || {}
        mutations[keyType] = mutations[keyType] || {}
        
        const deletionKeys = []
        const updateKeys = []
        
        for (const keyId in keyData) {
            if (keyData[keyId] === null) {
                deletionKeys.push(keyId)
            }
            else {
                updateKeys.push(keyId)
            }
        }
        
        for (const keyId of updateKeys) {
            if (transactionCache[keyType]) {
                transactionCache[keyType][keyId] = keyData[keyId]
            }
            if (mutations[keyType]) {
                mutations[keyType][keyId] = keyData[keyId]
            }
        }
        
        if (deletionKeys.length === 0)
            return
            
        if (isInTransaction) {
            for (const keyId of deletionKeys) {
                if (transactionCache[keyType]) {
                    transactionCache[keyType][keyId] = null
                    if (mutations[keyType]) {
                        mutations[keyType][keyId] = null
                    }
                }
                else {
                    logger.warn(`Skipping deletion of non-existent ${keyType} in transaction: ${keyId}`)
                }
            }
            return
        }
        
        if (!state)
            return
            
        const existingKeys = await state.get(keyType, deletionKeys)
        for (const keyId of deletionKeys) {
            if (existingKeys[keyId]) {
                if (transactionCache[keyType])
                    transactionCache[keyType][keyId] = null
                if (mutations[keyType])
                    mutations[keyType][keyId] = null
            }
            else {
                logger.warn(`Skipping deletion of non-existent ${keyType}: ${keyId}`)
            }
        }
    })
}

/**
 * Handles normal key operations for transactions
 */
function handleNormalKeyOperations(data, key, transactionCache, mutations) {
    Object.assign(transactionCache[key], data[key])
    mutations[key] = mutations[key] || {}
    Object.assign(mutations[key], data[key])
}

/**
 * Process pre-key deletions with validation
 */
async function processPreKeyDeletions(data, keyType, state, logger) {
    const mutex = getPreKeyMutex(keyType)
    await mutex.runExclusive(async () => {
        const keyData = data[keyType]
        if (!keyData)
            return
            
        for (const keyId in keyData) {
            if (keyData[keyId] === null) {
                const existingKeys = await state.get(keyType, [keyId])
                if (!existingKeys[keyId]) {
                    logger.warn(`Skipping deletion of non-existent ${keyType}: ${keyId}`)
                    if (data[keyType])
                        delete data[keyType][keyId]
                }
            }
        }
    })
}

/**
 * Executes a function with mutexes acquired for given key types
 * Uses async-mutex's runExclusive with efficient batching
 */
async function withMutexes(keyTypes, getKeyTypeMutex, fn) {
    if (keyTypes.length === 0) {
        return fn()
    }
    
    if (keyTypes.length === 1) {
        return getKeyTypeMutex(keyTypes[0]).runExclusive(fn)
    }
    
    const sortedKeyTypes = [...keyTypes].sort()
    const mutexes = sortedKeyTypes.map(getKeyTypeMutex)
    
    const releases = []
    try {
        for (const mutex of mutexes) {
            releases.push(await mutex.acquire())
        }
        return await fn()
    }
    finally {
        while (releases.length > 0) {
            const release = releases.pop()
            if (release)
                release()
        }
    }
}

/**
 * Adds DB like transaction capability (https://en.wikipedia.org/wiki/Database_transaction) to the SignalKeyStore,
 * this allows batch read & write operations & improves the performance of the lib
 * @param state the key store to apply this capability to
 * @param logger logger to log events
 * @returns SignalKeyStore with transaction capability
 */
const addTransactionCapability = (state, logger, { maxCommitRetries, delayBetweenTriesMs }) => {
    let dbQueriesInTransaction = 0
    let transactionCache = {}
    let mutations = {}
    
    const mutexCache = new LRUCache_1.LRUCache({
        ttl: 60 * 60 * 1000,
        ttlAutopurge: true,
        updateAgeOnGet: true
    })
    
    let transactionsInProgress = 0
    
    function getKeyTypeMutex(type) {
        return getMutex(`keytype:${type}`)
    }
    
    function getSenderKeyMutex(senderKeyName) {
        return getMutex(`senderkey:${senderKeyName}`)
    }
    
    function getTransactionMutex(key) {
        return getMutex(`transaction:${key}`)
    }
    
    function getMutex(key) {
        let mutex = mutexCache.get(key)
        if (!mutex) {
            mutex = new mutex_1.Mutex()
            mutexCache.set(key, mutex)
            logger.info({ key }, 'created new mutex')
        }
        return mutex
    }
    
    function queueSenderKeyOperation(senderKeyName, operation) {
        return getSenderKeyMutex(senderKeyName).runExclusive(operation)
    }
    
    function isInTransaction() {
        return transactionsInProgress > 0
    }
    
    async function commitTransaction() {
        if (!Object.keys(mutations).length) {
            logger.trace('no mutations in transaction')
            return
        }
        logger.trace('committing transaction');
        let tries = maxCommitRetries
        while (tries > 0) {
            tries -= 1;
            try {
                await state.set(mutations)
                logger.trace({ dbQueriesInTransaction }, 'committed transaction')
                return
            }
            catch (error) {
                logger.warn(`failed to commit ${Object.keys(mutations).length} mutations, tries left=${tries}`)
                if (tries > 0) {
                    await generics_1.delay(delayBetweenTriesMs)
                }
            }
        }
    }
    
    function cleanupTransactionState() {
        transactionsInProgress -= 1
        if (transactionsInProgress === 0) {
            transactionCache = {}
            mutations = {}
            dbQueriesInTransaction = 0
        }
    }
    
    async function executeTransactionWork(work) {
        const result = await work()
        if (transactionsInProgress === 1) {
            await commitTransaction()
        }
        return result
    }
    
    return {
        get: async (type, ids) => {
            if (isInTransaction()) {
                const dict = transactionCache[type]
                const idsRequiringFetch = dict ? ids.filter(item => typeof dict[item] === 'undefined') : ids
                
                // only fetch if there are any items to fetch
                if (idsRequiringFetch.length) {
                    dbQueriesInTransaction += 1
                    
                    // Use per-sender-key queue for sender-key operations when possible
                    if (type === 'sender-key') {
                        logger.info({ idsRequiringFetch }, 'processing sender keys in transaction')
                        // For sender keys, process each one with queued operations to maintain serialization
                        for (const senderKeyName of idsRequiringFetch) {
                            await queueSenderKeyOperation(senderKeyName, async () => {
                                logger.info({ senderKeyName }, 'fetching sender key in transaction')
                                const result = await state.get(type, [senderKeyName])
                                // Update transaction cache
                                transactionCache[type] || (transactionCache[type] = {})
                                Object.assign(transactionCache[type], result)
                                logger.info({ senderKeyName, hasResult: !!result[senderKeyName] }, 'sender key fetch complete')
                            })
                        }
                    }
                    else {
                        // Use runExclusive for cleaner mutex handling
                        await getKeyTypeMutex(type).runExclusive(async () => {
                            const result = await state.get(type, idsRequiringFetch)
                            // Update transaction cache
                            transactionCache[type] || (transactionCache[type] = {})
                            Object.assign(transactionCache[type], result)
                        })
                    }
                }
                return ids.reduce((dict, id) => {
                    const value = transactionCache[type]?.[id]
                    if (value) {
                        dict[id] = value
                    }
                    return dict
                }, {})
            }
            else {
                // Not in transaction, fetch directly with queue protection
                if (type === 'sender-key') {
                    // For sender keys, use individual queues to maintain per-key serialization
                    const results = {}
                    for (const senderKeyName of ids) {
                        const result = await queueSenderKeyOperation(senderKeyName, async () => await state.get(type, [senderKeyName]))
                        Object.assign(results, result)
                    }
                    return results
                }
                else {
                    return await getKeyTypeMutex(type).runExclusive(() => state.get(type, ids))
                }
            }
        },
        set: async (data) => {
            if (isInTransaction()) {
                logger.trace({ types: Object.keys(data) }, 'caching in transaction')
                for (const key_ in data) {
                    const key = key_
                    transactionCache[key] = transactionCache[key] || {}
                    // Special handling for pre-keys and signed-pre-keys
                    if (key === 'pre-key') {
                        await handlePreKeyOperations(data, key, transactionCache, mutations, logger, true)
                    }
                    else {
                        // Normal handling for other key types
                        handleNormalKeyOperations(data, key, transactionCache, mutations)
                    }
                }
            }
            else {
                // Not in transaction, apply directly with mutex protection
                const hasSenderKeys = 'sender-key' in data
                const senderKeyNames = hasSenderKeys ? Object.keys(data['sender-key'] || {}) : []
                if (hasSenderKeys) {
                    logger.info({ senderKeyNames }, 'processing sender key set operations')
                    // Handle sender key operations with per-key queues
                    for (const senderKeyName of senderKeyNames) {
                        await queueSenderKeyOperation(senderKeyName, async () => {
                            // Create data subset for this specific sender key
                            const senderKeyData = {
                                'sender-key': {
                                    [senderKeyName]: data['sender-key'][senderKeyName]
                                }
                            };
                            logger.trace({ senderKeyName }, 'storing sender key')
                            // Apply changes to the store
                            await state.set(senderKeyData)
                            logger.trace({ senderKeyName }, 'sender key stored')
                        })
                    }
                    // Handle any non-sender-key data with regular mutexes
                    const nonSenderKeyData = { ...data }
                    delete nonSenderKeyData['sender-key']
                    if (Object.keys(nonSenderKeyData).length > 0) {
                        await withMutexes(Object.keys(nonSenderKeyData), getKeyTypeMutex, async () => {
                            // Process pre-keys and signed-pre-keys separately with specialized mutexes
                            for (const key_ in nonSenderKeyData) {
                                const keyType = key_
                                if (keyType === 'pre-key') {
                                    await processPreKeyDeletions(nonSenderKeyData, keyType, state, logger)
                                }
                            }
                            // Apply changes to the store
                            await state.set(nonSenderKeyData)
                        })
                    }
                }
                else {
                    // No sender keys - use original logic
                    await withMutexes(Object.keys(data), getKeyTypeMutex, async () => {
                        // Process pre-keys and signed-pre-keys separately with specialized mutexes
                        for (const key_ in data) {
                            const keyType = key_
                            if (keyType === 'pre-key') {
                                await processPreKeyDeletions(data, keyType, state, logger)
                            }
                        }
                        // Apply changes to the store
                        await state.set(data)
                    })
                }
            }
        },
        isInTransaction,
        async transaction(work, key) {
            const releaseTxMutex = await getTransactionMutex(key).acquire()
            try {
                transactionsInProgress += 1;
                if (transactionsInProgress === 1) {
                    logger.trace('entering transaction')
                }
                // Release the transaction mutex now that we've updated the counter
                // This allows other transactions to start preparing
                releaseTxMutex()
                try {
                    return await executeTransactionWork(work)
                }
                finally {
                    cleanupTransactionState();
                }
            }
            catch (error) {
                releaseTxMutex()
                throw error
            }
        }
    }
}

const initAuthCreds = () => {
    const identityKey = crypto_2.Curve.generateKeyPair()
    return {
        noiseKey: crypto_2.Curve.generateKeyPair(),
        pairingEphemeralKeyPair: crypto_2.Curve.generateKeyPair(),
        signedIdentityKey: identityKey,
        signedPreKey: crypto_2.signedKeyPair(identityKey, 1),
        registrationId: generics_1.generateRegistrationId(),
        advSecretKey: crypto_1.randomBytes(32).toString('base64'),
        processedHistoryMessages: [],
        nextPreKeyId: 1,
        firstUnuploadedPreKeyId: 1,
        accountSyncCounter: 0,
        accountSettings: {
            unarchiveChats: false
        },
        registered: false,
        pairingCode: undefined,
        lastPropHash: undefined,
        routingInfo: undefined,
        additionalData: undefined
    }
}

module.exports = {
  makeCacheableSignalKeyStore, 
  addTransactionCapability, 
  initAuthCreds
}
