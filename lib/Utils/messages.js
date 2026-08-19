"use strict"

var __importDefault = (this && this.__importDefault) || function(mod) {
    return (mod && mod.__esModule) ? mod : {
        "default": mod
    }
}

Object.defineProperty(exports, "__esModule", {
    value: true
})

const boom_1 = require("@hapi/boom")
const axios_1 = __importDefault(require("axios"))
const crypto_1 = require("crypto")
const fs_1 = require("fs")
const WAProto_1 = require("../../WAProto")
const Defaults_1 = require("../Defaults")
const Types_1 = require("../Types")
const WABinary_1 = require("../WABinary")
const crypto_2 = require("./crypto")
const generics_1 = require("./generics")
const messages_media_1 = require("./messages-media")
const rich_message_utils_1 = require("./rich-message-utils")
const reporting_utils_1 = require("./reporting-utils")

const MIMETYPE_MAP = {
    image: 'image/jpeg',
    video: 'video/mp4',
    document: 'application/pdf',
    audio: 'audio/ogg codecs=opus',
    sticker: 'image/webp',
    'product-catalog-image': 'image/jpeg'
}

const MessageTypeProto = {
    'image': Types_1.WAProto.Message.ImageMessage,
    'video': Types_1.WAProto.Message.VideoMessage,
    'audio': Types_1.WAProto.Message.AudioMessage,
    'sticker': Types_1.WAProto.Message.StickerMessage,
    'document': Types_1.WAProto.Message.DocumentMessage,
}

const extractUrlFromText = (text) => text.match(Defaults_1.URL_REGEX)?.[0]

const generateLinkPreviewIfRequired = async (text, getUrlInfo, logger) => {
    const url = extractUrlFromText(text)
    if (!!getUrlInfo && url) {
        try {
            const urlInfo = await getUrlInfo(url)
            return urlInfo
        } catch (error) {
            logger?.warn({
                trace: error.stack
            }, 'url generation failed')
        }
    }
}

const assertColor = async (color) => {
    let assertedColor
    if (typeof color === 'number') {
        assertedColor = color > 0 ? color : 0xffffffff + Number(color) + 1
    } else {
        let hex = color.trim().replace('#', '')
        if (hex.length <= 6) {
            hex = 'FF' + hex.padStart(6, '0')
        }
        assertedColor = parseInt(hex, 16)
        return assertedColor
    }
}

const prepareWAMessageMedia = async (message, options) => {
    const logger = options.logger
    let mediaType

    for (const key of Defaults_1.MEDIA_KEYS) {
        if (key in message) {
            mediaType = key
        }
    }

    if (!mediaType) {
        throw new boom_1.Boom('Invalid media type', {
            statusCode: 400
        });
    }

    const uploadData = {
        ...message,
        media: message[mediaType]
    }
    delete uploadData[mediaType]
    const cacheableKey = typeof uploadData.media === 'object' && 'url' in uploadData.media && !!uploadData.media.url && !!options.mediaCache && mediaType + ':' + uploadData.media.url.toString()

    if (mediaType === 'document' && !uploadData.fileName) {
        uploadData.fileName = 'file'
    }

    if (!uploadData.mimetype) {
        uploadData.mimetype = MIMETYPE_MAP[mediaType]
    }

    if (uploadData.ptt) {
        uploadData.mimetype = 'audio/ogg; codecs=opus'
    }

    if (cacheableKey) {
        const mediaBuff = await options.mediaCache.get(cacheableKey)
        if (mediaBuff) {
            logger?.debug({
                cacheableKey
            }, 'got media cache hit')
            const obj = Types_1.WAProto.Message.decode(mediaBuff)
            const key = `${mediaType}Message`
            Object.assign(obj[key], {
                ...uploadData,
                media: undefined
            })
            return obj
        }
    }

    const isNewsletter = !!options.jid && WABinary_1.isJidNewsletter(options.jid)

    if (isNewsletter) {
        logger?.info({
            key: cacheableKey
        }, 'Preparing raw media for newsletter')
        const {
            filePath,
            fileSha256,
            fileLength
        } = await messages_media_1.getRawMediaUploadData(uploadData.media, options.mediaTypeOverride || mediaType, logger)
        const fileSha256B64 = fileSha256.toString('base64')
        const {
            mediaUrl,
            directPath
        } = await options.upload(filePath, {
            fileEncSha256B64: fileSha256B64,
            mediaType: mediaType,
            timeoutMs: options.mediaUploadTimeoutMs
        })

        await fs_1.promises.unlink(filePath)

        const obj = Types_1.WAProto.Message.fromObject({
            [`${mediaType}Message`]: MessageTypeProto[mediaType].fromObject({
                url: mediaUrl,
                directPath,
                fileSha256,
                fileLength,
                ...uploadData,
                media: undefined
            })
        })

        if (uploadData.ptv) {
            obj.ptvMessage = obj.videoMessage
            delete obj.videoMessage
        }

        if (cacheableKey) {
            logger?.debug({
                cacheableKey
            }, 'set cache');
            await options.mediaCache.set(cacheableKey, Types_1.WAProto.Message.encode(obj).finish())
        }

        return obj
    }

    const requiresDurationComputation = (mediaType === 'audio' || mediaType === 'video') && typeof uploadData.seconds === 'undefined'
    const requiresThumbnailComputation = (mediaType === 'image' || mediaType === 'video') && typeof uploadData['jpegThumbnail'] === 'undefined'
    const requiresWaveformProcessing = mediaType === 'audio' && uploadData.ptt === true
    const requiresAudioBackground = options.backgroundColor && mediaType === 'audio' && uploadData.ptt === true
    const requiresOriginalForSomeProcessing = requiresDurationComputation || requiresThumbnailComputation

    const {
        mediaKey,
        encFilePath,
        originalFilePath,
        fileEncSha256,
        fileSha256,
        fileLength
    } = await messages_media_1.encryptedStream(uploadData.media, options.mediaTypeOverride || mediaType, {
        logger,
        saveOriginalFileIfRequired: requiresOriginalForSomeProcessing,
        opts: options.options,
        shouldConvert: uploadData.ptt
    })

    const fileEncSha256B64 = fileEncSha256.toString('base64')

    const [{
        mediaUrl,
        directPath
    }] = await Promise.all([
        (async () => {
            const result = await options.upload(encFilePath, {
                fileEncSha256B64,
                mediaType,
                timeoutMs: options.mediaUploadTimeoutMs
            })
            logger?.debug({
                mediaType,
                cacheableKey
            }, 'uploaded media')
            return result
        })(),

        (async () => {
            try {
                if (requiresThumbnailComputation) {
                    const {
                        thumbnail,
                        originalImageDimensions
                    } = await messages_media_1.generateThumbnail(originalFilePath, mediaType, options)
                    uploadData.jpegThumbnail = thumbnail
                    if (!uploadData.width && originalImageDimensions) {
                        uploadData.width = originalImageDimensions.width
                        uploadData.height = originalImageDimensions.height

                        logger?.debug('set dimensions')
                    }

                    logger?.debug('generated thumbnail');
                }

                if (requiresDurationComputation) {
                    if (mediaType === 'audio') {
                        uploadData.seconds = await messages_media_1.getAudioDuration(originalFilePath)
                        logger?.debug('computed audio duration')
                    } else {
                        uploadData.seconds = await messages_media_1.getVideoDuration(originalFilePath)
                        logger?.debug('computed video duration')
                    }
                }

                if (requiresWaveformProcessing) {
                    uploadData.waveform = await messages_media_1.getAudioWaveform(originalFilePath, logger)
                    logger?.debug('processed waveform')
                }

                if (requiresAudioBackground) {
                    uploadData.backgroundArgb = await assertColor(options.backgroundColor)
                    logger?.debug('computed backgroundColor audio status')
                }
            } catch (error) {
                logger?.warn({
                    trace: error.stack
                }, 'failed to obtain extra info')
            }
        })()
    ]).finally(async () => {
        try {
            await fs_1.promises.unlink(encFilePath)

            if (originalFilePath) {
                await fs_1.promises.unlink(originalFilePath)
            }

            logger?.debug('removed tmp files')
        } catch (error) {
            logger?.warn('failed to remove tmp file')
        }
    })

    const obj = Types_1.WAProto.Message.fromObject({
        [`${mediaType}Message`]: MessageTypeProto[mediaType].fromObject({
            url: mediaUrl,
            directPath,
            mediaKey,
            fileEncSha256,
            fileSha256,
            fileLength,
            mediaKeyTimestamp: generics_1.unixTimestampSeconds(),
            ...uploadData,
            media: undefined
        })
    })

    if (uploadData.ptv) {
        obj.ptvMessage = obj.videoMessage
        delete obj.videoMessage
    }

    if (cacheableKey) {
        logger?.debug({
            cacheableKey
        }, 'set cache');
        await options.mediaCache.set(cacheableKey, Types_1.WAProto.Message.encode(obj).finish())
    }

    return obj
}

