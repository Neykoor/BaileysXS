"use strict"

Object.defineProperty(exports, "__esModule", { value: true })

const boom_1 = require("@hapi/boom")
const WAProto_1 = require("../../WAProto")
const WABinary_1 = require("../WABinary")
const generics_1 = require("./generics")
const messages_1 = require("./messages") 

const NO_MESSAGE_FOUND_ERROR_TEXT = 'Message absent from node'

const MISSING_KEYS_ERROR_TEXT = 'Key used already or never filled'

const DECRYPTION_RETRY_CONFIG = {
    maxRetries: 3,
    baseDelayMs: 100,
    sessionRecordErrors: ['No session record', 'SessionError: No session record', 'No sessions', 'SessionError: No sessions']
}

const NACK_REASONS = {
    ParsingError: 487,
    UnrecognizedStanza: 488,
    UnrecognizedStanzaClass: 489,
    UnrecognizedStanzaType: 490,
    InvalidProtobuf: 491,
    InvalidHostedCompanionStanza: 493,
    MissingMessageSecret: 495,
    SignalErrorOldCounter: 496,
    MessageDeletedOnPeer: 499,
    UnhandledError: 500,
    UnsupportedAdminRevoke: 550,
    UnsupportedLIDGroup: 551,
    DBOperationFailed: 552
}

const MESSAGE_TYPE_BLACKLIST = new Set(['senderKeyDistributionMessage', 'messageContextInfo'])

function getTypeMessage(message) {
    const keys = Object.keys(message)
    const len = keys.length
    
    if (len === 1) return keys[0]
    
    for (let i = 0; i < len; i++) {
        const key = keys[i]
        if (!MESSAGE_TYPE_BLACKLIST.has(key)) {
            return key
        }
    }
    
    // Fallback
    return keys[len - 1] || keys[0]
}

function decodeMessageNode(stanza, meId, meLid) {
    let msg_type
    let chat_id
    let author
    const msgId = stanza.attrs.id
    const from = stanza.attrs.from
    // PARCHE: un usuario que solo tiene username (sin numero) no trae `participant_pn`,
    // asi que `participant` quedaba undefined y mas abajo saltaba
    // "No participant in group message": su mensaje nunca se decodificaba.
    // Se cae al LID, que ese usuario si tiene siempre.
    const participant = stanza.attrs.addressing_mode === "lid" ? (stanza.attrs.participant_pn || stanza.attrs.participant)
        : stanza.attrs.addressing_mode === "pn" ? (stanza.attrs.participant || stanza.attrs.participant_lid)
        : stanza.attrs.sender_pn || stanza.attrs.participant_pn || stanza.attrs.participant || stanza.attrs.participant_lid;
    const participant_lid = stanza.attrs.addressing_mode === "lid" ? stanza.attrs.participant 
        : stanza.attrs.addressing_mode === "pn" ? stanza.attrs.participant_lid 
        : stanza.attrs.participant_lid || from;
    const recipient = stanza.attrs.recipient
    const isMe = (jid) => WABinary_1.areJidsSameUser(jid, meId)
    const isMeLid = (jid) => WABinary_1.areJidsSameUser(jid, meLid)
    if (WABinary_1.isJidUser(from)) {
        if (recipient) {
            if (!isMe(from)) {
                throw new boom_1.Boom('receipient present, but msg not from me', { data: stanza })
            }
            chat_id = recipient
        } else {
            chat_id = from
        }
        msg_type = 'chat'
        author = from
    } else if (WABinary_1.isLidUser(from)) {
        if (recipient) {
            if (!isMeLid(from)) {
                throw new boom_1.Boom('receipient present, but msg not from me', { data: stanza })
            }
            chat_id = recipient
        } else {
            chat_id = from
        }
        msg_type = 'chat'
        author = from
    } else if (WABinary_1.isJidGroup(from)) {
        if (!participant) {
            throw new boom_1.Boom('No participant in group message')
        }
        msg_type = 'group'
        author = participant
        chat_id = from
    } else if (WABinary_1.isJidBroadcast(from)) {
        if (!participant) {
            throw new boom_1.Boom('No participant in group message')
        }
        const isParticipantMe = isMe(participant)
        if (WABinary_1.isJidStatusBroadcast(from)) {
            msg_type = isParticipantMe ? 'direct_peer_status' : 'other_status'
        } else {
            msg_type = isParticipantMe ? 'peer_broadcast' : 'other_broadcast'
        }
        chat_id = from
        author = participant
    } else if (WABinary_1.isJidNewsletter(from)) {
        msg_type = 'newsletter'
        chat_id = from
        author = from
    } else {
        throw new boom_1.Boom('Unknown message type', { data: stanza })
    }

    if (!WABinary_1.isJidGroup(chat_id) && WABinary_1.isLidUser(chat_id)) {
        chat_id = stanza.attrs.sender_pn || stanza.attrs.peer_recipient_pn;
    }

    const fromMe = WABinary_1.isJidNewsletter(from) ? !!stanza.attrs?.is_sender : WABinary_1.isLidUser(from) ? isMeLid(participant || stanza.attrs.from) : isMe(participant || stanza.attrs.from)
    const pushname = stanza?.attrs?.notify
    const key = {
        remoteJid: chat_id,
        fromMe,
        id: msgId,
        participant: WABinary_1.jidNormalizedUser(participant),
        participant_lid: WABinary_1.jidNormalizedUser(participant_lid),
    }
    const fullMessage = {
        key,
        messageTimestamp: +stanza.attrs.t,
        pushName: pushname,
        broadcast: WABinary_1.isJidBroadcast(from), 
        newsletter: WABinary_1.isJidNewsletter(from) 
    }
    if (msg_type === 'newsletter') {
        fullMessage.newsletter_server_id  = +stanza.attrs?.server_id
    }
    if (key.fromMe) {
        fullMessage.status = WAProto_1.proto.WebMessageInfo.Status.SERVER_ACK
    }
    if (!key.fromMe) {
        fullMessage.platform = messages_1.getDevice(key.id) 
    }
    return {
        fullMessage,
        author,
        sender: msg_type === 'chat' ? author : chat_id
    }
}

