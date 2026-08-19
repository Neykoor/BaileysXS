"use strict"

var __importDefault = (this && this.__importDefault) || function(mod) {
    return (mod && mod.__esModule) ? mod : {
        "default": mod
    }
}

Object.defineProperty(exports, "__esModule", {
    value: true
})

const node_cache_1 = __importDefault(require("@cacheable/node-cache"))
const boom_1 = require("@hapi/boom")
const crypto_1 = require("crypto")
const WAProto_1 = require("../../WAProto")
const Defaults_1 = require("../Defaults")
const Utils_1 = require("../Utils")
const Types_1 = require("../Types")
const WABinary_1 = require("../WABinary")
const WAUSync_1 = require("../WAUSync")
const newsletter_1 = require("./newsletter")
const link_preview_1 = require("../Utils/link-preview")
const make_keyed_mutex_1 = require("../Utils/make-mutex")

const makeMessagesSocket = (config) => {
    const {
        logger,
        maxMsgRetryCount,
        linkPreviewImageThumbnailWidth,
        generateHighQualityLinkPreview,
        options: axiosOptions,
        patchMessageBeforeSending,
        cachedGroupMetadata,
        enableRecentMessageCache
    } = config
    const sock = newsletter_1.makeNewsletterSocket(config)
    const {
        ev,
        authState,
        processingMutex,
        signalRepository,
        upsertMessage,
        createCallLink,
        query,
        fetchPrivacySettings,
        sendNode,
        groupQuery,
        groupMetadata,
        groupToggleEphemeral,
        newsletterWMexQuery,
        executeUSyncQuery
    } = sock

    const userDevicesCache = config.userDevicesCache || new node_cache_1.default({
        stdTTL: Defaults_1.DEFAULT_CACHE_TTLS.USER_DEVICES,
        useClones: false
    })

    const messageRetryManager = enableRecentMessageCache ? new Utils_1.MessageRetryManager(logger, maxMsgRetryCount) : null
    const encryptionMutex = make_keyed_mutex_1.makeKeyedMutex()
    const devicesMutex = make_keyed_mutex_1.makeMutex()

    const DEF_MEDIA_HOST = 'mmg.whatsapp.net'
    let mediaConn
    let mediaHost = DEF_MEDIA_HOST

    const refreshMediaConn = async (forceGet = false) => {
        const media = await mediaConn
        if (!media || forceGet || (new Date().getTime() - media.fetchDate.getTime()) > media.ttl * 1000) {
            mediaConn = (async () => {
                const result = await query({
                    tag: 'iq',
                    attrs: {
                        type: 'set',
                        xmlns: 'w:m',
                        to: WABinary_1.S_WHATSAPP_NET,
                    },
                    content: [{
                        tag: 'media_conn',
                        attrs: {}
                    }]
                })
                const mediaConnNode = WABinary_1.getBinaryNodeChild(result, 'media_conn')
                const node = {
                    hosts: WABinary_1.getBinaryNodeChildren(mediaConnNode, 'host').map(({
                        attrs
                    }) => ({
                        hostname: attrs.hostname,
                        maxContentLengthBytes: +attrs.maxContentLengthBytes,
                    })),
                    auth: mediaConnNode.attrs.auth,
                    ttl: +mediaConnNode.attrs.ttl,
                    fetchDate: new Date()
                }
                if (node.hosts.length) {
                    mediaHost = node.hosts[0].hostname
                }
                logger.debug({ mediaHost }, 'fetched media conn')
                return node
            })()
        }
        return mediaConn
    }

    const sendReceipt = async (jid, participant, messageIds, type) => {
        const node = {
            tag: 'receipt',
            attrs: {
                id: messageIds[0],
            },
        }
        const isReadReceipt = type === 'read' || type === 'read-self'
        if (isReadReceipt) {
            node.attrs.t = Utils_1.unixTimestampSeconds().toString()
        }
        if (type === 'sender' && WABinary_1.isJidUser(jid)) {
            node.attrs.recipient = jid
            node.attrs.to = participant
        } else {
            node.attrs.to = jid
            if (participant) {
                node.attrs.participant = participant
            }
        }
        if (type) {
            node.attrs.type = WABinary_1.isJidNewsletter(jid) ? 'read-self' : type
        }
        const remainingMessageIds = messageIds.slice(1)
        if (remainingMessageIds.length) {
            node.content = [{
                tag: 'list',
                attrs: {},
                content: remainingMessageIds.map(id => ({
                    tag: 'item',
                    attrs: {
                        id
                    }
                }))
            }]
        }
        logger.debug({
            attrs: node.attrs,
            messageIds
        }, 'sending receipt for messages')
        await sendNode(node)
    }

    const sendReceipts = async (keys, type) => {
        const recps = Utils_1.aggregateMessageKeysNotFromMe(keys)
        for (const { jid, participant, messageIds } of recps) {
            await sendReceipt(jid, participant, messageIds, type)
        }
    }

    const readMessages = async (keys) => {
        const privacySettings = await fetchPrivacySettings()
        const readType = privacySettings.readreceipts === 'all' ? 'read' : 'read-self'
        await sendReceipts(keys, readType)
    }

    const deduplicateLidPnJids = (jids) => {
        const lidUsers = new Set()
        const filteredJids = []

        for (const jid of jids) {
            if (WABinary_1.isLidUser(jid)) {
                const user = WABinary_1.jidDecode(jid)?.user
                if (user) lidUsers.add(user)
            }
        }

        for (const jid of jids) {
            if (WABinary_1.isJidUser(jid)) {
                const user = WABinary_1.jidDecode(jid)?.user
                if (user && lidUsers.has(user)) {
                    logger.debug({
                        jid
                    }, 'Skipping PN - LID version exists')
                    continue
                }
            }
            filteredJids.push(jid)
        }
        return filteredJids
    }

    const profilePictureUrl = async (jid) => {
        if (WABinary_1.isJidNewsletter(jid)) {
            let node = await newsletterWMexQuery(undefined, Types_1.QueryIds.METADATA, {
                input: {
                    key: jid,
                    type: 'JID',
                    view_role: 'GUEST'
                },
                fetch_viewer_metadata: true,
                fetch_full_image: true,
                fetch_creation_time: true
            })
            let result = WABinary_1.getBinaryNodeChild(node, 'result')?.content?.toString()
            let metadata = JSON.parse(result).data[Types_1.XWAPaths.NEWSLETTER]
            return Utils_1.getUrlFromDirectPath(metadata.thread_metadata.picture?.direct_path || '')
        } else {
            const result = await query({
                tag: 'iq',
                attrs: {
                    target: WABinary_1.jidNormalizedUser(jid),
                    to: WABinary_1.S_WHATSAPP_NET,
                    type: 'get',
                    xmlns: 'w:profile:picture'
                },
                content: [{
                    tag: 'picture',
                    attrs: {
                        type: 'image',
                        query: 'url'
                    }
                }]
            })
            const child = WABinary_1.getBinaryNodeChild(result, 'picture')
            return child?.attrs?.url || null
        }
    }

    const getUSyncDevices = async (jids, useCache, ignoreZeroDevices) => {
        const deviceResults = []

        if (!useCache) {
            logger.debug('not using cache for devices')
        }

        const toFetch = []

        jids = deduplicateLidPnJids(Array.from(new Set(jids)))
        const jidsWithUser = jids
            .map(jid => {
                const decoded = WABinary_1.jidDecode(jid)
                const user = decoded?.user
                const device = decoded?.device
                const isExplicitDevice = typeof device === 'number' && device >= 0

                if (isExplicitDevice && user) {
                    deviceResults.push({
                        user,
                        device,
                        wireJid: jid
                    });
                    return null
                }

                jid = WABinary_1.jidNormalizedUser(jid)
                return {
                    jid,
                    user
                }
            })
            .filter(jid => jid !== null)

        let mgetDevices
        if (useCache && userDevicesCache.mget) {
            const usersToFetch = jidsWithUser.map(j => j?.user).filter(Boolean)
            mgetDevices = await userDevicesCache.mget(usersToFetch)
        }

        for (const { jid, user } of jidsWithUser) {
            if (useCache) {
                const devices = mgetDevices?.[user] || (userDevicesCache.mget ? undefined : (await userDevicesCache.get(user)))
                if (devices) {
                    const isLidJid = WABinary_1.isLidUser(jid)
                    const devicesWithWire = devices.map(d => ({
                        ...d,
                        wireJid: isLidJid ? WABinary_1.jidEncode(d.user, 'lid', d.device) : WABinary_1.jidEncode(d.user, 's.whatsapp.net', d.device)
                    }))
                    deviceResults.push(...devicesWithWire)
                    logger.trace({
                        user
                    }, 'using cache for devices')
                } else {
                    toFetch.push(jid)
                }
            } else {
                toFetch.push(jid)
            }
        }

        if (!toFetch.length) {
            return deviceResults
        }

        const requestedLidUsers = new Set()
        for (const jid of toFetch) {
            if (WABinary_1.isLidUser(jid)) {
                const user = WABinary_1.jidDecode(jid)?.user
                if (user) requestedLidUsers.add(user)
            }
        }

        const query = new WAUSync_1.USyncQuery().withContext('message').withDeviceProtocol()
        for (const jid of toFetch) {
            query.withUser(new WAUSync_1.USyncUser().withId(jid))
        }

        const result = await executeUSyncQuery(query)
        if (result) {
            const extracted = Utils_1.extractDeviceJids(result?.list, authState.creds.me?.id, ignoreZeroDevices)
            const deviceMap = {}
            for (const item of extracted) {
                deviceMap[item.user] = deviceMap[item.user] || []
                deviceMap[item.user]?.push(item)
            }
            for (const [user, userDevices] of Object.entries(deviceMap)) {
                const isLidUser = requestedLidUsers.has(user)
                for (const item of userDevices) {
                    if (item.device === 99) {
                        continue
                    }
                    const finalWireJid = isLidUser ? WABinary_1.jidEncode(user, 'lid', item.device) : WABinary_1.jidEncode(item.user, 's.whatsapp.net', item.device)
                    if (WABinary_1.isHostedLidUser(finalWireJid) || WABinary_1.isHostedPnUser(finalWireJid)) {
                        continue
                    }
                    deviceResults.push({
                        ...item,
                        wireJid: finalWireJid
                    });
                    logger.debug({
                        user: item.user,
                        device: item.device,
                        finalWireJid,
                        usedLid: isLidUser
                    }, 'Processed device with LID priority')
                }
            }

            if (userDevicesCache.mset) {
                await userDevicesCache.mset(Object.entries(deviceMap).map(([key, value]) => ({
                    key,
                    value
                })))
            } else {
                for (const key in deviceMap) {
                    if (deviceMap[key]) await userDevicesCache.set(key, deviceMap[key])
                }
            }
        }
        return deviceResults
    }

    const assertSessions = async (jids, force) => {
        let didFetchNewSession = false;
        const uniqueJids = [...new Set(jids)];
        let jidsRequiringFetch = [];
        if (force) {
            jidsRequiringFetch = uniqueJids;
        } else {
            for (const jid of uniqueJids) {
                const { exists } = await signalRepository.validateSession(jid);
                if (!exists) {
                    jidsRequiringFetch.push(jid);
                }
            }
        }
        if (jidsRequiringFetch.length) {
            const lidWire = jidsRequiringFetch.filter(
                (j) => WABinary_1.isLidUser(j) || WABinary_1.isHostedLidUser(j)
            );
            const pnWireRaw = jidsRequiringFetch.filter(
                (j) => WABinary_1.isPnUser(j) || WABinary_1.isHostedPnUser(j)
            );
            let mapped = [];
            if (pnWireRaw.length && signalRepository.lidMapping) {
                mapped = (await signalRepository.lidMapping.getLIDsForPNs(pnWireRaw)) || [];
            }
            const mappedPn = new Set(mapped.map((m) => m.pn));
            const wireJidsSet = new Set([
                ...lidWire,
                ...mapped.map((m) => m.lid),
            ]);
            for (const pj of pnWireRaw) {
                if (!mappedPn.has(pj)) {
                    wireJidsSet.add(pj);
                }
            }
            const wireJids = [...wireJidsSet];
            logger.debug({ jidsRequiringFetch, wireJids }, 'fetching sessions');
            const result = await query({
                tag: 'iq',
                attrs: {
                    xmlns: 'encrypt',
                    type: 'get',
                    to: WABinary_1.S_WHATSAPP_NET,
                },
                content: [
                    {
                        tag: 'key',
                        attrs: {},
                        content: wireJids.map((jid) => ({
                            tag: 'user',
                            attrs: force ? { jid, reason: 'identity' } : { jid },
                        })),
                    },
                ],
            });
            await (0, Utils_1.parseAndInjectE2ESessions)(result, signalRepository);
            didFetchNewSession = true;
        }
        return didFetchNewSession;
    };

    const sendPeerDataOperationMessage = async (pdoMessage) => {
        if (!authState.creds.me?.id) {
            throw new boom_1.Boom('Not authenticated')
        }

        const protocolMessage = {
            protocolMessage: {
                peerDataOperationRequestMessage: pdoMessage,
                type: WAProto_1.proto.Message.ProtocolMessage.Type.PEER_DATA_OPERATION_REQUEST_MESSAGE
            }
        }

        const meJid = WABinary_1.jidNormalizedUser(authState.creds.me.id)
        const msgId = await relayMessage(meJid, protocolMessage, {
            additionalAttributes: {
                category: 'peer',
                push_priority: 'high_force',
            },
        })
        return msgId
    }

    const createParticipantNodes = async (jids, message, extraAttrs) => {
        let patched = await patchMessageBeforeSending(message, jids);
        if (!Array.isArray(patched)) {
            patched = jids ? jids.map(jid => ({ recipientJid: jid, ...patched })) : [patched];
        }
        let shouldIncludeDeviceIdentity = false;
        const nodes = (await Promise.all(patched.map(async (patchedMessageWithJid) => {
            const { recipientJid: jid, ...patchedMessage } = patchedMessageWithJid;
            if (!jid) {
                return null;
            }
            try {
                const bytes = (0, Utils_1.encodeWAMessage)(patchedMessage);
                let encResult;
                try {
                    encResult = await signalRepository.encryptMessage({ jid, data: bytes });
                } catch (err) {
                    const isSessionErr = err?.name === 'SessionError'
                        || err?.message?.includes('No sessions')
                        || err?.message?.includes('No session record');
                    if (!isSessionErr) throw err;

                    logger.warn({ jid }, 'SessionError, re-asserting session')
                    try {
                        await assertSessions([jid], true);
                        encResult = await signalRepository.encryptMessage({ jid, data: bytes });
                    } catch (retryErr) {
                        const isRetrySessionErr = retryErr?.name === 'SessionError'
                            || retryErr?.message?.includes('No sessions')
                            || retryErr?.message?.includes('No session record');
                        if (!isRetrySessionErr) throw retryErr;

                        logger.warn({ jid }, 'SessionError persists, deleting session and re-fetching')
                        await signalRepository.deleteSession([jid]);
                        signalRepository.clearCaches();
                        await assertSessions([jid], true);
                        encResult = await signalRepository.encryptMessage({ jid, data: bytes });
                    }
                }
                const { type, ciphertext } = encResult;
                if (type === 'pkmsg') {
                    shouldIncludeDeviceIdentity = true;
                }
                return {
                    tag: 'to',
                    attrs: { jid },
                    content: [{
                        tag: 'enc',
                        attrs: { v: '2', type, ...extraAttrs || {} },
                        content: ciphertext
                    }]
                };
            } catch (err) {
                logger.error({ jid, err: err.message }, 'Failed to encrypt for recipient, skipping')
                return null;
            }
        }))).filter(node => node !== null);
        return { nodes, shouldIncludeDeviceIdentity };
    };

    const relayMessage = async (jid, message, {
        messageId: msgId,
        participant,
        additionalAttributes,
        useUserDevicesCache,
        useCachedGroupMetadata,
        statusJidList,
        additionalNodes,
        addBizAttributes,
        ai = false
    }) => {
        const meId = authState.creds.me.id
        const meLid = authState.creds.me?.lid

        let additionalAlready = false
        let shouldIncludeDeviceIdentity = false

        const {
            user,
            server
        } = WABinary_1.jidDecode(jid)

        const statusJid = 'status@broadcast'
        const isGroup = server === 'g.us'
        const isPrivate = server === 's.whatsapp.net'
        const isNewsletter = server == 'newsletter'
        const isStatus = jid === statusJid
        const isLid = server === 'lid'

        const finalJid = jid

        let ownId = meId

        if (isLid && meLid) {
            ownId = meLid
            logger.debug({
                to: jid,
                ownId
            }, 'Using LID identity for @lid conversation')
        } else {
            logger.debug({
                to: jid,
                ownId
            }, 'Using PN identity for @s.whatsapp.net conversation')
        }

        msgId = msgId || Utils_1.generateMessageID(authState.creds.me.id)
        useUserDevicesCache = useUserDevicesCache !== false
        useCachedGroupMetadata = useCachedGroupMetadata !== false && !isStatus

        const participants = []
        const destinationJid = !isStatus ? finalJid : statusJid
        const binaryNodeContent = []
        const devices = []

        const meMsg = {
            deviceSentMessage: {
                destinationJid,
                message
            },
            messageContextInfo: message.messageContextInfo || {}
        }

        const extraAttrs = {}
        const regexGroupOld = /^(\d{1,15})-(\d+)@g\.us$/
        const messages = Utils_1.normalizeMessageContent(message)
        const buttonType = getButtonType(messages)
        const pollMessage = messages.pollCreationMessage || messages.pollCreationMessageV2 || messages.pollCreationMessageV3
        // se lee del mensaje sin normalizar: normalizeMessageContent desenvuelve el wrapper
        const isGroupStatus = !!(message.groupStatusMessage || message.groupStatusMessageV2)

        if (participant) {
            if (!isGroup && !isStatus) {
                additionalAttributes = {
                    ...additionalAttributes,
                    'device_fanout': 'false'
                }
            }

            const {
                user,
                device
            } = WABinary_1.jidDecode(participant.jid)

            devices.push({
                user,
                device,
                wireJid: participant.jid
            })
        }

        await authState.keys.transaction(async () => {
            // `messages` es el contenido normalizado: sin desenvolver, los mensajes
            // envueltos (groupStatusMessageV2, viewOnce, ephemeral, documentWithCaption...)
            // salian sin `mediatype` y el cliente los renderizaba como texto plano.
            const mediaType = getMediaType(messages)
            if (mediaType) {
                extraAttrs['mediatype'] = mediaType
            }

            if (messages.pinInChatMessage || messages.keepInChatMessage || message.reactionMessage || message.protocolMessage?.editedMessage) {
                extraAttrs['decrypt-fail'] = 'hide'
            }

            // El estado de grupo solo se renderiza si el stanza lleva este nodo:
            // sin `is_group_status` el servidor entrega el mensaje como texto normal.
            if (isGroupStatus) {
                binaryNodeContent.push({
                    tag: 'meta',
                    attrs: {
                        is_group_status: 'true'
                    }
                })
            }

            if (messages.interactiveResponseMessage?.nativeFlowResponseMessage) {
                extraAttrs['native_flow_name'] = messages.interactiveResponseMessage.nativeFlowResponseMessage?.name || 'menu_options'
            }

            if (isGroup || isStatus) {
                const [groupData, senderKeyMap] = await Promise.all([
                    (async () => {
                        let groupData = useCachedGroupMetadata && cachedGroupMetadata ? await cachedGroupMetadata(jid) : undefined
                        if (groupData && Array.isArray(groupData?.participants)) {
                            logger.trace({
                                jid,
                                participants: groupData.participants.length
                            }, 'using cached group metadata')
                        } else if (!isStatus) {
                            groupData = await global.groupMetadataCache(jid)
                        }
                        return groupData
                    })(),
                    (async () => {
                        if (!participant && !isStatus) {
                            const result = await authState.keys.get('sender-key-memory', [jid])
                            return result[jid] || {}
                        }
                        return {}
                    })()
                ])

                const groupAddressingMode = groupData?.addressingMode || (isLid ? Types_1.WAMessageAddressingMode.LID : Types_1.WAMessageAddressingMode.PN)
                const usesLidAddressing = groupAddressingMode === Types_1.WAMessageAddressingMode.LID
                if (!participant) {
                    const participantsList = (groupData && !isStatus) ? groupData.participants
                        .map(p => {
                            if (!usesLidAddressing) {
                                return p.id
                            }
                            if (p.lid) {
                                return p.lid
                            }
                            if (!p.id) {
                                return undefined
                            }
                            return WABinary_1.jidDecode(p.id) ? p.id : WABinary_1.jidEncode(p.id, 's.whatsapp.net')
                        })
                        .filter(Boolean) : []
                    if (isStatus && statusJidList) {
                        participantsList.push(...statusJidList)
                    }
                    if (!isStatus) {
                        additionalAttributes = {
                            ...additionalAttributes,
                            addressing_mode: groupAddressingMode
                        }
                    }
                    const additionalDevices = await getUSyncDevices(participantsList, !!useUserDevicesCache, false)
                    devices.push(...additionalDevices)
                }

                const patched = await patchMessageBeforeSending(message, devices.map(d => WABinary_1.jidEncode(d.user, usesLidAddressing ? 'lid' : 's.whatsapp.net', d.device)))
                const bytes = Utils_1.encodeWAMessage(patched)

                const groupSenderIdentity = (usesLidAddressing && meLid) ? meLid : meId

                const {
                    ciphertext,
                    senderKeyDistributionMessage
                } = await signalRepository.encryptGroupMessage({
                    group: destinationJid,
                    data: bytes,
                    meId: groupSenderIdentity
                })

                const senderKeyJids = []

                for (const device of devices) {
                    const deviceJid = device.wireJid
                    if (WABinary_1.isHostedLidUser(deviceJid) || WABinary_1.isHostedPnUser(deviceJid)) {
                        continue
                    }
                    if (device.device === 99) {
                        continue
                    }
                    const hasKey = !!senderKeyMap[deviceJid]
                    if (!hasKey || !!participant) {
                        senderKeyJids.push(deviceJid)
                        senderKeyMap[deviceJid] = true
                    }
                }

                if (senderKeyJids.length) {
                    logger.debug({
                        senderKeyJids
                    }, 'sending new sender key')
                    const senderKeyMsg = {
                        senderKeyDistributionMessage: {
                            axolotlSenderKeyDistributionMessage: senderKeyDistributionMessage,
                            groupId: destinationJid
                        }
                    }

                    await assertSessions(senderKeyJids, false)
                    const result = await createParticipantNodes(senderKeyJids, senderKeyMsg, extraAttrs)
                    shouldIncludeDeviceIdentity = shouldIncludeDeviceIdentity || result.shouldIncludeDeviceIdentity
                    participants.push(...result.nodes)
                }

                binaryNodeContent.push({
                    tag: 'enc',
                    attrs: {
                        v: '2',
                        type: 'skmsg',
                        ...extraAttrs
                    },
                    content: ciphertext
                })

                await authState.keys.set({
                    'sender-key-memory': {
                        [jid]: senderKeyMap
                    }
                })
            } else if (isNewsletter) {
                if (message.protocolMessage?.editedMessage) {
                    msgId = message.protocolMessage.key?.id
                    message = message.protocolMessage.editedMessage
                }

                if (message.protocolMessage?.type === WAProto_1.proto.Message.ProtocolMessage.Type.REVOKE) {
                    msgId = message.protocolMessage.key?.id
                    message = {}
                }

                const patched = await patchMessageBeforeSending(message, [])
                const bytes = Utils_1.encodeNewsletterMessage(patched)

                binaryNodeContent.push({
                    tag: 'plaintext',
                    attrs: extraAttrs,
                    content: bytes
                })
            } else {
                const {
                    user: ownUser
                } = WABinary_1.jidDecode(ownId)

                if (!participant) {
                    const targetUserServer = isLid ? 'lid' : 's.whatsapp.net'
                    devices.push({
                        user,
                        device: 0,
                        wireJid: WABinary_1.jidEncode(user, targetUserServer, 0)
                    })

                    if (user !== ownUser) {
                        const ownUserServer = isLid ? 'lid' : 's.whatsapp.net';
                        const ownUserForAddressing = isLid && meLid ? WABinary_1.jidDecode(meLid).user : WABinary_1.jidDecode(meId).user
                        devices.push({
                            user: ownUserForAddressing,
                            device: 0,
                            wireJid: WABinary_1.jidEncode(ownUserForAddressing, ownUserServer, 0)
                        })
                    }

                    if (additionalAttributes?.['category'] !== 'peer') {
                        devices.length = 0
                        const senderIdentity = isLid && meLid ? WABinary_1.jidEncode(WABinary_1.jidDecode(meLid)?.user, 'lid', undefined) : WABinary_1.jidEncode(WABinary_1.jidDecode(meId)?.user, 's.whatsapp.net', undefined)
                        // ponytail: usar la caché de dispositivos (comportamiento oficial de Baileys)
                        // evita un round-trip USync al servidor en CADA mensaje privado -> respuestas más rápidas.
                        // La caché se invalida por TTL (DEFAULT_CACHE_TTLS.USER_DEVICES) y por eventos de dispositivo.
                        const sessionDevices = await getUSyncDevices([senderIdentity, jid], !!useUserDevicesCache, false)
                        devices.push(...sessionDevices)
                        logger.debug({
                            deviceCount: devices.length,
                            devices: devices.map(d => `${d.user}:${d.device}@${WABinary_1.jidDecode(d.wireJid)?.server}`)
                        }, 'Device enumeration complete with unified addressing')
                    }
                }

                const allJids = []
                const meJids = []
                const otherJids = []

                const {
                    user: mePnUser
                } = WABinary_1.jidDecode(meId)
                const {
                    user: meLidUser
                } = meLid ? WABinary_1.jidDecode(meLid) : {
                    user: null
                }

                for (const { user, wireJid } of devices) {
                    const isExactSenderDevice = wireJid === meId || (meLid && wireJid === meLid)
                    if (isExactSenderDevice) {
                        logger.debug({
                            wireJid,
                            meId,
                            meLid
                        }, 'Skipping exact sender device (whatsmeow pattern)')
                        continue
                    }
                    const isMe = user === mePnUser || (meLidUser && user === meLidUser)
                    const jid = wireJid
                    if (isMe) {
                        meJids.push(jid)
                    } else {
                        otherJids.push(jid)
                    }
                    allJids.push(jid)
                }

                await assertSessions([...otherJids, ...meJids], false)
                const [{
                    nodes: meNodes,
                    shouldIncludeDeviceIdentity: s1
                }, {
                    nodes: otherNodes,
                    shouldIncludeDeviceIdentity: s2
                }] = await Promise.all([
                    createParticipantNodes(meJids, meMsg || message, extraAttrs),
                    createParticipantNodes(otherJids, message, extraAttrs, meMsg)
                ])

                participants.push(...meNodes)
                participants.push(...otherNodes)
                if (meJids.length > 0 || otherJids.length > 0) {
                    extraAttrs['phash'] = Utils_1.generateParticipantHashV2([...meJids, ...otherJids])
                }
                shouldIncludeDeviceIdentity = shouldIncludeDeviceIdentity || s1 || s2
            }

            if (participants.length) {
                if (additionalAttributes?.['category'] === 'peer') {
                    const peerNode = participants[0]?.content?.[0]
                    if (peerNode) {
                        binaryNodeContent.push(peerNode)
                    }
                } else {
                    binaryNodeContent.push({
                        tag: 'participants',
                        attrs: {},
                        content: participants
                    })
                }
            }

            const stanza = {
                tag: 'message',
                attrs: {
                    to: destinationJid,
                    id: msgId,
                    type: getTypeMessage(message),
                    ...(additionalAttributes || {})
                },
                content: binaryNodeContent
            }

            if (participant) {
                if (WABinary_1.isJidGroup(destinationJid)) {
                    stanza.attrs.to = destinationJid
                    stanza.attrs.participant = participant.jid
                } else if (WABinary_1.areJidsSameUser(participant.jid, meId)) {
                    stanza.attrs.to = participant.jid
                    stanza.attrs.recipient = destinationJid
                } else {
                    stanza.attrs.to = participant.jid
                }
            } else {
                stanza.attrs.to = destinationJid
            }

            if (shouldIncludeDeviceIdentity) {
                stanza.content.push({
                    tag: 'device-identity',
                    attrs: {},
                    content: Utils_1.encodeSignedDeviceIdentity(authState.creds.account, true)
                })
                logger.debug({
                    jid
                }, 'adding device identity')
            }

            if (isGroup && regexGroupOld.test(jid) && !message.reactionMessage) {
                stanza.content.push({
                    tag: 'multicast',
                    attrs: {}
                })
            }

            // Adjunta el "reporting token" igual que WhatsApp Web: permite que el
            // mensaje sea reportable desde el cliente receptor.
            if (!isNewsletter && message?.messageContextInfo?.messageSecret && Utils_1.shouldIncludeReportingToken(message)) {
                try {
                    const reportingNode = await Utils_1.getMessageReportingToken(
                        Buffer.from(Utils_1.encodeWAMessage(message)),
                        message,
                        {
                            id: msgId,
                            fromMe: true,
                            remoteJid: destinationJid,
                            participant: participant?.jid
                        }
                    )
                    if (reportingNode) {
                        stanza.content.push(reportingNode)
                    }
                } catch (error) {
                    logger.warn({ jid, trace: error?.stack }, 'no se pudo adjuntar el reporting token')
                }
            }

            if (pollMessage || messages.eventMessage) {
                let attrs = {};
                if (messages.eventMessage) {
                    attrs.event_type = 'creation';
                } else {
                    attrs.polltype = 'creation';
                    if (isNewsletter) {
                        attrs.contenttype = (pollMessage && pollMessage.pollContentType === 2) ? 'image' : 'text';
                    }
                }
                stanza.content.push({
                    tag: 'meta',
                    attrs: attrs
                });
            }

            // `addBizAttributes` fuerza el nodo `biz` aunque el mensaje no lleve botones
            // (usado por la opcion `secureMetaServiceLabel`)
            if (!isNewsletter && (buttonType || addBizAttributes)) {
                const buttonsNode = getButtonArgs(messages)
                const filteredButtons = WABinary_1.getBinaryFilteredButtons(additionalNodes ? additionalNodes : [])
                if (filteredButtons) {
                    stanza.content.push(...additionalNodes)
                    additionalAlready = true
                } else {
                    stanza.content.push(buttonsNode)
                }
            }

            // ponytail: <bot biz_bot="1"> announces the sender as an official WA Business
            // Cloud-API bot. Sending it from a NON-Business account in a private chat
            // triggers a server-side policy violation → stream:error code=401 → loggedOut.
            // In groups WA cannot police this cheaply, so buttons work there.
            // Default is now OFF. Opt in with `{ ai: true }` only if you have a verified
            // Business account (otherwise your session will be killed).
            if (ai && isPrivate) {
                const botNode = {
                    tag: 'bot',
                    attrs: { biz_bot: '1' }
                }
                const filteredBizBot = WABinary_1.getBinaryFilteredBizBot(additionalNodes ? additionalNodes : [])
                if (filteredBizBot) {
                    stanza.content.push(...additionalNodes)
                    additionalAlready = true
                } else {
                    stanza.content.push(botNode)
                }
            }

            if (!additionalAlready && additionalNodes && additionalNodes.length > 0) {
                stanza.content.push(...additionalNodes)
            }

            logger.debug({
                msgId
            }, `sending message to ${participants.length} devices`)

            // Depuracion puntual del estado de grupo: `global.DEBUG_GROUP_STATUS = true`
            // imprime el stanza exacto que sale, sin activar el log trace global.
            if (isGroupStatus && global.DEBUG_GROUP_STATUS) {
                console.log('[GROUP_STATUS XML]\n' + WABinary_1.binaryNodeToString(stanza))
            }

            await sendNode(stanza)
            if (messageRetryManager && !participant) {
                messageRetryManager.addRecentMessage(destinationJid, msgId, message)
            }
        }, meId)
        return msgId
    }

    const getTypeMessage = (msg) => {
        const message = Utils_1.normalizeMessageContent(msg)
        if (message.pollCreationMessage || message.pollCreationMessageV2 || message.pollCreationMessageV3) {
            return 'poll'
        } else if (message.reactionMessage) {
            return 'reaction'
        } else if (message.eventMessage) {
            return 'event'
        } else if (getMediaType(message)) {
            return 'media'
        } else {
            return 'text'
        }
    }

    const getMediaType = (message) => {
        if (message.imageMessage) {
            return 'image'
        } else if (message.stickerMessage) {
            return message.stickerMessage.isLottie ? '1p_sticker' : message.stickerMessage.isAvatar ? 'avatar_sticker' : 'sticker'
        } else if (message.videoMessage) {
            return message.videoMessage.gifPlayback ? 'gif' : 'video'
        } else if (message.audioMessage) {
            return message.audioMessage.ptt ? 'ptt' : 'audio'
        } else if (message.ptvMessage) {
            return 'ptv'
        } else if (message.albumMessage) {
            return 'collection'
        } else if (message.contactMessage) {
            return 'vcard'
        } else if (message.documentMessage) {
            return 'document'
        } else if (message.stickerPackMessage) {
            return 'sticker_pack'
        } else if (message.contactsArrayMessage) {
            return 'contact_array'
        } else if (message.locationMessage) {
            return 'location'
        } else if (message.liveLocationMessage) {
            return 'livelocation'
        } else if (message.listMessage) {
            return 'list'
        } else if (message.listResponseMessage) {
            return 'list_response'
        } else if (message.buttonsResponseMessage) {
            return 'buttons_response'
        } else if (message.orderMessage) {
            return 'order'
        } else if (message.productMessage) {
            return 'product'
        } else if (message.interactiveResponseMessage) {
            return 'native_flow_response'
        } else if (/https:\/\/wa\.me\/c\/\d+/.test(message.extendedTextMessage?.text)) {
            return 'cataloglink'
        } else if (/https:\/\/wa\.me\/p\/\d+\/\d+/.test(message.extendedTextMessage?.text)) {
            return 'productlink'
        } else if (message.extendedTextMessage?.matchedText || message.groupInviteMessage) {
            return 'url'
        }
    }

    const getButtonType = (message) => {
        const message_content = message.viewOnceMessage?.message || message;
        if (message_content.listMessage) {
            return 'list';
        } else if (message_content.buttonsMessage) {
            return 'buttons';
        } else if (message_content.interactiveMessage?.nativeFlowMessage) {
            return 'native_flow';
        }
    };

    const getButtonArgs = (message) => {
        const message_content = message.viewOnceMessage?.message || message;
        const message_flow = message_content.interactiveMessage?.nativeFlowMessage;
        const flow_buttons_first = message_flow?.buttons?.[0]?.name;
        const flow_buttons_special = [ 'mpm', 'cta_catalog', 'send_location', 'call_permission_request', 'wa_payment_transaction_details', 'automated_greeting_message_view_catalog' ];
        const baseArgs = {
            tag: 'biz',
            attrs: {
                actual_actors: '2',
                host_storage: '2',
                privacy_mode_ts: Utils_1.unixTimestampSeconds().toString()
            }
        };
        if (message_flow && (flow_buttons_first === 'review_and_pay' || flow_buttons_first === 'payment_info')) {
            return {
                tag: 'biz',
                attrs: {
                    native_flow_name: flow_buttons_first === 'review_and_pay' ? 'order_details' : flow_buttons_first
                }
            };
        }
        if (message_flow && flow_buttons_special.includes(flow_buttons_first)) {
            return {
                ...baseArgs,
                content: [
                    {
                        tag: 'interactive',
                        attrs: { type: 'native_flow', v: '1' },
                        content: [{
                            tag: 'native_flow',
                            attrs: { v: '2', name: flow_buttons_first }
                        }]
                    },
                    {
                        tag: 'quality_control',
                        attrs: { source_type: 'third_party' }
                    }
                ]
            };
        }
        if (message_flow || message_content.buttonsMessage) {
            return {
                ...baseArgs,
                content: [
                    {
                        tag: 'interactive',
                        attrs: { type: 'native_flow', v: '1' },
                        content: [{
                            tag: 'native_flow',
                            attrs: { v: '9', name: 'mixed' }
                        }]
                    },
                    {
                        tag: 'quality_control',
                        attrs: { source_type: 'third_party' }
                    }
                ]
            };
        }
        if (message_content.listMessage) {
            return {
                ...baseArgs,
                content: [
                    {
                        tag: 'list',
                        attrs: { v: '2', type: 'product_list' }
                    },
                    {
                        tag: 'quality_control',
                        attrs: { source_type: 'third_party' }
                    }
                ]
            };
        }
        return baseArgs;
    };

    const getPrivacyTokens = async (jids) => {
        const t = Utils_1.unixTimestampSeconds().toString()

        const result = await query({
            tag: 'iq',
            attrs: {
                to: WABinary_1.S_WHATSAPP_NET,
                type: 'set',
                xmlns: 'privacy'
            },
            content: [{
                tag: 'tokens',
                attrs: {},
                content: jids.map(jid => ({
                    tag: 'token',
                    attrs: {
                        jid: WABinary_1.jidNormalizedUser(jid),
                        t,
                        type: 'trusted_contact'
                    }
                }))
            }]
        })

        return result
    }

    const getEphemeralGroup = (jid) => {
        if (!WABinary_1.isJidGroup(jid)) throw new TypeError("Jid should originate from a group!")

        return groupQuery(jid, 'get', [{
                tag: 'query',
                attrs: {
                    request: 'interactive'
                }
            }])
            .then((groups) => WABinary_1.getBinaryNodeChild(groups, 'group'))
            .then((metadata) => WABinary_1.getBinaryNodeChild(metadata, 'ephemeral')?.attrs?.expiration || 0)
    }

    const waUploadToServer = Utils_1.getWAUploadToServer(config, refreshMediaConn)

    const waitForMsgMediaUpdate = Utils_1.bindWaitForEvent(ev, 'messages.media-update')

    return {
        ...sock,
        getPrivacyTokens,
        assertSessions,
        relayMessage,
        sendReceipt,
        sendReceipts,
        readMessages,
        profilePictureUrl,
        getUSyncDevices,
        refreshMediaConn,
        waUploadToServer,
        getEphemeralGroup,
        fetchPrivacySettings,
        messageRetryManager,
        createParticipantNodes,
        sendPeerDataOperationMessage,
        updateMediaMessage: async (message) => {
            const content = Utils_1.assertMediaContent(message.message)
            const mediaKey = content.mediaKey
            const meId = authState.creds.me.id
            const node = await Utils_1.encryptMediaRetryRequest(message.key, mediaKey, meId)
            let error = undefined

            await Promise.all([
                sendNode(node),
                waitForMsgMediaUpdate(async (update) => {
                    const result = update.find(c => c.key.id === message.key.id)
                    if (result) {
                        if (result.error) {
                            error = result.error
                        } else {
                            try {
                                const media = await Utils_1.decryptMediaRetryData(result.media, mediaKey, result.key.id)

                                if (media.result !== WAProto_1.proto.MediaRetryNotification.ResultType.SUCCESS) {
                                    const resultStr = WAProto_1.proto.MediaRetryNotification.ResultType[media.result]

                                    throw new boom_1.Boom(`Media re-upload failed by device (${resultStr})`, {
                                        data: media,
                                        statusCode: Utils_1.getStatusCodeForMediaRetry(media.result) || 404
                                    })
                                }

                                content.directPath = media.directPath

                                content.url = Utils_1.getUrlFromDirectPath(content.directPath)

                                logger.debug({
                                    directPath: media.directPath,
                                    key: result.key
                                }, 'media update successful')
                            } catch (err) {
                                error = err
                            }
                        }

                        return true
                    }
                })
            ])

            if (error) {
                throw error
            }

            ev.emit('messages.update', [{
                key: message.key,
                update: {
                    message: message.message
                }
            }])

            return message
        },
        sendStatusMentions: async (content, jids = []) => {
            const userJid = WABinary_1.jidNormalizedUser(authState.creds.me.id)
            let allUsers = new Set()
            allUsers.add(userJid)

            for (const id of jids) {
                const isGroup = WABinary_1.isJidGroup(id)
                const isPrivate = WABinary_1.isJidUser(id)

                if (isGroup) {
                    try {
                        const metadata = await cachedGroupMetadata(id) || await global.groupMetadataCache(id)
                        const participants = metadata.participants.map(p => WABinary_1.jidNormalizedUser(p.id))
                        participants.forEach(jid => allUsers.add(jid))
                    } catch (error) {
                        logger.error(`Error getting metadata for group ${id}: ${error}`)
                    }
                } else if (isPrivate) {
                    allUsers.add(WABinary_1.jidNormalizedUser(id))
                }
            }

            const uniqueUsers = Array.from(allUsers)
            const getRandomHexColor = () => "#" + Math.floor(Math.random() * 16777215).toString(16).padStart(6, "0")

            const isMedia = content.image || content.video || content.audio
            const isAudio = !!content.audio

            const messageContent = {
                ...content
            }

            if (isMedia && !isAudio) {
                if (messageContent.text) {
                    messageContent.caption = messageContent.text

                    delete messageContent.text
                }

                delete messageContent.ptt
                delete messageContent.font
                delete messageContent.backgroundColor
                delete messageContent.textColor
            }

            if (isAudio) {
                delete messageContent.text
                delete messageContent.caption
                delete messageContent.font
                delete messageContent.textColor
            }

            const font = !isMedia ? (content.font || Math.floor(Math.random() * 9)) : undefined
            const textColor = !isMedia ? (content.textColor || getRandomHexColor()) : undefined
            const backgroundColor = (!isMedia || isAudio) ? (content.backgroundColor || getRandomHexColor()) : undefined
            const ptt = isAudio ? (typeof content.ptt === 'boolean' ? content.ptt : true) : undefined

            let msg
            let mediaHandle
            try {
                msg = await Utils_1.generateWAMessage(WABinary_1.STORIES_JID, messageContent, {
                    logger,
                    userJid,
                    getUrlInfo: text => link_preview_1.getUrlInfo(text, {
                        thumbnailWidth: linkPreviewImageThumbnailWidth,
                        fetchOpts: {
                            timeout: 3000,
                            ...axiosOptions || {}
                        },
                        logger,
                        uploadImage: generateHighQualityLinkPreview ? waUploadToServer : undefined
                    }),
                    upload: async (encFilePath, opts) => {
                        const up = await waUploadToServer(encFilePath, {
                            ...opts
                        })
                        mediaHandle = up.handle
                        return up
                    },
                    mediaCache: config.mediaCache,
                    options: config.options,
                    font,
                    textColor,
                    backgroundColor,
                    ptt
                })
            } catch (error) {
                logger.error(`Error generating message: ${error}`)
                throw error
            }

            await relayMessage(WABinary_1.STORIES_JID, msg.message, {
                messageId: msg.key.id,
                statusJidList: uniqueUsers,
                additionalNodes: [{
                    tag: 'meta',
                    attrs: {},
                    content: [{
                        tag: 'mentioned_users',
                        attrs: {},
                        content: jids.map(jid => ({
                            tag: 'to',
                            attrs: {
                                jid: WABinary_1.jidNormalizedUser(jid)
                            }
                        }))
                    }]
                }]
            })

            for (const id of jids) {
                try {
                    const normalizedId = WABinary_1.jidNormalizedUser(id)
                    const isPrivate = WABinary_1.isJidUser(normalizedId)
                    const type = isPrivate ? 'statusMentionMessage' : 'groupStatusMentionMessage'

                    const protocolMessage = {
                        [type]: {
                            message: {
                                protocolMessage: {
                                    key: msg.key,
                                    type: 25
                                }
                            }
                        },
                        messageContextInfo: {
                            messageSecret: crypto_1.randomBytes(32)
                        }
                    }

                    const statusMsg = await Utils_1.generateWAMessageFromContent(normalizedId,
                        protocolMessage, {}
                    )

                    await relayMessage(
                        normalizedId,
                        statusMsg.message, {
                            additionalNodes: [{
                                tag: 'meta',
                                attrs: isPrivate ? {
                                    is_status_mention: 'true'
                                } : {
                                    is_group_status_mention: 'true'
                                }
                            }]
                        }
                    )

                    await Utils_1.delay(2000)
                } catch (error) {
                    logger.error(`Error sending to ${id}: ${error}`)
                }
            }

            return msg
        },
        sendAlbumMessage: async (jid, medias, options = {}) => {
            const userJid = authState.creds.me.id
            for (const media of medias) {
                if (!media.image && !media.video) throw new TypeError(`medias[i] must have image or video property`)
            }
            if (medias.length < 2) throw new RangeError("Minimum 2 media")
            const time = options.delay || 500
            delete options.delay
            const album = await Utils_1.generateWAMessageFromContent(jid, {
                albumMessage: {
                    expectedImageCount: medias.filter(media => media.image).length,
                    expectedVideoCount: medias.filter(media => media.video).length,
                    ...options
                }
            }, {
                userJid,
                ...options
            })
            await relayMessage(jid, album.message, {
                messageId: album.key.id
            })
            let mediaHandle
            let msg
            for (const i in medias) {
                const media = medias[i]
                if (media.image) {
                    msg = await Utils_1.generateWAMessage(jid, {
                        image: media.image,
                        ...media,
                        ...options
                    }, {
                        userJid,
                        upload: async (readStream, opts) => {
                            const up = await waUploadToServer(readStream, {
                                ...opts,
                                newsletter: WABinary_1.isJidNewsletter(jid)
                            })
                            mediaHandle = up.handle
                            return up
                        },
                        ...options
                    })
                } else if (media.video) {
                    msg = await Utils_1.generateWAMessage(jid, {
                        video: media.video,
                        ...media,
                        ...options
                    }, {
                        userJid,
                        upload: async (readStream, opts) => {
                            const up = await waUploadToServer(readStream, {
                                ...opts,
                                newsletter: WABinary_1.isJidNewsletter(jid)
                            })
                            mediaHandle = up.handle
                            return up
                        },
                        ...options,
                    })
                }
                if (msg) {
                    msg.message.messageContextInfo = {
                        messageSecret: crypto_1.randomBytes(32),
                        messageAssociation: {
                            associationType: 1,
                            parentMessageKey: album.key
                        }
                    }
                }
                await relayMessage(jid, msg.message, {
                    messageId: msg.key.id
                })
                await Utils_1.delay(time)
            }
            return album
        },
        sendMessage: async (jid, content, options = {}) => {
            const userJid = authState.creds.me.id
            const additionalAttributes = {}

            if (content && typeof content === 'object' && content.mentionAll && WABinary_1.isJidGroup(jid)) {
                try {
                    const meta = await groupMetadata(jid)
                    const all = (meta?.participants || []).map(p => p.id)
                    content.mentions = [...new Set([...(content.mentions || []), ...all])]
                } catch {}
                delete content.mentionAll
            }

            if (!options.ephemeralExpiration) {
                if (WABinary_1.isJidGroup(jid)) {
                    try {
                        const cached = global.groupMetadataCache ? await global.groupMetadataCache(jid) : null
                        options.ephemeralExpiration = cached?.ephemeralDuration || 0
                    } catch {
                        options.ephemeralExpiration = 0
                    }
                }
            }

            if (typeof content === 'object' && 'disappearingMessagesInChat' in content && typeof content['disappearingMessagesInChat'] !== 'undefined' && WABinary_1.isJidGroup(jid)) {
                const { disappearingMessagesInChat } = content
                const value = typeof disappearingMessagesInChat === 'boolean' ? (disappearingMessagesInChat ? Defaults_1.WA_DEFAULT_EPHEMERAL : 0) : disappearingMessagesInChat
                await groupToggleEphemeral(jid, value)
            } else if (typeof content === 'object' && 'album' in content && content.album) {
                const albumMsg = await Utils_1.prepareAlbumMessageContent(jid, content.album, {
                    sock: {
                        relayMessage,
                        waUploadToServer
                    },
                    userJid: userJid,
                    ...options
                })

                for (const media of albumMsg) {
                    await Utils_1.delay(options.delay || 500)
                    await relayMessage(jid, media.message, {
                        messageId: media.key.id,
                        useCachedGroupMetadata: options.useCachedGroupMetadata,
                        additionalAttributes,
                        statusJidList: options.statusJidList,
                        additionalNodes: options.additionalNodes,
                        ai: options.ai
                    })
                }

                return albumMsg
            } else {
                let mediaHandle

                const fullMsg = await Utils_1.generateWAMessage(jid, content, {
                    logger,
                    userJid,
                    getUrlInfo: text => link_preview_1.getUrlInfo(text, {
                        thumbnailWidth: linkPreviewImageThumbnailWidth,
                        fetchOpts: {
                            timeout: 1500,
                            ...axiosOptions || {}
                        },
                        logger,
                        uploadImage: generateHighQualityLinkPreview ?
                            waUploadToServer :
                            undefined
                    }),
                    getProfilePicUrl: profilePictureUrl,
                    getCallLink: createCallLink,
                    upload: async (encFilePath, opts) => {
                        const up = await waUploadToServer(encFilePath, {
                            ...opts,
                            newsletter: WABinary_1.isJidNewsletter(jid)
                        })
                        // Only update mediaHandle when the server returns one;
                        // sticker-pack thumbnail uploads don't return handles
                        // and must not overwrite the ZIP upload's handle.
                        if (up.handle) mediaHandle = up.handle
                        return up
                    },
                    mediaCache: config.mediaCache,
                    options: config.options,
                    messageId: Utils_1.generateMessageID(userJid),
                    ...options,
                })

                const isPin = 'pin' in content && !!content.pin
                const isEdit = 'edit' in content && !!content.edit
                const isDelete = 'delete' in content && !!content.delete
                const isKeep = 'keep' in content && !!content.keep && content.keep?.type === 2

                if (isDelete || isKeep) {
                    if (WABinary_1.isJidGroup(content.delete?.remoteJid) && !content.delete?.fromMe || WABinary_1.isJidNewsletter(jid)) {
                        additionalAttributes.edit = '8'
                    } else {
                        additionalAttributes.edit = '7'
                    }
                } else if (isEdit) {
                    additionalAttributes.edit = WABinary_1.isJidNewsletter(jid) ? '3' : '1'
                } else if (isPin) {
                    additionalAttributes.edit = '2'
                }

                if (mediaHandle) {
                    additionalAttributes['media_id'] = mediaHandle
                }

                if ('cachedGroupMetadata' in options) {
                    console.warn('cachedGroupMetadata in sendMessage are deprecated, now cachedGroupMetadata is part of the socket config.')
                }

                await relayMessage(jid, fullMsg.message, {
                    messageId: fullMsg.key.id,
                    useCachedGroupMetadata: options.useCachedGroupMetadata,
                    additionalAttributes,
                    statusJidList: options.statusJidList,
                    additionalNodes: options.additionalNodes,
                    addBizAttributes: !!(content && typeof content === 'object' && content.secureMetaServiceLabel),
                    ai: options.ai
                })

                if (config.emitOwnEvents) {
                    process.nextTick(() => {
                        upsertMessage(fullMsg, 'append')
                    })
                }

                return fullMsg
            }
        }
    }
}

module.exports = {
    makeMessagesSocket
}