const prepareAlbumMessageContent = async (jid, albums, options) => {
    let mediaHandle
    let mediaMsg
    let message = []

    const albumMsg = generateWAMessageFromContent(jid, {
        albumMessage: {
            expectedImageCount: albums.filter(item => 'image' in item).length,
            expectedVideoCount: albums.filter(item => 'video' in item).length
        }
    }, options)

    await options.sock.relayMessage(jid, albumMsg.message, {
        messageId: albumMsg.key.id
    })

    for (const i in albums) {
        const media = albums[i]

        if ('image' in media) {
            mediaMsg = await generateWAMessage(jid, {
                image: media.image,
                ...media,
                ...options
            }, {
                userJid: options.userJid,
                upload: async (encFilePath, opts) => {
                    const up = await options.sock.waUploadToServer(encFilePath, {
                        ...opts,
                        newsletter: WABinary_1.isJidNewsletter(jid)
                    })
                    mediaHandle = up.handle
                    return up
                },
                ...options
            })
        } else if ('video' in media) {
            mediaMsg = await generateWAMessage(jid, {
                video: media.video,
                ...media,
                ...options
            }, {
                userJid: options.userJid,
                upload: async (encFilePath, opts) => {
                    const up = await options.sock.waUploadToServer(encFilePath, {
                        ...opts,
                        newsletter: WABinary_1.isJidNewsletter(jid)
                    })
                    mediaHandle = up.handle
                    return up
                },
                ...options
            })
        }

        if (mediaMsg) {
            mediaMsg.message.messageContextInfo = {
                messageSecret: crypto_1.randomBytes(32),
                messageAssociation: {
                    associationType: 1,
                    parentMessageKey: albumMsg.key
                }
            }
        }

        message.push(mediaMsg)
    }

    return message
}

const prepareDisappearingMessageSettingContent = (expiration) => {
    const content = {
        ephemeralMessage: {
            message: {
                protocolMessage: {
                    type: Types_1.WAProto.Message.ProtocolMessage.Type.EPHEMERAL_SETTING,
                    ephemeralExpiration: expiration ? expiration : 0
                }
            }
        }
    }

    return Types_1.WAProto.Message.fromObject(content)
}

const generateForwardMessageContent = (message, forceForward) => {
    let content = message.message
    if (!content) {
        throw new boom_1.Boom('no content in message', {
            statusCode: 400
        })
    }

    content = normalizeMessageContent(content)
    content = WAProto_1.proto.Message.decode(WAProto_1.proto.Message.encode(content).finish())

    let key = Object.keys(content)[0]
    let score = content[key].contextInfo?.forwardingScore || 0

    if (forceForward) score += forceForward ? forceForward : 1

    if (key === 'conversation') {
        content.extendedTextMessage = {
            text: content[key]
        }
        delete content.conversation
        key = 'extendedTextMessage'
    }

    if (score > 0) {
        content[key].contextInfo = {
            forwardingScore: score,
            isForwarded: true
        }
    } else {
        content[key].contextInfo = {}
    }

    return content
}