/**
 * Optimized message serialization with batch LID lookups
 */
const serializeMessage = async (msg, repository) => {
    const mtype = getTypeMessage(msg)
    const message = msg?.[mtype]
    if (!message) return
    
    const contextInfo = message?.contextInfo
    if (!contextInfo) return

    // Collect all LIDs that need to be resolved
    const lidsToResolve = []
    
    const participant = contextInfo?.participant
    if (typeof participant === "string" && participant.endsWith('@lid')) {
        lidsToResolve.push({ type: 'participant', lid: participant })
    }

    const mentionedJid = contextInfo?.mentionedJid
    if (Array.isArray(mentionedJid)) {
        for (let i = 0; i < mentionedJid.length; i++) {
            const mentioned_lid = mentionedJid[i]
            if (typeof mentioned_lid === "string" && mentioned_lid.endsWith('@lid')) {
                lidsToResolve.push({ type: 'mention', lid: mentioned_lid, index: i })
            }
        }
    }

    if (lidsToResolve.length > 0) {
        const lidPromises = lidsToResolve.map(async (item) => {
            const pn = await repository.lidMapping.getPNForLID(item.lid)
            return { ...item, pn }
        })
        
        const results = await Promise.all(lidPromises)
        
        for (const result of results) {
            if (!result.pn) continue
            
            const normalizedPn = WABinary_1.jidNormalizedUser(result.pn)
            
            if (result.type === 'participant') {
                msg[mtype].contextInfo.participant = normalizedPn
            } else if (result.type === 'mention') {
                if (msg[mtype]?.contextInfo?.mentionedJid) {
                    msg[mtype].contextInfo.mentionedJid[result.index] = normalizedPn
                }
                // Update text references
                const lidUser = result.lid.split("@")[0]
                const pnUser = normalizedPn.split("@")[0]
                if (msg[mtype]?.text) {
                    msg[mtype].text = msg[mtype].text.replace(new RegExp(`@${lidUser}`, "g"), `@${pnUser}`)
                } else if (msg[mtype]?.caption) {
                    msg[mtype].caption = msg[mtype].caption.replace(new RegExp(`@${lidUser}`, "g"), `@${pnUser}`)
                }
            }
        }
    }

    // Process quoted message recursively
    const quotedMessage = contextInfo?.quotedMessage
    if (quotedMessage) {
        await serializeMessage(quotedMessage, repository)
    }
}

