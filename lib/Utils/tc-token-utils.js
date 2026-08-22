"use strict"

Object.defineProperty(exports, "__esModule", { value: true })


const TC_TOKEN_INDEX_KEY = 'tc_token_index'


const buildTcTokenFromJid = (jid, creds) => {
    if (!jid || !creds?.me?.id) return null

    return {
        jid,
        senderTimestamp: Date.now(),
        sender: creds.me.id
    }
}


const isTcTokenExpired = (token, maxAgeMs = 24 * 60 * 60 * 1000) => {
    if (!token?.senderTimestamp) return true

    const age = Date.now() - token.senderTimestamp
    return age > maxAgeMs
}


const storeTcTokensFromIqResult = async (result, keys) => {
    if (!result || !keys) return

    
    const tokenNodes = result?.content || []
    const tokensToStore = {}
    for (const node of tokenNodes) {
        if (node?.tag === 'token' && node?.attrs?.jid) {
            const jid = node.attrs.jid
            const token = node.content
            if (token) {
                tokensToStore[jid] = token
            }
        }
    }
    if (Object.keys(tokensToStore).length > 0) {
        await keys.set({ 'tc_token': tokensToStore })
    }
}


const shouldSendNewTcToken = async (jid, keys, maxAgeMs = 60 * 60 * 1000) => {
    if (!jid || !keys) return true

    const { [jid]: existing } = await keys.get('tc_token', [jid])
    if (!existing) return true

    return isTcTokenExpired(existing, maxAgeMs)
}


const resolveIssuanceJid = (jid, creds) => {
    if (!jid) return null
    
    if (jid.includes('@lid') && creds?.me?.id) {
        return creds.me.id
    }
    return jid
}


const readTcTokenIndex = async (keys) => {
    if (!keys) return {}
    const { [TC_TOKEN_INDEX_KEY]: index } = await keys.get('tc_token_index', [TC_TOKEN_INDEX_KEY])
    return index || {}
}


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