const generateWAMessageContent = async (message, options) => {
    let m = {}

    // `raw`: envia el objeto de mensaje tal cual, sin ninguna transformacion.
    if ('raw' in message && !!message.raw) {
        delete message.raw
        return message
    }

    // Mensajes enriquecidos: bloques de codigo, tablas, entidades inline y citas.
    if ('code' in message || 'links' in message || 'table' in message || 'richResponse' in message) {
        m = rich_message_utils_1.prepareRichResponseMessage(message)
    } else if ('text' in message && !('interactive' in message) && !('interactiveButtons' in message) && !('sections' in message) && !('buttons' in message) && !('templateButtons' in message) && !('cards' in message)) {
        const extContent = {
            text: message.text
        }
        let urlInfo = message.linkPreview

        if (typeof urlInfo === 'undefined') {
            urlInfo = await generateLinkPreviewIfRequired(message.text, options.getUrlInfo, options.logger)
        }

        if (urlInfo) {
            extContent.canonicalUrl = urlInfo['canonical-url']
            extContent.matchedText = urlInfo['matched-text']
            extContent.jpegThumbnail = urlInfo.jpegThumbnail
            extContent.description = urlInfo.description
            extContent.title = urlInfo.title
            extContent.previewType = 0
            const img = urlInfo.highQualityThumbnail

            if (img) {
                extContent.thumbnailDirectPath = img.directPath
                extContent.mediaKey = img.mediaKey
                extContent.mediaKeyTimestamp = img.mediaKeyTimestamp
                extContent.thumbnailWidth = img.width
                extContent.thumbnailHeight = img.height
                extContent.thumbnailSha256 = img.fileSha256
                extContent.thumbnailEncSha256 = img.fileEncSha256
            }
        }

        if (options.backgroundColor) {
            extContent.backgroundArgb = await assertColor(options.backgroundColor)
        }

        if (options.textColor) {
            extContent.textArgb = await assertColor(options.textColor)
        }

        if (options.font) {
            extContent.font = options.font
        }

        extContent.contextInfo = {
            ...(message.contextInfo || {}),
            ...(message.mentions ? {
                mentionedJid: message.mentions
            } : {})
        }

        m.extendedTextMessage = extContent
    } else if ('contacts' in message) {
        const contactLen = message.contacts.contacts.length

        let contactMessage

        if (!contactLen) {
            throw new boom_1.Boom('require atleast 1 contact', {
                statusCode: 400
            })
        }

        if (contactLen === 1) {
            contactMessage = {
                contactMessage: Types_1.WAProto.Message.ContactMessage.fromObject(message.contacts.contacts[0])
            }
        } else {
            contactMessage = {
                contactsArrayMessage: Types_1.WAProto.Message.ContactsArrayMessage.fromObject(message.contacts)
            }
        }

        const [type] = Object.keys(contactMessage)

        contactMessage[type].contextInfo = {
            ...(message.contextInfo || {}),
            ...(message.mentions ? {
                mentionedJid: message.mentions
            } : {})
        }

        m = contactMessage
    } else if ('location' in message) {
        let locationMessage

        if (message.live) {
            locationMessage = {
                liveLocationMessage: Types_1.WAProto.Message.LiveLocationMessage.fromObject(message.location)
            }
        } else {
            locationMessage = {
                locationMessage: Types_1.WAProto.Message.LocationMessage.fromObject(message.location)
            }
        }

        const [type] = Object.keys(locationMessage)

        locationMessage[type].contextInfo = {
            ...(message.contextInfo || {}),
            ...(message.mentions ? {
                mentionedJid: message.mentions
            } : {})
        }

        m = locationMessage
    } else if ('react' in message) {
        if (!message.react.senderTimestampMs) {
            message.react.senderTimestampMs = Date.now()
        }

        m.reactionMessage = Types_1.WAProto.Message.ReactionMessage.fromObject(message.react)
    } else if ('delete' in message) {
        m.protocolMessage = {
            key: message.delete,
            type: Types_1.WAProto.Message.ProtocolMessage.Type.REVOKE
        }
    } else if ('forward' in message) {
        const mess = generateForwardMessageContent(message.forward, message.force)
        const [type] = Object.keys(mess)

        mess[type].contextInfo = {
            ...(message.contextInfo || {}),
            ...(message.mentions ? {
                mentionedJid: message.mentions
            } : {})
        }

        m = mess
    } else if ('disappearingMessagesInChat' in message) {
        const exp = typeof message.disappearingMessagesInChat === 'boolean' ? (message.disappearingMessagesInChat ? Defaults_1.WA_DEFAULT_EPHEMERAL : 0) : message.disappearingMessagesInChat
        m = prepareDisappearingMessageSettingContent(exp)
    } else if ('groupInvite' in message) {
        m.groupInviteMessage = {}

        m.groupInviteMessage.inviteCode = message.groupInvite.code
        m.groupInviteMessage.inviteExpiration = message.groupInvite.expiration
        m.groupInviteMessage.caption = message.groupInvite.caption
        m.groupInviteMessage.groupJid = message.groupInvite.jid
        m.groupInviteMessage.groupName = message.groupInvite.name
        m.groupInviteMessage.contextInfo = message.contextInfo

        if (options.getProfilePicUrl) {
            const pfpUrl = await options.getProfilePicUrl(message.groupInvite.jid)
            const { thumbnail } = await messages_media_1.generateThumbnail(pfpUrl, 'image')
            m.groupInviteMessage.jpegThumbnail = thumbnail
        }

        m.groupInviteMessage.contextInfo = {
            ...(message.contextInfo || {}),
            ...(message.mentions ? {
                mentionedJid: message.mentions
            } : {})
        }
    } else if ('adminInvite' in message) {
        m.newsletterAdminInviteMessage = {}

        m.newsletterAdminInviteMessage.newsletterJid = message.adminInvite.jid
        m.newsletterAdminInviteMessage.newsletterName = message.adminInvite.name
        m.newsletterAdminInviteMessage.caption = message.adminInvite.caption
        m.newsletterAdminInviteMessage.inviteExpiration = message.adminInvite.expiration
        m.newsletterAdminInviteMessage.contextInfo = message.contextInfo

        if (options.getProfilePicUrl) {
            const pfpUrl = await options.getProfilePicUrl(message.adminInvite.jid)
            const {
                thumbnail
            } = await messages_media_1.generateThumbnail(pfpUrl, 'image')
            m.newsletterAdminInviteMessage.jpegThumbnail = thumbnail
        }

        m.newsletterAdminInviteMessage.contextInfo = {
            ...(message.contextInfo || {}),
            ...(message.mentions ? {
                mentionedJid: message.mentions
            } : {})
        }
    } else if ('pin' in message) {
        m.pinInChatMessage = {}
        m.messageContextInfo = {}

        m.pinInChatMessage.key = message.pin.key
        m.pinInChatMessage.type = message.pin?.type || 1
        m.pinInChatMessage.senderTimestampMs = message.pin?.time || Date.now()
        m.messageContextInfo.messageAddOnDurationInSecs = message.pin.type === 1 ? message.pin.time || 86400 : 0
        m.messageContextInfo.messageAddOnExpiryType = WAProto_1.proto.MessageContextInfo.MessageAddonExpiryType.STATIC
    } else if ('keep' in message) {
        m.keepInChatMessage = {}

        m.keepInChatMessage.key = message.keep.key
        m.keepInChatMessage.keepType = message.keep?.type || 1
        m.keepInChatMessage.timestampMs = message.keep?.time || Date.now()
    } else if ('call' in message) {
        m.scheduledCallCreationMessage = {}

        m.scheduledCallCreationMessage.scheduledTimestampMs = message.call?.time || Date.now()
        m.scheduledCallCreationMessage.callType = message.call?.type || 1
        m.scheduledCallCreationMessage.title = message.call?.name || 'Call Creation'

        m.scheduledCallCreationMessage.contextInfo = {
            ...(message.contextInfo || {}),
            ...(message.mentions ? {
                mentionedJid: message.mentions
            } : {})
        }
    } else if ('paymentInvite' in message) {
        m.messageContextInfo = {}
        m.paymentInviteMessage = {}

        m.paymentInviteMessage.expiryTimestamp = message.paymentInvite?.expiry || 0
        m.paymentInviteMessage.serviceType = message.paymentInvite?.type || 2

        m.paymentInviteMessage.contextInfo = {
            ...(message.contextInfo || {}),
            ...(message.mentions ? {
                mentionedJid: message.mentions
            } : {})
        }
    } else if ('buttonReply' in message) {
        switch (message.type) {
            case 'list':
                m.listResponseMessage = {
                    title: message.buttonReply.title,
                    description: message.buttonReply.description,
                    singleSelectReply: {
                        selectedRowId: message.buttonReply.rowId
                    },
                    lisType: WAProto_1.proto.Message.ListResponseMessage.ListType.SINGLE_SELECT
                }
                break
            case 'template':
                m.templateButtonReplyMessage = {
                    selectedDisplayText: message.buttonReply.displayText,
                    selectedId: message.buttonReply.id,
                    selectedIndex: message.buttonReply.index
                }
                break
            case 'plain':
                m.buttonsResponseMessage = {
                    selectedButtonId: message.buttonReply.id,
                    selectedDisplayText: message.buttonReply.displayText,
                    type: WAProto_1.proto.Message.ButtonsResponseMessage.Type.DISPLAY_TEXT
                }
                break
            case 'interactive':
                m.interactiveResponseMessage = {
                    body: {
                        text: message.buttonReply.displayText,
                        format: WAProto_1.proto.Message.InteractiveResponseMessage.Body.Format.EXTENSIONS_1
                    },
                    nativeFlowResponseMessage: {
                        name: message.buttonReply.nativeFlows.name,
                        paramsJson: message.buttonReply.nativeFlows.paramsJson,
                        version: message.buttonReply.nativeFlows.version
                    }
                }
                break
        }
    } else if ('ptv' in message && message.ptv) {
        const {
            videoMessage
        } = await prepareWAMessageMedia({
            video: message.video
        }, options)

        m.ptvMessage = videoMessage
    } else if ('album' in message) {
        const imageMessages = message.album.filter(item => 'image' in item)
        const videoMessages = message.album.filter(item => 'video' in item)

        m.albumMessage = Types_1.WAProto.Message.AlbumMessage.fromObject({
            expectedImageCount: imageMessages.length,
            expectedVideoCount: videoMessages.length
        })
    } else if ('order' in message) {
        m.orderMessage = Types_1.WAProto.Message.OrderMessage.fromObject(message.order)

        m.orderMessage.contextInfo = {
            ...(message.contextInfo || {}),
            ...(message.mentions ? {
                mentionedJid: message.mentions
            } : {})
        }
    } else if ('event' in message) {
        m.eventMessage = Types_1.WAProto.Message.EventMessage.fromObject(message.event)

        if (!message.event.startTime) {
            m.eventMessage.startTime = generics_1.unixTimestampSeconds() + 86400
        }

        if (options.getCallLink && message.event.call) {
            const link = await options.getCallLink(message.event.call, m.eventMessage.startTime)
            m.eventMessage.joinLink = link
        }

        m.eventMessage.contextInfo = {
            ...(message.contextInfo || {}),
            ...(message.mentions ? {
                mentionedJid: message.mentions
            } : {})
        }
    } else if ('product' in message) {
        const { imageMessage } = await prepareWAMessageMedia({
            image: message.product.productImage
        }, options)

        m.productMessage = Types_1.WAProto.Message.ProductMessage.fromObject({
            ...message,
            product: {
                ...message.product,
                productImage: imageMessage,
            }
        })

        m.productMessage.contextInfo = {
            ...(message.contextInfo || {}),
            ...(message.mentions ? {
                mentionedJid: message.mentions
            } : {})
        }
    } else if ('pollResult' in message) {
        if (!Array.isArray(message.pollResult.values)) {
            throw new boom_1.Boom('Invalid pollResult values', {
                statusCode: 400
            })
        }

        const pollResultSnapshotMessage = {
            name: message.pollResult.name,
            pollVotes: message.pollResult.values.map(([optionName, optionVoteCount]) => ({
                optionName,
                optionVoteCount
            }))
        }

        pollResultSnapshotMessage.contextInfo = {
            ...(message.contextInfo || {}),
            ...(message.mentions ? {
                mentionedJid: message.mentions
            } : {})
        }

        m.pollResultSnapshotMessage = pollResultSnapshotMessage
    } else if ('poll' in message) {
        if (!Array.isArray(message.poll.values)) {
            throw new boom_1.Boom('Invalid poll values', {
                statusCode: 400
            })
        }

        if (message.poll.selectableCount < 0 ||
            message.poll.selectableCount > message.poll.values.length) {
            throw new boom_1.Boom(`poll.selectableCount in poll should be >= 0 and <= ${message.poll.values.length}`, {
                statusCode: 400
            })
        }

        const pollCreationMessage = {
            name: message.poll.name,
            selectableOptionsCount: message.poll?.selectableCount || 0,
            options: message.poll.values.map(optionName => ({
                optionName
            })),
        }

        pollCreationMessage.contextInfo = {
            ...(message.contextInfo || {}),
            ...(message.mentions ? {
                mentionedJid: message.mentions
            } : {})
        }

        if (message.poll?.toAnnouncementGroup) {
            m.pollCreationMessageV2 = pollCreationMessage
        } else {
            if (message.poll.selectableCount > 0) {
                m.pollCreationMessageV3 = pollCreationMessage
            } else {
                m.pollCreationMessage = pollCreationMessage
            }
        }
    } else if ('payment' in message || 'requestPayment' in message) {
        const paymentData = message.payment || message.requestPayment
        const requestPaymentMessage = {
            amount: {
                currencyCode: paymentData?.currency || 'IDR',
                offset: paymentData?.offset || 0,
                value: paymentData?.amount || 999999999
            },
            expiryTimestamp: paymentData?.expiry || 0,
            amount1000: paymentData?.amount || 999999999 * 1000,
            currencyCodeIso4217: paymentData?.currency || 'IDR',
            requestFrom: paymentData?.from || '0@s.whatsapp.net',
            noteMessage: {},
            background: {
                placeholderArgb: paymentData?.background?.placeholderArgb || paymentData?.image?.placeholderArgb || 4278190080,
                textArgb: paymentData?.background?.textArgb || paymentData?.image?.textArgb || 4294967295,
                subtextArgb: paymentData?.background?.subtextArgb || paymentData?.image?.subtextArgb || 4294967295,
                type: 1
            }
        }

        // Support sticker as noteMessage (buffer or url)
        if (paymentData?.sticker) {
            const { stickerMessage } = await prepareWAMessageMedia({
                sticker: paymentData.sticker
            }, options)
            requestPaymentMessage.noteMessage.stickerMessage = stickerMessage
            requestPaymentMessage.noteMessage.stickerMessage.contextInfo = {
                ...(message.contextInfo || {}),
                ...(message.mentions ? {
                    mentionedJid: message.mentions
                } : {})
            }
        } else {
            requestPaymentMessage.noteMessage.extendedTextMessage = {
                text: paymentData?.note || 'Notes'
            }
            requestPaymentMessage.noteMessage.extendedTextMessage.contextInfo = {
                ...(message.contextInfo || {}),
                ...(message.mentions ? {
                    mentionedJid: message.mentions
                } : {})
            }
        }

        m.requestPaymentMessage = requestPaymentMessage
    } else if ('stickerPack' in message) {
        m = await prepareStickerPackMessage(message.stickerPack, options)
    } else if ('sharePhoneNumber' in message) {
        m.protocolMessage = {
            type: Types_1.WAProto.Message.ProtocolMessage.Type.SHARE_PHONE_NUMBER
        }
    } else if ('requestPhoneNumber' in message) {
        m.requestPhoneNumberMessage = {}
    } else if (Defaults_1.MEDIA_KEYS.some(k => k in message)) {
        // Solo intentamos subir media si el contenido trae realmente una clave de media.
        // Los mensajes interactivos sin media (botones, listas, cards) se construyen
        // en el bloque siguiente, asi que no deben caer aqui.
        const mess = await prepareWAMessageMedia(message, options)
        const [type] = Object.keys(mess)

        mess[type].contextInfo = {
            ...(message.contextInfo || {}),
            ...(message.mentions ? {
                mentionedJid: message.mentions
            } : {})
        }

        m = mess
    }

    if ('sections' in message && !!message.sections) {
        const listMessage = {
            title: message.title,
            buttonText: message.buttonText,
            footerText: message.footer,
            description: message.text,
            sections: message.sections,
            listType: WAProto_1.proto.Message.ListMessage.ListType.SINGLE_SELECT
        }

        listMessage.contextInfo = {
            ...(message.contextInfo || {}),
            ...(message.mentions ? {
                mentionedJid: message.mentions
            } : {})
        }

        m = {
            listMessage
        }
    } else if ('productList' in message && !!message.productList) {
        const thumbnail = message.thumbnail ? await messages_media_1.generateThumbnail(message.thumbnail, 'image') : null

        const listMessage = {
            title: message.title,
            buttonText: message.buttonText,
            footerText: message.footer,
            description: message.text,
            productListInfo: {
                productSections: message.productList,
                headerImage: {
                    productId: message.productList[0].products[0].productId,
                    jpegThumbnail: thumbnail?.thumbnail || null
                },
                businessOwnerJid: message.businessOwnerJid
            },
            listType: WAProto_1.proto.Message.ListMessage.ListType.PRODUCT_LIST
        }

        listMessage.contextInfo = {
            ...(message.contextInfo || {}),
            ...(message.mentions ? {
                mentionedJid: message.mentions
            } : {})
        }

        m = {
            listMessage
        }
    } else if ('buttons' in message && !!message.buttons) {
        const hasNativeFlow = message.buttons.some(b => b.nativeFlowInfo || b.type === 4 || b.type === 2)
        const buttonsMessage = {
            buttons: message.buttons.map(b => {
                if (b.nativeFlowInfo || b.type === 4 || b.type === 2) {
                    return {
                        ...b,
                        type: WAProto_1.proto.Message.ButtonsMessage.Button.Type.NATIVE_FLOW || 2
                    }
                }
                return {
                    ...b,
                    type: b.type || WAProto_1.proto.Message.ButtonsMessage.Button.Type.RESPONSE
                }
            })
        }

        if ('text' in message) {
            buttonsMessage.contentText = message.text
            buttonsMessage.headerType = message.headerType || WAProto_1.proto.Message.ButtonsMessage.HeaderType.EMPTY
        } else {
            if ('caption' in message) {
                buttonsMessage.contentText = message.caption
            }

            if (message.headerType) {
                buttonsMessage.headerType = message.headerType
            } else {
                const type = Object.keys(m)[0].replace('Message', '').toUpperCase()
                buttonsMessage.headerType = WAProto_1.proto.Message.ButtonsMessage.HeaderType[type]
            }

            Object.assign(buttonsMessage, m)
        }

        if ('footer' in message && !!message.footer) {
            buttonsMessage.footerText = message.footer
        }

        if ('title' in message && !!message.title) {
            buttonsMessage.text = message.title
            if (!message.headerType) {
                buttonsMessage.headerType = WAProto_1.proto.Message.ButtonsMessage.HeaderType.TEXT
            }
        }

        buttonsMessage.contextInfo = {
            ...(message.contextInfo || {}),
            ...(message.mentions ? {
                mentionedJid: message.mentions
            } : {})
        }

        m = {
            buttonsMessage
        }
    } else if ('template' in message && !!message.templateButtons) {
        const hydratedTemplate = {
            hydratedButtons: message.templateButtons
        }

        if ('text' in message) {
            hydratedTemplate.hydratedContentText = message.text
        } else {
            if ('caption' in message) {
                hydratedTemplate.hydratedContentText = message.caption
            }

            Object.assign(hydratedTemplate, m)
        }

        if ('footer' in message && !!message.footer) {
            hydratedTemplate.hydratedFooterText = message.footer
        }

        hydratedTemplate.contextInfo = {
            ...(message.contextInfo || {}),
            ...(message.mentions ? {
                mentionedJid: message.mentions
            } : {})
        }

        m = {
            templateMessage: {
                hydratedTemplate
            }
        }
    } else if (('interactive' in message && !!message.interactive) || ('interactiveButtons' in message && !!message.interactiveButtons)) {
        const buttons = message.interactive || message.interactiveButtons
        const interactiveMessage = {
            nativeFlowMessage: {
                buttons: buttons
            }
        }

        // Handle media (image/video) with interactive buttons
        if ('image' in message || 'video' in message) {
            const mediaContent = await prepareWAMessageMedia(message, options)
            const mediaType = 'image' in message ? 'imageMessage' : 'videoMessage'
            
            interactiveMessage.header = {
                title: message.title || '',
                subtitle: message.subtitle || '',
                hasMediaAttachment: true,
                [mediaType]: mediaContent[mediaType]
            }
            
            interactiveMessage.body = {
                text: message.caption || ''
            }
        } else if ('product' in message) {
            // Handle product header
            const { imageMessage } = await prepareWAMessageMedia({
                image: message.product.productImage
            }, options)
            
            interactiveMessage.header = {
                title: message.title || '',
                subtitle: message.subtitle || '',
                hasMediaAttachment: true,
                productMessage: {
                    product: {
                        ...message.product,
                        productImage: imageMessage,
                    },
                    businessOwnerJid: message.businessOwnerJid || '0@s.whatsapp.net'
                }
            }
            
            interactiveMessage.body = {
                text: message.caption || ''
            }
        } else {
            // Text only
            const bodyText = message.text || message.caption || ''
            if (bodyText) {
                interactiveMessage.body = {
                    text: bodyText
                }
                interactiveMessage.header = {
                    title: message.title || '',
                    subtitle: message.subtitle || '',
                    hasMediaAttachment: false
                }
            }
        }

        if ('footer' in message && !!message.footer) {
            interactiveMessage.footer = {
                text: message.footer
            }
        }

        interactiveMessage.contextInfo = {
            ...(message.contextInfo || {}),
            ...(message.mentions ? {
                mentionedJid: message.mentions
            } : {})
        }

        m = {
            interactiveMessage
        }
    } else if ('shop' in message && !!message.shop) {
        const interactiveMessage = {
            shopStorefrontMessage: {
                surface: message.shop.surface,
                id: message.shop.id
            }
        }

        if ('text' in message) {
            interactiveMessage.body = {
                text: message.text
            }
            interactiveMessage.header = {
                title: message.title,
                subtitle: message.subtitle,
                hasMediaAttachment: false
            }
        } else {
            if ('caption' in message) {
                interactiveMessage.body = {
                    text: message.caption
                }

                interactiveMessage.header = {
                    title: message.title,
                    subtitle: message.subtitle,
                    hasMediaAttachment: message.hasMediaAttachment ? message.hasMediaAttachment : false,
                    ...Object.assign(interactiveMessage, m)
                }
            }
        }

        if ('footer' in message && !!message.footer) {
            interactiveMessage.footer = {
                text: message.footer
            }
        }

        interactiveMessage.contextInfo = {
            ...(message.contextInfo || {}),
            ...(message.mentions ? {
                mentionedJid: message.mentions
            } : {})
        }

        m = {
            interactiveMessage
        }
    } else if ('collection' in message && !!message.collection) {
        const interactiveMessage = {
            collectionMessage: {
                bizJid: message.collection.bizJid,
                id: message.collection.id,
                messageVersion: message?.collection?.version
            }
        }

        if ('text' in message) {
            interactiveMessage.body = {
                text: message.text
            }
            interactiveMessage.header = {
                title: message.title,
                subtitle: message.subtitle,
                hasMediaAttachment: false
            }
        } else {
            if ('caption' in message) {
                interactiveMessage.body = {
                    text: message.caption
                }
                interactiveMessage.header = {
                    title: message.title,
                    subtitle: message.subtitle,
                    hasMediaAttachment: message.hasMediaAttachment ? message.hasMediaAttachment : false,
                    ...Object.assign(interactiveMessage, m)
                }
            }
        }

        if ('footer' in message && !!message.footer) {
            interactiveMessage.footer = {
                text: message.footer
            }
        }

        interactiveMessage.contextInfo = {
            ...(message.contextInfo || {}),
            ...(message.mentions ? {
                mentionedJid: message.mentions
            } : {})
        }

        m = {
            interactiveMessage
        }
    } else if ('cards' in message && !!message.cards) {
        const slides = await Promise.all(message.cards.map(async (slide) => {
            const {
                image,
                video,
                product,
                title,
                body,
                footer,
                buttons
            } = slide
            let header

            if (product) {
                const { imageMessage } = await prepareWAMessageMedia({
                    image: product.productImage,
                    ...options
                }, options)
                header = {
                    productMessage: {
                        product: {
                            ...product,
                            productImage: imageMessage,
                        },
                        ...slide
                    }
                }
            } else if (image) {
                header = await prepareWAMessageMedia({
                    image: image,
                    ...options
                }, options)
            } else if (video) {
                header = await prepareWAMessageMedia({
                    video: video,
                    ...options
                }, options)
            }

            const msg = {
                header: {
                    title,
                    hasMediaAttachment: true,
                    ...header
                },
                body: {
                    text: body
                },
                footer: {
                    text: footer
                },
                nativeFlowMessage: {
                    buttons,
                }
            }

            return msg
        }))

        const interactiveMessage = {
            carouselMessage: {
                cards: slides
            }
        }

        if ('text' in message) {
            interactiveMessage.body = {
                text: message.text
            }
            interactiveMessage.header = {
                title: message.title,
                subtitle: message.subtitle,
                hasMediaAttachment: false
            }
        }

        if ('footer' in message && !!message.footer) {
            interactiveMessage.footer = {
                text: message.footer
            }
        }

        interactiveMessage.contextInfo = {
            ...(message.contextInfo || {}),
            ...(message.mentions ? {
                mentionedJid: message.mentions
            } : {})
        }

        m = {
            interactiveMessage
        }
    }

    // Factura: convierte la imagen/documento ya subido en un invoiceMessage
    if ('invoiceNote' in message && !!message.invoiceNote) {
        const attachment = m.imageMessage || m.documentMessage
        if (!attachment) {
            throw new boom_1.Boom('Tipo de media invalido para un mensaje de factura (usa image o document)', {
                statusCode: 400
            })
        }
        const type = Object.keys(m)[0].replace('Message', '').toUpperCase()
        const {
            directPath, fileEncSha256, fileSha256, jpegThumbnail,
            mediaKey, mediaKeyTimestamp, mimetype
        } = attachment
        m = {
            invoiceMessage: {
                attachmentType: Types_1.WAProto.Message.InvoiceMessage.AttachmentType[type === 'DOCUMENT' ? 'PDF' : 'IMAGE'],
                note: message.invoiceNote,
                attachmentDirectPath: directPath,
                attachmentFileEncSha256: fileEncSha256,
                attachmentFileSha256: fileSha256,
                attachmentJpegThumbnail: jpegThumbnail,
                attachmentMediaKey: mediaKey,
                attachmentMediaKeyTimestamp: mediaKeyTimestamp,
                attachmentMimetype: mimetype,
                token: generics_1.generateMessageIDV2()
            }
        }
    }

    if ('externalAdReply' in message && message.externalAdReply) {
        const key = Object.keys(m)[0]
        if (key && m[key] && typeof m[key] === 'object') {
            m[key].contextInfo = { ...(m[key].contextInfo || {}), externalAdReply: message.externalAdReply }
        }
    }

    // `mentionAll`: menciona a todos los participantes de un grupo sin pasar sus JIDs
    if (('mentions' in message && message.mentions?.length) || ('mentionAll' in message && !!message.mentionAll)) {
        const key = m[Object.keys(m)[0]]
        if (key && typeof key === 'object') {
            key.contextInfo = key.contextInfo || {}
            if (message.mentions?.length) {
                key.contextInfo.mentionedJid = message.mentions
            }
            if (message.mentionAll) {
                key.contextInfo.nonJidMentions = 1
            }
        }
    }

    // `spoiler`: marca el contenido como oculto tras un toque
    if ('spoiler' in message && !!message.spoiler) {
        const key = m[Object.keys(m)[0]]
        if (key && typeof key === 'object') {
            key.contextInfo = { ...(key.contextInfo || {}), isSpoiler: true }
        }
        m = {
            spoilerMessage: {
                message: m
            }
        }
    }
    // `interactiveAsTemplate`: envuelve un interactiveMessage en un templateMessage
    else if ('interactiveAsTemplate' in message && !!message.interactiveAsTemplate) {
        if (!m.interactiveMessage) {
            throw new boom_1.Boom('`interactiveAsTemplate` solo aplica a mensajes interactivos', {
                statusCode: 400
            })
        }
        m = {
            templateMessage: {
                interactiveMessageTemplate: m.interactiveMessage,
                templateId: message.id || 'template-' + Date.now(),
                contextInfo: m.interactiveMessage.contextInfo
            }
        }
    }

    // `isLottie`: envuelve el mensaje en un lottieStickerMessage
    if ('isLottie' in message && !!message.isLottie) {
        m = {
            lottieStickerMessage: {
                message: m
            }
        }
    }

    if ('ephemeral' in message && !!message.ephemeral) {
        m = {
            ephemeralMessage: {
                message: m
            }
        }
    }

    if ('viewOnce' in message && !!message.viewOnce) {
        m = {
            viewOnceMessage: {
                message: m
            }
        }
    }

    if ('viewOnceV2' in message && !!message.viewOnceV2) {
        m = {
            viewOnceMessageV2: {
                message: m
            }
        }
    }

    if ('viewOnceExt' in message && !!message.viewOnceExt) {
        m = {
            viewOnceMessageV2Extension: {
                message: m
            }
        }
    }

    if ('viewOnceV2Extension' in message && !!message.viewOnceV2Extension) {
        m = {
            viewOnceMessageV2Extension: {
                message: m
            }
        }
    }

    if ('edit' in message) {
        m = {
            protocolMessage: {
                key: message.edit,
                editedMessage: m,
                timestampMs: Date.now(),
                type: Types_1.WAProto.Message.ProtocolMessage.Type.MESSAGE_EDIT
            }
        }
    }

    return Types_1.WAProto.Message.fromObject(m)
}

