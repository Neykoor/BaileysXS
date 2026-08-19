"use strict"

var __createBinding = (this && this.__createBinding) || (Object.create ? (function (o, m, k, k2) {
    if (k2 === undefined) k2 = k
    var desc = Object.getOwnPropertyDescriptor(m, k)
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
        desc = { enumerable: true, get: function () { return m[k] } }
    }
    Object.defineProperty(o, k2, desc)
}) : (function (o, m, k, k2) {
    if (k2 === undefined) k2 = k
    o[k2] = m[k]
}))
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function (o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v })
}) : function (o, v) {
    o["default"] = v
})
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function (o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = []
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k
            return ar
        }
        return ownKeys(o)
    }
    return function (mod) {
        if (mod && mod.__esModule) return mod
        var result = {}
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i])
        __setModuleDefault(result, mod)
        return result
    }
})()
Object.defineProperty(exports, "__esModule", { value: true })
exports.makeLibSignalRepository = makeLibSignalRepository

const libsignal = __importStar(require("libsignal"))
const Utils_1 = require("../Utils")
const WABinary_1 = require("../WABinary")
const sender_key_name_1 = require("./Group/sender-key-name")
const sender_key_record_1 = require("./Group/sender-key-record")
const Group_1 = require("./Group")
const LIDMappingStore_1 = require("./lid-mapping")

let PreKeyWhisperMessage
try {
    PreKeyWhisperMessage = require("libsignal/src/protobufs").PreKeyWhisperMessage
} catch {
    PreKeyWhisperMessage = null
}

function extractIdentityFromPkmsg(ciphertext) {
    try {
        if (!PreKeyWhisperMessage) return undefined
        if (!ciphertext || ciphertext.length < 2) return undefined
        const version = ciphertext[0]
        if ((version & 0xf) !== 3) return undefined
        const proto = PreKeyWhisperMessage.decode(ciphertext.slice(1))
        if (proto.identityKey?.length === 33) {
            return new Uint8Array(proto.identityKey)
        }
        return undefined
    } catch {
        return undefined
    }
}