const decryptMessageNode = (stanza, meId, meLid, repository, logger) => {
    const { fullMessage, author, sender } = decodeMessageNode(stanza, meId, meLid)
    return {
        fullMessage,
        category: stanza.attrs.category,
        author,
        async decrypt() {
            let decryptables = 0
            if (Array.isArray(stanza.content)) {
                for (const { tag, attrs, content } of stanza.content) {
                    if (tag === 'verified_name' && content instanceof Uint8Array) {
                        const cert = WAProto_1.proto.VerifiedNameCertificate.decode(content)
                        const details = WAProto_1.proto.VerifiedNameCertificate.Details.decode(cert.details)
                        fullMessage.verifiedBizName = details.verifiedName
                    }
                    if (tag === 'unavailable' && attrs.type === 'view_once') {
                        fullMessage.key.isViewOnce = true;
                    }
                    if (tag !== 'enc' && tag !== 'plaintext') {
                        continue
                    }
                    if (!(content instanceof Uint8Array)) {
                        continue
                    }
                    decryptables += 1
                    let msgBuffer
                    const user = WABinary_1.isJidUser(sender) ? sender : author
                    try {
                        const e2eType = tag === 'plaintext' ? 'plaintext' : attrs.type
                        switch (e2eType) {
                            case 'skmsg':
                                msgBuffer = await repository.decryptGroupMessage({
                                    group: sender,
                                    authorJid: author,
                                    msg: content
                                })
                                break
                            case 'pkmsg':
                            case 'msg':
                                msgBuffer = await repository.decryptMessage({
                                    jid: user,
                                    type: e2eType,
                                    ciphertext: content
                                })
                                break
                            case 'plaintext':
                                msgBuffer = content
                                break
                            default:
                                throw new Error(`Unknown e2e type: ${e2eType}`)
                        }
                        let msg = WAProto_1.proto.Message.decode(e2eType !== 'plaintext' ? generics_1.unpadRandomMax16(msgBuffer) : msgBuffer)
                        msg = msg.deviceSentMessage?.message || msg
                        if (msg.senderKeyDistributionMessage) {
                            try {
                                await repository.processSenderKeyDistributionMessage({
                                    authorJid: author,
                                    item: msg.senderKeyDistributionMessage
                                })
                            } catch (err) {
                                logger.error({ key: fullMessage.key, err }, 'failed to decrypt message')
                            }
                        }
                        if (fullMessage.message) {
                            Object.assign(fullMessage.message, msg)
                        } else {
                            fullMessage.message = msg
                        }
                        if (fullMessage.message) {
                            await serializeMessage(fullMessage.message, repository)
                        }
                    } catch (err) {
                        const errorContext = {
                            key: fullMessage.key,
                            err,
                            messageType: tag === 'plaintext' ? 'plaintext' : attrs.type,
                            sender,
                            author,
                            isSessionRecordError: isSessionRecordError(err)
                        }
                        logger.error(errorContext, 'failed to process sender key distribution message')
                        fullMessage.messageStubType = WAProto_1.proto.WebMessageInfo.StubType.CIPHERTEXT
                        fullMessage.messageStubParameters = [err.message.toString()]
                    }
                }
            }
            
            if (!decryptables) {
                fullMessage.messageStubType = WAProto_1.proto.WebMessageInfo.StubType.CIPHERTEXT
                fullMessage.messageStubParameters = [NO_MESSAGE_FOUND_ERROR_TEXT]
            }
        }
    }
}

function isSessionRecordError(error) {
    const errorMessage = error?.message || error?.toString() || ''
    return DECRYPTION_RETRY_CONFIG.sessionRecordErrors.some(errorPattern => errorMessage.includes(errorPattern))
}

// === SERVER_ERROR_CODES (from official Baileys) ===
const SERVER_ERROR_CODES = {
    MessageAccountRestriction: '463',
    SmaxInvalid: '479'
}

// === extractAddressingContext (from official Baileys) ===
// Extracts LID/PN addressing context from a message node for proper sender resolution
const extractAddressingContext = (node) => {
    const attrs = node?.attrs || {}
    const participant = attrs.participant
    const participantPn = attrs.participant_pn
    const participantLid = attrs.participant_lid
    const participantUsername = attrs.participant_username
    const addressingMode = attrs.addressing_mode

    return {
        participant,
        participantPn,
        participantLid,
        participantUsername,
        addressingMode
    }
}

module.exports = {
  NACK_REASONS,
  decodeMessageNode,
  decryptMessageNode,
  MISSING_KEYS_ERROR_TEXT,
  DECRYPTION_RETRY_CONFIG,
  NO_MESSAGE_FOUND_ERROR_TEXT,
  SERVER_ERROR_CODES,
  extractAddressingContext
}