const generateWAMessageFromContent = (jid, message, options) => {
    if (!options.timestamp) {
        options.timestamp = new Date()
    }

    const innerMessage = normalizeMessageContent(message)
    const key = getContentType(innerMessage)
    const timestamp = generics_1.unixTimestampSeconds(options.timestamp)
    const {
        quoted,
        userJid
    } = options

    if (quoted && !WABinary_1.isJidNewsletter(jid)) {
        const participant = quoted.key.fromMe ? userJid : quoted.participant || quoted.key.participant || quoted.key.remoteJid
        let quotedMsg = normalizeMessageContent(quoted.message)
        const msgType = getContentType(quotedMsg)

        quotedMsg = WAProto_1.proto.Message.fromObject({
            [msgType]: quotedMsg[msgType]
        })

        const quotedContent = quotedMsg[msgType]
        if (typeof quotedContent === 'object' && quotedContent && 'contextInfo' in quotedContent) {
            delete quotedContent.contextInfo
        }

        let requestPayment
        if (key === 'requestPaymentMessage') {
            if (innerMessage?.requestPaymentMessage && innerMessage?.requestPaymentMessage?.noteMessage?.extendedTextMessage) {
                requestPayment = innerMessage?.requestPaymentMessage?.noteMessage?.extendedTextMessage
            } else if (innerMessage?.requestPaymentMessage && innerMessage?.requestPaymentMessage?.noteMessage?.stickerMessage) {
                requestPayment = innerMessage.requestPaymentMessage?.noteMessage?.stickerMessage
            }
        }

        const contextInfo = (key === 'requestPaymentMessage'
            ? requestPayment?.contextInfo
            : (typeof innerMessage[key] === 'object' ? innerMessage[key]?.contextInfo : undefined)) || {}
        contextInfo.participant = WABinary_1.jidNormalizedUser(participant)
        contextInfo.stanzaId = quoted.key.id
        contextInfo.quotedMessage = quotedMsg

        if (jid !== quoted.key.remoteJid) {
            contextInfo.remoteJid = quoted.key.remoteJid
        }

        if (contextInfo.quotedMessage) {
            contextInfo.quotedType = WAProto_1.proto.ContextInfo.QuotedType.EXPLICIT
        }

        if (key === 'requestPaymentMessage' && requestPayment) {
            requestPayment.contextInfo = contextInfo
        } else if (innerMessage[key] && typeof innerMessage[key] === 'object') {
            innerMessage[key].contextInfo = contextInfo
        }
    }

    if (key !== 'protocolMessage' && key !== 'ephemeralMessage' && !WABinary_1.isJidNewsletter(jid)) {
        // Las reacciones, votos de encuesta y respuestas de evento no llevan
        // reporting token, asi que tampoco necesitan messageSecret.
        if (reporting_utils_1.shouldIncludeReportingToken(innerMessage)) {
            message.messageContextInfo = {
                messageSecret: crypto_1.randomBytes(32),
                ...message.messageContextInfo
            }
        }
        // `conversation` es un string plano: no admite contextInfo
        if (innerMessage[key] && typeof innerMessage[key] === 'object') {
            innerMessage[key].contextInfo = {
                ...(innerMessage[key].contextInfo || {}),
                expiration: options.ephemeralExpiration ? options.ephemeralExpiration : 0
            }
        }
    }

    message = Types_1.WAProto.Message.fromObject(message)

    const messageJSON = {
        key: {
            remoteJid: jid,
            fromMe: true,
            id: options?.messageId || generics_1.generateMessageID()
        },
        message: message,
        messageTimestamp: timestamp,
        messageStubParameters: [],
        participant: WABinary_1.isJidGroup(jid) || WABinary_1.isJidStatusBroadcast(jid) ? userJid : undefined,
        status: Types_1.WAMessageStatus.PENDING
    }

    return Types_1.WAProto.WebMessageInfo.fromObject(messageJSON)
}