function makeLibSignalRepository(auth, onWhatsAppFunc, logger) {
    const lidMapping = new LIDMappingStore_1.LIDMappingStore(auth.keys, onWhatsAppFunc, logger)
    const storage = signalStorage(auth, lidMapping)
    const parsedKeys = auth.keys

    const hasTransaction = typeof parsedKeys.transaction === 'function'
    const runInTransaction = async (work, key) => {
        if (hasTransaction) {
            return parsedKeys.transaction(work, key)
        }
        return work()
    }

    return {
        lidMapping,

        clearCaches() {
            // kept for backwards compat - storage uses live reads now
        },

        async validateSession(jid) {
            try {
                const addr = jidToSignalProtocolAddress(jid)
                const session = await storage.loadSession(addr.toString())
                if (!session) {
                    return { exists: false, reason: 'no session' }
                }
                if (typeof session.haveOpenSession === 'function' && !session.haveOpenSession()) {
                    return { exists: false, reason: 'no open session' }
                }
                return { exists: true }
            } catch (err) {
                logger?.warn?.({ jid, err: err.message }, 'validateSession failed')
                return { exists: false, reason: 'validation error' }
            }
        },

        decryptGroupMessage({ group, authorJid, msg }) {
            const senderName = jidToSignalSenderKeyName(group, authorJid)
            const cipher = new Group_1.GroupCipher(storage, senderName)
            return runInTransaction(async () => cipher.decrypt(msg), group)
        },

        async processSenderKeyDistributionMessage({ item, authorJid }) {
            if (!item.groupId) {
                throw new Error('Group ID is required for sender key distribution message')
            }
            const senderName = jidToSignalSenderKeyName(item.groupId, authorJid)
            const senderMsg = new Group_1.SenderKeyDistributionMessage(
                null, null, null, null,
                item.axolotlSenderKeyDistributionMessage
            )
            const senderNameStr = senderName.toString()

            const { [senderNameStr]: existing } = await auth.keys.get('sender-key', [senderNameStr])
            if (!existing) {
                await storage.storeSenderKey(senderName, new sender_key_record_1.SenderKeyRecord())
            }

            return runInTransaction(async () => {
                const { [senderNameStr]: stored } = await auth.keys.get('sender-key', [senderNameStr])
                if (!stored) {
                    await storage.storeSenderKey(senderName, new sender_key_record_1.SenderKeyRecord())
                }
                const builder = new Group_1.GroupSessionBuilder(storage)
                await builder.process(senderName, senderMsg)
            }, item.groupId)
        },

        async decryptMessage({ jid, type, ciphertext }) {
            const addr = jidToSignalProtocolAddress(jid)
            const session = new libsignal.SessionCipher(storage, addr)

            if (type === 'pkmsg') {
                const identityKey = extractIdentityFromPkmsg(ciphertext)
                if (identityKey) {
                    try {
                        const changed = await storage.saveIdentity(addr.toString(), identityKey)
                        if (changed) {
                            logger?.info?.({ jid }, 'identity key changed or new contact')
                        }
                    } catch (e) {
                        logger?.warn?.({ jid, err: e.message }, 'saveIdentity failed')
                    }
                }
            }

            return runInTransaction(async () => {
                switch (type) {
                    case 'pkmsg':
                        return await session.decryptPreKeyWhisperMessage(ciphertext)
                    case 'msg':
                        return await session.decryptWhisperMessage(ciphertext)
                    default:
                        throw new Error(`Unknown message type: ${type}`)
                }
            }, jid)
        },

        async encryptMessage({ jid, data }) {
            const addr = jidToSignalProtocolAddress(jid)
            const cipher = new libsignal.SessionCipher(storage, addr)

            return runInTransaction(async () => {
                const { type: sigType, body } = await cipher.encrypt(data)
                const type = sigType === 3 ? 'pkmsg' : 'msg'
                return { type, ciphertext: Buffer.from(body, 'binary') }
            }, jid)
        },

        async encryptGroupMessage({ group, meId, data }) {
            const senderName = jidToSignalSenderKeyName(group, meId)
            const senderNameStr = senderName.toString()

            return runInTransaction(async () => {
                const { [senderNameStr]: existing } = await auth.keys.get('sender-key', [senderNameStr])
                if (!existing) {
                    await storage.storeSenderKey(senderName, new sender_key_record_1.SenderKeyRecord())
                }
                const builder = new Group_1.GroupSessionBuilder(storage)
                const skdm = await builder.create(senderName)
                const cipher = new Group_1.GroupCipher(storage, senderName)
                const ciphertext = await cipher.encrypt(data)
                return { ciphertext, senderKeyDistributionMessage: skdm.serialize() }
            }, group)
        },

        async getSenderKeyDistributionMessage({ group, meId }) {
            const senderName = jidToSignalSenderKeyName(group, meId)
            const senderNameStr = senderName.toString()
            return runInTransaction(async () => {
                const { [senderNameStr]: existing } = await auth.keys.get('sender-key', [senderNameStr])
                if (!existing) {
                    await storage.storeSenderKey(senderName, new sender_key_record_1.SenderKeyRecord())
                }
                const builder = new Group_1.GroupSessionBuilder(storage)
                const skdm = await builder.create(senderName)
                return skdm.serialize()
            }, group)
        },

        async hasSenderKey({ group, meId }) {
            const senderName = jidToSignalSenderKeyName(group, meId).toString()
            const { [senderName]: key } = await auth.keys.get('sender-key', [senderName])
            return !!key
        },

        async injectE2ESession({ jid, session }) {
            logger?.trace?.({ jid }, 'injecting E2EE session')
            const cipher = new libsignal.SessionBuilder(storage, jidToSignalProtocolAddress(jid))
            return runInTransaction(async () => {
                await cipher.initOutgoing(session)
            }, jid)
        },

        jidToSignalProtocolAddress(jid) {
            return jidToSignalProtocolAddress(jid).toString()
        },

        async deleteSession(jids) {
            if (!jids.length) return
            const sessionUpdates = {}
            for (const jid of jids) {
                const addr = jidToSignalProtocolAddress(jid)
                sessionUpdates[addr.toString()] = null
            }
            return runInTransaction(async () => {
                await auth.keys.set({ session: sessionUpdates })
            }, `delete-${jids.length}-sessions`)
        },

        async migrateSession(fromJid, toJid) {
            if (!fromJid || !toJid) return { migrated: 0, skipped: 0, total: 0 }
            if (!WABinary_1.isLidUser(toJid) && !WABinary_1.isHostedLidUser?.(toJid)) {
                return { migrated: 0, skipped: 0, total: 0 }
            }
            if (!WABinary_1.isPnUser?.(fromJid) && !WABinary_1.isHostedPnUser?.(fromJid)) {
                if (!fromJid.endsWith('@s.whatsapp.net') && !fromJid.endsWith('@hosted')) {
                    return { migrated: 0, skipped: 0, total: 1 }
                }
            }

            const decoded = WABinary_1.jidDecode(fromJid)
            if (!decoded) return { migrated: 0, skipped: 0, total: 0 }
            const { user } = decoded

            const { [user]: userDevices } = await auth.keys.get('device-list', [user])
            if (!userDevices) {
                return { migrated: 0, skipped: 0, total: 0 }
            }

            const fromDeviceStr = decoded?.device?.toString() || '0'
            if (!userDevices.includes(fromDeviceStr)) {
                userDevices.push(fromDeviceStr)
            }

            const deviceSessionKeys = userDevices.map(d => `${user}.${d}`)
            const existingSessions = await auth.keys.get('session', deviceSessionKeys)

            const deviceJids = []
            for (const [sessionKey, sessionData] of Object.entries(existingSessions)) {
                if (sessionData) {
                    const deviceStr = sessionKey.split('.')[1]
                    if (!deviceStr) continue
                    const deviceNum = parseInt(deviceStr)
                    let jid
                    if (deviceNum === 99) {
                        jid = `${user}:99@hosted`
                    } else if (deviceNum === 0) {
                        jid = `${user}@s.whatsapp.net`
                    } else {
                        jid = `${user}:${deviceNum}@s.whatsapp.net`
                    }
                    deviceJids.push(jid)
                }
            }

            if (deviceJids.length === 0) {
                return { migrated: 0, skipped: 0, total: 0 }
            }

            return runInTransaction(async () => {
                const sessionUpdates = {}
                let migratedCount = 0

                const pnAddrStrings = [...new Set(deviceJids.map(j => jidToSignalProtocolAddress(j).toString()))]
                const pnSessions = await auth.keys.get('session', pnAddrStrings)

                for (const jid of deviceJids) {
                    const fromAddr = jidToSignalProtocolAddress(jid)
                    const lidWithDevice = WABinary_1.transferDevice(jid, toJid)
                    const toAddr = jidToSignalProtocolAddress(lidWithDevice)
                    const pnAddrStr = fromAddr.toString()
                    const lidAddrStr = toAddr.toString()

                    const pnSession = pnSessions[pnAddrStr]
                    if (pnSession) {
                        try {
                            const fromSession = libsignal.SessionRecord.deserialize(pnSession)
                            if (fromSession.haveOpenSession()) {
                                sessionUpdates[lidAddrStr] = fromSession.serialize()
                                sessionUpdates[pnAddrStr] = null
                                migratedCount++
                            }
                        } catch (e) {
                            logger?.warn?.({ jid, err: e.message }, 'failed to migrate session')
                        }
                    }
                }

                if (Object.keys(sessionUpdates).length > 0) {
                    await auth.keys.set({ session: sessionUpdates })
                    logger?.debug?.({ migratedSessions: migratedCount }, 'bulk session migration complete')
                }

                const skippedCount = deviceJids.length - migratedCount
                return { migrated: migratedCount, skipped: skippedCount, total: deviceJids.length }
            }, `migrate-${deviceJids.length}-sessions-${WABinary_1.jidDecode(toJid)?.user}`)
        }
    }
}

