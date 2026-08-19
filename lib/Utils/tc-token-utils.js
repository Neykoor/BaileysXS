"use strict"

Object.defineProperty(exports, "__esModule", { value: true })

// === TC Token Utils (from official Baileys) ===
// Trusted Contact Token management for presence subscription and privacy tokens

const TC_TOKEN_INDEX_KEY = 'tc_token_index'

/**
 * Build a TC token from a JID for presence subscription
 * @param {string} jid - The JID to build the token for
 * @param {Object} creds - Auth credentials containing me ID
 * @returns {Object|null} The tc token data or null
 */
const buildTcTokenFromJid = (jid, creds) => {
    if (!jid || !creds?.me?.id) return null

    return {
        jid,
        senderTimestamp: Date.now(),
        sender: creds.me.id
    }
}

/**
 * Check if a TC token has expired
 * @param {Object} token - The token to check
 * @param {number} maxAgeMs - Maximum age in milliseconds (default: 24h)
 * @returns {boolean} True if expired
 */
const isTcTokenExpired = (token, maxAgeMs = 24 * 60 * 60 * 1000) => {
    if (!token?.senderTimestamp) return true

    const age = Date.now() - token.senderTimestamp
    return age > maxAgeMs
}

/**
 * Store TC tokens from an IQ result
 * @param {Object} result - The IQ result node
 * @param {Object} keys - The auth keys store
 * @returns {Promise<void>}
 */
const storeTcTokensFromIqResult = async (result, keys) => {
    if (!result || !keys) return

    // Extract tokens from the result content
    const tokenNodes = result?.content || []
    for (const node of tokenNodes) {
        if (node?.tag === 'token' && node?.attrs?.jid) {
            const jid = node.attrs.jid
            const token = node.content
            if (token) {
                await keys.set({
                    'tc_token': { [jid]: token }
                })
            }
        }
    }
}

/**
 * Determine if a new TC token should be sent for the given JID
 * @param {string} jid - The JID to check
 * @param {Object} keys - The auth keys store
 * @param {number} maxAgeMs - Maximum age before refresh (default: 1h)
 * @returns {Promise<boolean>} True if a new token should be sent
 */
const shouldSendNewTcToken = async (jid, keys, maxAgeMs = 60 * 60 * 1000) => {
    if (!jid || !keys) return true

    const existing = await keys.get('tc_token', jid)
    if (!existing) return true

    return isTcTokenExpired(existing, maxAgeMs)
}

/**
 * Resolve the issuance JID for a TC token
 * @param {string} jid - The target JID
 * @param {Object} creds - Auth credentials
 * @returns {string} The JID to use for token issuance
 */
const resolveIssuanceJid = (jid, creds) => {
    if (!jid) return null
    // For LID users, resolve to PN if available
    if (jid.includes('@lid') && creds?.me?.id) {
        return creds.me.id
    }
    return jid
}

/**
 * Read the TC token index from the keys store
 * @param {Object} keys - The auth keys store
 * @returns {Promise<Object>} The token index map
 */
const readTcTokenIndex = async (keys) => {
    if (!keys) return {}
    return (await keys.get('tc_token_index')) || {}
}

/**
 * Build a merged TC token index write operation
 * @param {Object} existingIndex - The existing index
 * @param {string} jid - The JID to add/update
 * @param {Object} token - The token data
 * @returns {Object} The merged index
 */
const buildMergedTcTokenIndexWrite = (existingIndex, jid, token) => {
    return {
        ...existingIndex,
        [jid]: {
            ...token,
            updatedAt: Date.now()
        }
    }
}

module.exports = {
    TC_TOKEN_INDEX_KEY,
    buildTcTokenFromJid,
    isTcTokenExpired,
    storeTcTokensFromIqResult,
    shouldSendNewTcToken,
    resolveIssuanceJid,
    readTcTokenIndex,
    buildMergedTcTokenIndexWrite
}