const generateWAMessage = async (jid, content, options) => {
    options.logger = options?.logger?.child({
        msgId: options.messageId
    })

    return generateWAMessageFromContent(jid, await generateWAMessageContent(content, {
        newsletter: WABinary_1.isJidNewsletter(jid),
        ...options
    }), options)
}

const getContentType = (content) => {
    if (content) {
        const keys = Object.keys(content)
        const key = keys.find(k => (k === 'conversation' || k.endsWith('Message') || k.endsWith('V2') || k.endsWith('V3') || k.endsWith('V4') || k.endsWith('V5')) && k !== 'senderKeyDistributionMessage' && k !== 'messageContextInfo')

        return key
    }
}

const normalizeMessageContent = (content) => {
    if (!content) {
        return undefined
    }

    for (let i = 0; i < 5; i++) {
        const inner = getFutureProofMessage(content)
        if (!inner) {
            break
        }

        content = inner.message
    }

    return content

    function getFutureProofMessage(message) {
        return ((message === null || message === void 0 ? void 0 : message.editedMessage) || (message === null || message === void 0 ? void 0 : message.statusAddYours) || (message === null || message === void 0 ? void 0 : message.botTaskMessage) || (message === null || message === void 0 ? void 0 : message.eventCoverImage) || (message === null || message === void 0 ? void 0 : message.questionMessage) || (message === null || message === void 0 ? void 0 : message.viewOnceMessage) || (message === null || message === void 0 ? void 0 : message.botInvokeMessage) || (message === null || message === void 0 ? void 0 : message.ephemeralMessage) || (message === null || message === void 0 ? void 0 : message.lottieStickerMessage) || (message === null || message === void 0 ? void 0 : message.groupStatusMessage) || (message === null || message === void 0 ? void 0 : message.limitSharingMessage) || (message === null || message === void 0 ? void 0 : message.viewOnceMessageV2) || (message === null || message === void 0 ? void 0 : message.botForwardedMessage) || (message === null || message === void 0 ? void 0 : message.statusMentionMessage) || (message === null || message === void 0 ? void 0 : message.groupStatusMessageV2) || (message === null || message === void 0 ? void 0 : message.pollCreationMessageV4) || (message === null || message === void 0 ? void 0 : message.pollCreationMessageV5) || (message === null || message === void 0 ? void 0 : message.associatedChildMessage) || (message === null || message === void 0 ? void 0 : message.groupMentionedMessage) || (message === null || message === void 0 ? void 0 : message.groupStatusMentionMessage) || (message === null || message === void 0 ? void 0 : message.viewOnceMessageV2Extension) || (message === null || message === void 0 ? void 0 : message.documentWithCaptionMessage) || (message === null || message === void 0 ? void 0 : message.pollCreationOptionImageMessage))
    }
}