const jidToSignalProtocolAddress = (jid) => {
    const decoded = WABinary_1.jidDecode(jid)
    if (!decoded) {
        throw new Error(`Invalid JID for Signal address: "${jid}"`)
    }
    const { user, device, server, domainType } = decoded

    if (!user) {
        throw new Error(`JID decoded but user is empty: "${jid}" -> user: "${user}", server: "${server}", device: ${device}`)
    }

    if (device === 99 && server !== 'hosted' && server !== 'hosted.lid') {
        throw new Error(`Unexpected non-hosted device JID with device 99: "${jid}"`)
    }

    const signalUser = domainType !== 0 ? `${user}_${domainType}` : user
    const finalDevice = device || 0

    return new libsignal.ProtocolAddress(signalUser, finalDevice)
}

const jidToSignalSenderKeyName = (group, user) => {
    return new sender_key_name_1.SenderKeyName(group, jidToSignalProtocolAddress(user))
}

function signalStorage(auth, lidMapping) {
    const { creds, keys } = auth

    // Resolve a stored signal address ("user[_domainType].device") to its LID
    // equivalent if a PN->LID mapping exists. This makes session lookups robust
    // when the same conversation alternates between PN and LID addressing.
    const resolveLIDSignalAddress = async (id) => {
        if (!lidMapping || !id || typeof id !== 'string' || !id.includes('.')) {
            return id
        }
        const [userPart, devicePart] = id.split('.')
        const [user, domainTypeStr] = userPart.split('_')
        const domainType = parseInt(domainTypeStr || '0')

        // Already a LID address - nothing to resolve
        if (domainType === WABinary_1.WAJIDDomains.LID || domainType === WABinary_1.WAJIDDomains.HOSTED_LID) {
            return id
        }

        const pnServer = domainType === WABinary_1.WAJIDDomains.HOSTED ? 'hosted' : 's.whatsapp.net'
        const pnJid = `${user}${devicePart && devicePart !== '0' ? `:${devicePart}` : ''}@${pnServer}`

        try {
            const lidForPN = await lidMapping.getLIDForPN(pnJid)
            if (lidForPN) {
                return jidToSignalProtocolAddress(lidForPN).toString()
            }
        } catch (e) {
            // mapping failed - fall back to original id
        }
        return id
    }

    return {
        loadSession: async (id) => {
            try {
                const wireJid = await resolveLIDSignalAddress(id)
                const { [wireJid]: sess } = await keys.get('session', [wireJid])
                if (sess) {
                    return libsignal.SessionRecord.deserialize(sess)
                }
            } catch {
                return null
            }
            return null
        },

        storeSession: async (id, session) => {
            const wireJid = await resolveLIDSignalAddress(id)
            await keys.set({ session: { [wireJid]: session.serialize() } })
        },

        isTrustedIdentity: () => true,

        loadIdentityKey: async (id) => {
            const wireJid = await resolveLIDSignalAddress(id)
            const { [wireJid]: key } = await keys.get('identity-key', [wireJid])
            return key || undefined
        },

        saveIdentity: async (id, identityKey) => {
            const wireJid = await resolveLIDSignalAddress(id)
            const { [wireJid]: existingKey } = await keys.get('identity-key', [wireJid])

            const keysMatch = existingKey?.length === identityKey.length
                && existingKey.every((b, i) => b === identityKey[i])

            if (existingKey && !keysMatch) {
                await keys.set({
                    session: { [wireJid]: null },
                    'identity-key': { [wireJid]: identityKey }
                })
                return true
            }

            if (!existingKey) {
                await keys.set({ 'identity-key': { [wireJid]: identityKey } })
                return true
            }

            return false
        },

        loadPreKey: async (id) => {
            const keyId = id.toString()
            const { [keyId]: key } = await keys.get('pre-key', [keyId])
            if (key) {
                return {
                    privKey: Buffer.from(key.private),
                    pubKey: Buffer.from(key.public)
                }
            }
        },

        removePreKey: (id) => keys.set({ 'pre-key': { [id]: null } }),

        loadSignedPreKey: () => {
            const key = creds.signedPreKey
            return {
                privKey: Buffer.from(key.keyPair.private),
                pubKey: Buffer.from(key.keyPair.public)
            }
        },

        loadSenderKey: async (senderKeyName) => {
            const keyId = senderKeyName.toString()
            const { [keyId]: key } = await keys.get('sender-key', [keyId])
            if (key) {
                return sender_key_record_1.SenderKeyRecord.deserialize(key)
            }
            return new sender_key_record_1.SenderKeyRecord()
        },

        storeSenderKey: async (senderKeyName, key) => {
            const keyId = senderKeyName.toString()
            const serialized = JSON.stringify(key.serialize())
            await keys.set({ 'sender-key': { [keyId]: Buffer.from(serialized, 'utf-8') } })
        },

        getOurRegistrationId: () => creds.registrationId,

        getOurIdentity: () => {
            const { signedIdentityKey } = creds
            return {
                privKey: Buffer.from(signedIdentityKey.private),
                pubKey: Utils_1.generateSignalPubKey(signedIdentityKey.public)
            }
        },

        clearStorageCache: () => {
            // no-op - kept for backwards compat
        }
    }
}