const extractMessageContent = (content) => {
    const extractFromButtonsMessage = (msg) => {
        const header = typeof msg.header === 'object' && msg.header !== null

        if (header ? msg.header?.imageMessage : msg.imageMessage) {
            return {
                imageMessage: header ? msg.header.imageMessage : msg.imageMessage
            }
        } else if (header ? msg.header?.documentMessage : msg.documentMessage) {
            return {
                documentMessage: header ? msg.header.documentMessage : msg.documentMessage
            }
        } else if (header ? msg.header?.videoMessage : msg.videoMessage) {
            return {
                videoMessage: header ? msg.header.videoMessage : msg.videoMessage
            }
        } else if (header ? msg.header?.locationMessage : msg.locationMessage) {
            return {
                locationMessage: header ? msg.header.locationMessage : msg.locationMessage
            }
        } else if (header ? msg.header?.productMessage : msg.productMessage) {
            return {
                productMessage: header ? msg.header.productMessage : msg.productMessage
            }
        } else {
            return {
                conversation: 'contentText' in msg ? msg.contentText : ('hydratedContentText' in msg ? msg.hydratedContentText : 'body' in msg ? msg.body.text : '')
            }
        }
    }

    content = normalizeMessageContent(content)
    if (content?.buttonsMessage) {
        return extractFromButtonsMessage(content.buttonsMessage)
    }
    if (content?.interactiveMessage) {
        return extractFromButtonsMessage(content.interactiveMessage)
    }
    if (content?.templateMessage?.interactiveMessageTemplate) {
        return extractFromButtonsMessage(content?.templateMessage?.interactiveMessageTemplate)
    }
    if (content?.templateMessage?.hydratedFourRowTemplate) {
        return extractFromButtonsMessage(content?.templateMessage?.hydratedFourRowTemplate)
    }
    if (content?.templateMessage?.hydratedTemplate) {
        return extractFromButtonsMessage(content?.templateMessage?.hydratedTemplate)
    }
    if (content?.templateMessage?.fourRowTemplate) {
        return extractFromButtonsMessage(content?.templateMessage?.fourRowTemplate)
    }
    return content
}

const getDevice = (id) => /^3A.{18}$/.test(id) ? 'ios' : /^3E.{20}$/.test(id) ? 'web' : /^(.{21}|.{32})$/.test(id) ? 'android' : /^(3F|.{18}$)/.test(id) ? 'desktop' : 'bots'

const updateMessageWithReceipt = (msg, receipt) => {
    msg.userReceipt = msg.userReceipt || []
    const recp = msg.userReceipt.find(m => m.userJid === receipt.userJid)
    if (recp) {
        Object.assign(recp, receipt)
    } else {
        msg.userReceipt.push(receipt)
    }
}

const updateMessageWithReaction = (msg, reaction) => {
    const authorID = generics_1.getKeyAuthor(reaction.key)
    const reactions = (msg.reactions || []).filter(r => generics_1.getKeyAuthor(r.key) !== authorID)
    reaction.text = reaction.text || ''
    reactions.push(reaction)
    msg.reactions = reactions
}

const updateMessageWithPollUpdate = (msg, update) => {
    const authorID = generics_1.getKeyAuthor(update.pollUpdateMessageKey)
    const votes = (msg.pollUpdates || []).filter(r => generics_1.getKeyAuthor(r.pollUpdateMessageKey) !== authorID)

    if (update.vote?.selectedOptions?.length) {
        votes.push(update)
    }

    msg.pollUpdates = votes
}

function getAggregateVotesInPollMessage({
    message,
    pollUpdates
}, meId) {
    message = normalizeMessageContent(message)

    const opts = message?.pollCreationMessage?.options || message?.pollCreationMessageV2?.options || message?.pollCreationMessageV3?.options || []

    const voteHashMap = opts.reduce((acc, opt) => {
        const hash = crypto_2.sha256(Buffer.from(opt.optionName || '')).toString()
        acc[hash] = {
            name: opt.optionName || '',
            voters: []
        }

        return acc
    }, {})

    for (const update of pollUpdates || []) {
        const { vote } = update
        if (!vote) {
            continue
        }

        for (const option of vote.selectedOptions || []) {
            const hash = option.toString()
            let data = voteHashMap[hash]

            if (!data) {
                voteHashMap[hash] = {
                    name: 'Unknown',
                    voters: []
                }

                data = voteHashMap[hash]
            }

            voteHashMap[hash].voters.push(generics_1.getKeyAuthor(update.pollUpdateMessageKey, meId))
        }
    }

    return Object.values(voteHashMap)
}

const aggregateMessageKeysNotFromMe = (keys) => {
    const keyMap = {}

    for (const { remoteJid, id, participant, fromMe } of keys) {
        if (!fromMe) {
            const uqKey = `${remoteJid}:${participant || ''}`

            if (!keyMap[uqKey]) {
                keyMap[uqKey] = {
                    jid: remoteJid,
                    participant: participant,
                    messageIds: []
                }
            }

            keyMap[uqKey].messageIds.push(id)
        }
    }

    return Object.values(keyMap)
}

const REUPLOAD_REQUIRED_STATUS = [410, 404]

const downloadMediaMessage = async (message, type, options, ctx) => {
    const result = await downloadMsg().catch(async (error) => {
        if (ctx && axios_1.default.isAxiosError(error) && REUPLOAD_REQUIRED_STATUS.includes(error.response?.status)) {
            ctx.logger.info({
                key: message.key
            }, 'sending reupload media request...')

            message = await ctx.reuploadRequest(message)
            const result = await downloadMsg()
            return result
        }
        throw error
    })

    return result

    async function downloadMsg() {
        const mContent = extractMessageContent(message.message)
        if (!mContent) {
            throw new boom_1.Boom('No message present', {
                statusCode: 400,
                data: message
            })
        }

        const contentType = getContentType(mContent)
        let mediaType = contentType?.replace('Message', '')
        const media = contentType === 'productMessage' ? mContent[contentType]?.product?.productImage : mContent[contentType]

        if (!media || typeof media !== 'object' || (!('url' in media) && !('thumbnailDirectPath' in media))) {
            throw new boom_1.Boom(`"${contentType}" message is not a media message`)
        }

        let download

        if ('thumbnailDirectPath' in media && !('url' in media)) {
            download = {
                directPath: media.thumbnailDirectPath,
                mediaKey: media.mediaKey
            }
            mediaType = 'thumbnail-link'
        } else {
            download = media
        }

        const stream = await messages_media_1.downloadContentFromMessage(download, mediaType, options)

        if (type === 'buffer') {
            const bufferArray = []

            for await (const chunk of stream) {
                bufferArray.push(chunk)
            }

            return Buffer.concat(bufferArray)
        }

        return stream
    }
}

const assertMediaContent = (content) => {
    content = extractMessageContent(content)

    const mediaContent = content?.documentMessage || content?.imageMessage || content?.videoMessage || content?.audioMessage || content?.stickerMessage
    if (!mediaContent) {
        throw new boom_1.Boom('given message is not a media message', {
            statusCode: 400,
            data: content
        })
    }
    return mediaContent
}

const patchMessageForMdIfRequired = (message) => {
    if (message?.buttonsMessage || message?.templateMessage || message?.listMessage || message?.interactiveMessage?.nativeFlowMessage) {
        message = {
            viewOnceMessageV2Extension: {
                message: {
                    messageContextInfo: {
                        deviceListMetadataVersion: 2,
                        deviceListMetadata: {}
                    },
                    ...message
                }
            }
        }
    }
    return message
}

/**
 * Checks if a WebP buffer is animated by looking for VP8X chunk with animation flag
 * or ANIM/ANMF chunks
 */
function isAnimatedWebP(buffer) {
    // WebP must start with RIFF....WEBP
    if (
        buffer.length < 12 ||
        buffer[0] !== 0x52 ||
        buffer[1] !== 0x49 ||
        buffer[2] !== 0x46 ||
        buffer[3] !== 0x46 ||
        buffer[8] !== 0x57 ||
        buffer[9] !== 0x45 ||
        buffer[10] !== 0x42 ||
        buffer[11] !== 0x50
    ) {
        return false
    }

    // Parse chunks starting after RIFF header (12 bytes)
    let offset = 12
    while (offset < buffer.length - 8) {
        const chunkFourCC = buffer.toString('ascii', offset, offset + 4)
        const chunkSize = buffer.readUInt32LE(offset + 4)

        if (chunkFourCC === 'VP8X') {
            // VP8X extended header, check animation flag (bit 1 at offset+8)
            const flagsOffset = offset + 8
            if (flagsOffset < buffer.length) {
                const flags = buffer[flagsOffset]
                if (flags & 0x02) {
                    return true
                }
            }
        } else if (chunkFourCC === 'ANIM' || chunkFourCC === 'ANMF') {
            // ANIM or ANMF chunks indicate animation
            return true
        }

        // Move to next chunk (chunk size + 8 bytes header, padded to even)
        offset += 8 + chunkSize + (chunkSize % 2)
    }

    return false
}

/**
 * Checks if a buffer is a WebP file
 */
function isWebPBuffer(buffer) {
    return (
        buffer.length >= 12 &&
        buffer[0] === 0x52 &&
        buffer[1] === 0x49 &&
        buffer[2] === 0x46 &&
        buffer[3] === 0x46 &&
        buffer[8] === 0x57 &&
        buffer[9] === 0x45 &&
        buffer[10] === 0x42 &&
        buffer[11] === 0x50
    )
}

/**
 * Prepares a sticker pack message for sending.
 * Converts stickers to WebP, creates ZIP, encrypts, uploads, and generates thumbnail.
 */
async function prepareStickerPackMessage(stickerPack, options) {
    const { zip } = require('fflate')
    const { stickers, name, publisher, packId, description } = stickerPack

    if (stickers.length > 60) {
        throw new boom_1.Boom('Sticker pack exceeds the maximum limit of 60 stickers', { statusCode: 400 })
    }

    if (stickers.length === 0) {
        throw new boom_1.Boom('Sticker pack must contain at least one sticker', { statusCode: 400 })
    }

    const stickerPackIdValue = packId || generics_1.generateMessageID()

    const lib = await messages_media_1.getImageProcessingLibrary()
    const stickerData = {}
    const stickerPromises = stickers.map(async (s, i) => {
        const { stream } = await messages_media_1.getStream(s.data)
        const buffer = await messages_media_1.toBuffer(stream)

        let webpBuffer
        let isAnimated = false
        const isWebP = isWebPBuffer(buffer)

        if (isWebP) {
            // Already WebP - preserve original to keep exif metadata and animation
            webpBuffer = buffer
            isAnimated = isAnimatedWebP(buffer)
        } else if ('sharp' in lib && lib.sharp) {
            // Convert to WebP, preserving metadata
            webpBuffer = await lib.sharp.default(buffer).webp().toBuffer()
            // Non-WebP inputs converted to WebP are not animated
            isAnimated = false
        } else {
            throw new boom_1.Boom(
                'No image processing library (sharp) available for converting sticker to WebP. Either install sharp or provide stickers in WebP format.'
            )
        }

        if (webpBuffer.length > 1024 * 1024) {
            throw new boom_1.Boom(`Sticker at index ${i} exceeds the 1MB size limit`, { statusCode: 400 })
        }

        const hash = crypto_2.sha256(webpBuffer).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
        const fileName = `${hash}.webp`
        stickerData[fileName] = [new Uint8Array(webpBuffer), { level: 0 }]
        return {
            fileName,
            mimetype: 'image/webp',
            isAnimated,
            isLottie: false,
            emojis: s.emojis || [],
            accessibilityLabel: s.accessibilityLabel
        }
    })

    const stickerMetadata = await Promise.all(stickerPromises)

    // Process and add cover/tray icon to the ZIP
    const trayIconFileName = `${stickerPackIdValue}.webp`
    const { stream: coverStream } = await messages_media_1.getStream(stickerPack.cover)
    const coverBuffer = await messages_media_1.toBuffer(coverStream)

    let coverWebpBuffer
    const isCoverWebP = isWebPBuffer(coverBuffer)

    if (isCoverWebP) {
        // Already WebP - preserve original to keep exif metadata
        coverWebpBuffer = coverBuffer
    } else if ('sharp' in lib && lib.sharp) {
        coverWebpBuffer = await lib.sharp.default(coverBuffer).webp().toBuffer()
    } else {
        throw new boom_1.Boom(
            'No image processing library (sharp) available for converting cover to WebP. Either install sharp or provide cover in WebP format.'
        )
    }

    // Add cover to ZIP data
    stickerData[trayIconFileName] = [new Uint8Array(coverWebpBuffer), { level: 0 }]

    const zipBuffer = await new Promise((resolve, reject) => {
        zip(stickerData, (err, data) => {
            if (err) {
                reject(err)
            } else {
                resolve(Buffer.from(data))
            }
        })
    })

    const stickerPackSize = zipBuffer.length

    const stickerPackUpload = await messages_media_1.encryptedStream(zipBuffer, 'sticker-pack', {
        logger: options.logger,
        opts: options.options
    })

    // Upload to /mms/image (via 'sticker') to get a media handle from the server.
    // The encryption above already used 'sticker-pack' HKDF keys which is what
    // recipients use to decrypt — the upload endpoint doesn't affect key derivation.
    const stickerPackUploadResult = await options.upload(stickerPackUpload.encFilePath, {
        fileEncSha256B64: stickerPackUpload.fileEncSha256.toString('base64'),
        mediaType: 'sticker',
        timeoutMs: options.mediaUploadTimeoutMs
    })

    try {
        await fs_1.promises.unlink(stickerPackUpload.encFilePath)
    } catch (_e) { /* ignore */ }

    const stickerPackMessage = {
        name: name,
        publisher: publisher,
        stickerPackId: stickerPackIdValue,
        packDescription: description,
        stickerPackOrigin: WAProto_1.proto.Message.StickerPackMessage.StickerPackOrigin.USER_CREATED,
        stickerPackSize: stickerPackSize,
        stickers: stickerMetadata,
        fileSha256: stickerPackUpload.fileSha256,
        fileEncSha256: stickerPackUpload.fileEncSha256,
        mediaKey: stickerPackUpload.mediaKey,
        directPath: stickerPackUploadResult.directPath,
        fileLength: stickerPackUpload.fileLength,
        mediaKeyTimestamp: generics_1.unixTimestampSeconds(),
        trayIconFileName: trayIconFileName
    }

    try {
        // Reuse the cover buffer we already processed for thumbnail generation
        let thumbnailBuffer

        if ('sharp' in lib && lib.sharp) {
            thumbnailBuffer = await lib.sharp.default(coverBuffer).resize(252, 252).jpeg().toBuffer()
        } else {
            // Fallback: use ffmpeg to convert WebP cover → 252x252 JPEG thumbnail
            // (jimp doesn't support WebP input, sharp may not be available)
            const tmpIn = path_1.join(os_1.tmpdir(), 'spack-thumb-in-' + Date.now() + '.webp')
            const tmpOut = path_1.join(os_1.tmpdir(), 'spack-thumb-out-' + Date.now() + '.jpg')
            try {
                await fs_1.promises.writeFile(tmpIn, coverBuffer)
                require('child_process').execFileSync('ffmpeg', [
                    '-y', '-i', tmpIn, '-vf', 'scale=252:252', '-q:v', '2', tmpOut
                ], { timeout: 15000, stdio: 'pipe' })
                thumbnailBuffer = await fs_1.promises.readFile(tmpOut)
            } finally {
                await fs_1.promises.unlink(tmpIn).catch(() => {})
                await fs_1.promises.unlink(tmpOut).catch(() => {})
            }
        }

        if (!thumbnailBuffer || thumbnailBuffer.length === 0) {
            throw new Error('Failed to generate thumbnail buffer')
        }

        const thumbUpload = await messages_media_1.encryptedStream(thumbnailBuffer, 'thumbnail-sticker-pack', {
            logger: options.logger,
            opts: options.options,
            mediaKey: stickerPackUpload.mediaKey // Use same mediaKey as the sticker pack ZIP
        })

        const thumbUploadResult = await options.upload(thumbUpload.encFilePath, {
            fileEncSha256B64: thumbUpload.fileEncSha256.toString('base64'),
            mediaType: 'thumbnail-sticker-pack',
            timeoutMs: options.mediaUploadTimeoutMs
        })

        try {
            await fs_1.promises.unlink(thumbUpload.encFilePath)
        } catch (_e) { /* ignore */ }

        Object.assign(stickerPackMessage, {
            thumbnailDirectPath: thumbUploadResult.directPath,
            thumbnailSha256: thumbUpload.fileSha256,
            thumbnailEncSha256: thumbUpload.fileEncSha256,
            thumbnailHeight: 252,
            thumbnailWidth: 252,
            imageDataHash: crypto_2.sha256(thumbnailBuffer).toString('base64')
        })
    } catch (e) {
        options.logger?.warn?.(`Thumbnail generation failed: ${e}`)
    }

    return { stickerPackMessage }
}

module.exports = {
    extractUrlFromText,
    generateLinkPreviewIfRequired,
    prepareWAMessageMedia,
    prepareAlbumMessageContent,
    prepareDisappearingMessageSettingContent,
    generateForwardMessageContent,
    generateWAMessageContent,
    generateWAMessageFromContent,
    generateWAMessage,
    getContentType,
    normalizeMessageContent,
    extractMessageContent,
    getDevice,
    updateMessageWithReceipt,
    updateMessageWithReaction,
    updateMessageWithPollUpdate,
    getAggregateVotesInPollMessage,
    aggregateMessageKeysNotFromMe,
    downloadMediaMessage,
    assertMediaContent,
    patchMessageForMdIfRequired,
    prepareStickerPackMessage
}
