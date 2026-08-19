"use strict"

/**
 * Soporte para mensajes enriquecidos (richResponseMessage) envueltos en botForwardedMessage:
 * tablas, bloques de código con resaltado, entidades inline, LaTeX, carruseles de items, etc.
 */

const { getRandomValues, randomUUID } = require("crypto")
const { DONATE_URL, LEXER_REGEX } = require("../Defaults")
const { LANGUAGE_KEYWORDS } = require("../WABinary/language-keywords")
const { CodeHighlightType, RichSubMessageType } = require("../Types/RichType")
const { proto } = require("../../WAProto")

const NOOP = new Set([])

/**
 * Convierte un string de código en tokens etiquetados para el resaltado de sintaxis.
 * @param {string} code código fuente
 * @param {string} language lenguaje (javascript, python, go, rust, bash, ...)
 * @returns {{highlightType: number, codeContent: string}[]}
 */
const tokenizeCode = (code, language = 'javascript') => {
    const keywords = LANGUAGE_KEYWORDS[language] || NOOP
    const blocks = []
    LEXER_REGEX.lastIndex = 0
    let match
    while ((match = LEXER_REGEX.exec(code)) !== null) {
        if (match[1]) {
            blocks.push({ highlightType: CodeHighlightType.COMMENT, codeContent: match[1] })
        } else if (match[2]) {
            blocks.push({ highlightType: CodeHighlightType.STRING, codeContent: match[2] })
        } else if (match[3]) {
            blocks.push({
                highlightType: keywords.has(match[3]) ? CodeHighlightType.KEYWORD : CodeHighlightType.METHOD,
                codeContent: match[3]
            })
        } else if (match[4]) {
            blocks.push({
                highlightType: keywords.has(match[4]) ? CodeHighlightType.KEYWORD : CodeHighlightType.DEFAULT,
                codeContent: match[4]
            })
        } else if (match[5]) {
            blocks.push({ highlightType: CodeHighlightType.NUMBER, codeContent: match[5] })
        } else {
            blocks.push({ highlightType: CodeHighlightType.DEFAULT, codeContent: match[6] })
        }
    }
    return blocks
}

/**
 * Construye el `unifiedResponse` que WhatsApp usa para renderizar el mensaje enriquecido.
 * Sin este payload las tablas y los bloques de código no se dibujan en el cliente.
 */
const toUnified = (submessages, uuid) => ({
    response_id: uuid || randomUUID(),
    sections: submessages.map(submessage => {
        switch (submessage.messageType) {
            case RichSubMessageType.CODE: {
                const codeMetadata = submessage.codeMetadata
                return {
                    view_model: {
                        primitive: {
                            language: codeMetadata.codeLanguage,
                            code_blocks: codeMetadata.codeBlocks.map(block => ({
                                content: block.codeContent,
                                type: CodeHighlightType[block.highlightType]
                            })),
                            __typename: 'GenAICodeUXPrimitive'
                        },
                        __typename: 'GenAISingleLayoutViewModel'
                    }
                }
            }
            case RichSubMessageType.CONTENT_ITEMS:
                return {}
            case RichSubMessageType.INLINE_IMAGE:
                return {}
            case RichSubMessageType.LATEX:
                return {}
            case RichSubMessageType.TABLE: {
                const tableMetadata = submessage.tableMetadata
                return {
                    view_model: {
                        primitive: {
                            title: tableMetadata.title,
                            rows: tableMetadata.rows.map(row => ({
                                is_header: row.isHeading,
                                cells: row.items,
                                markdown_cells: row.items.map(item => ({ text: item }))
                            })),
                            __typename: 'GenATableUXPrimitive'
                        },
                        __typename: 'GenAISingleLayoutViewModel'
                    }
                }
            }
            case RichSubMessageType.TEXT:
                return {
                    view_model: {
                        primitive: {
                            text: submessage.messageText,
                            inline_entities: submessage.inlineEntities || [],
                            __typename: 'GenAIMarkdownTextUXPrimitive'
                        },
                        __typename: 'GenAISingleLayoutViewModel'
                    }
                }
        }
        return submessage
    })
})

/** Firma aleatoria para el campo proofs[] de botMetadata */
const botMetadataSignature = () => {
    const signature = new Uint8Array(64)
    getRandomValues(signature)
    return signature
}

/** Certificado aleatorio (DER-like) para el campo certificateChain de botMetadata */
const botMetadataCertificate = (length = 685) => {
    const certificate = new Uint8Array(length)
    certificate[0] = 48
    certificate[1] = 130
    getRandomValues(certificate.subarray(2))
    return certificate
}

/** Envuelve un richResponseMessage dentro de un botForwardedMessage firmado */
const wrapToBotForwardedMessage = richResponseMessage => ({
    messageContextInfo: {
        botMetadata: {
            verificationMetadata: {
                proofs: [
                    {
                        certificateChain: [
                            botMetadataCertificate(),
                            botMetadataCertificate(892)
                        ],
                        version: 1,
                        useCase: 1,
                        signature: botMetadataSignature()
                    }
                ]
            }
        }
    },
    botForwardedMessage: {
        message: { richResponseMessage }
    }
})

/**
 * Construye el contenido completo de un mensaje enriquecido.
 * Acepta la forma declarativa (headerText/code/table/links/...) o la forma
 * por secciones pasando un array en `richResponse`.
 */
const prepareRichResponseMessage = content => {
    const {
        alignment, code, contentText, disclaimerText, footerText, headerText,
        imageText, inlineImage, inlineVideo, items, language, latex, links,
        noHeading, posts, products, suggested, richResponse, table, tapLinkUrl, title
    } = content

    let submessages = []

    if (Array.isArray(richResponse)) {
        submessages = richResponse.map(submessage => {
            if (submessage.text) {
                return {
                    messageType: RichSubMessageType.TEXT,
                    messageText: submessage.text,
                    inlineEntities: submessage.inlineEntities
                }
            } else if (submessage.code) {
                return {
                    messageType: RichSubMessageType.CODE,
                    codeMetadata: {
                        codeLanguage: submessage.language || 'javascript',
                        codeBlocks: typeof submessage.code === 'string'
                            ? tokenizeCode(submessage.code, submessage.language || 'javascript')
                            : submessage.code
                    }
                }
            } else if (submessage.items) {
                return {
                    messageType: RichSubMessageType.CONTENT_ITEMS,
                    contentItemsMetadata: {
                        itemsMetadata: submessage.items,
                        contentType: proto.AIRichResponseContentItemsMetadata.ContentType.CAROUSEL
                    }
                }
            } else if (submessage.inlineImage) {
                return {
                    messageType: RichSubMessageType.INLINE_IMAGE,
                    imageMetadata: {
                        imageUrl: submessage.inlineImage,
                        imageText: submessage.imageText,
                        alignment: submessage.alignment,
                        tapLinkUrl: submessage.tapLinkUrl
                    }
                }
            } else if (submessage.inlineVideo) {
                return { messageType: RichSubMessageType.TEXT, messageText: 'INLINE_VIDEO' }
            } else if (submessage.latex) {
                return {
                    messageType: RichSubMessageType.LATEX,
                    latexMetadata: {
                        text: submessage.text,
                        expressions: submessage.latex
                    }
                }
            } else if (submessage.posts) {
                return { messageType: RichSubMessageType.TEXT, messageText: 'POSTS' }
            } else if (submessage.products) {
                return { messageType: RichSubMessageType.TEXT, messageText: 'PRODUCTS' }
            } else if (submessage.suggested) {
                return { messageType: RichSubMessageType.TEXT, messageText: 'SUGGESTED_PROMPT' }
            } else if (submessage.table) {
                return {
                    messageType: RichSubMessageType.TABLE,
                    tableMetadata: {
                        title: submessage.title,
                        rows: submessage.table
                    }
                }
            }
            return submessage
        })
    } else {
        if (headerText) {
            submessages.push({ messageType: RichSubMessageType.TEXT, messageText: headerText })
        }
        if (contentText) {
            submessages.push({ messageType: RichSubMessageType.TEXT, messageText: contentText })
        }
        if (code) {
            const lang = language || 'javascript'
            submessages.push({
                messageType: RichSubMessageType.CODE,
                codeMetadata: {
                    codeLanguage: lang,
                    codeBlocks: tokenizeCode(code, lang)
                }
            })
        }
        if (items) {
            submessages.push({
                messageType: RichSubMessageType.CONTENT_ITEMS,
                contentItemsMetadata: {
                    itemsMetadata: items,
                    contentType: proto.AIRichResponseContentItemsMetadata.ContentType.CAROUSEL
                }
            })
        }
        if (inlineImage) {
            submessages.push({
                messageType: RichSubMessageType.INLINE_IMAGE,
                imageMetadata: { imageUrl: inlineImage, imageText, alignment, tapLinkUrl }
            })
        }
        if (inlineVideo) {
            submessages.push({ messageType: RichSubMessageType.TEXT, messageText: 'INLINE_VIDEO' })
        }
        if (latex) {
            submessages.push({
                messageType: RichSubMessageType.LATEX,
                latexMetadata: { text: contentText, expressions: latex }
            })
        }
        if (links) {
            links.forEach((linkField, index) => {
                const prefix = 'SS_' + index
                const url = linkField.url || DONATE_URL
                const sources = linkField.sources?.map(sourceField => ({
                    source_type: 'THIRD_PARTY',
                    source_display_name: sourceField.displayName || 'Fuente',
                    source_subtitle: sourceField.subtitle || '',
                    source_url: sourceField.url || url
                }))
                submessages.push({
                    messageType: RichSubMessageType.TEXT,
                    messageText: linkField.text + ` {{${prefix}}}¹{{/${prefix}}} `,
                    inlineEntities: [{
                        key: prefix,
                        metadata: {
                            reference_id: index + 1,
                            reference_url: url,
                            reference_title: linkField.title || 'Referencia',
                            reference_display_name: linkField.displayName || 'Fuente',
                            sources: sources || [],
                            __typename: 'GenAISearchCitationItem'
                        }
                    }]
                })
            })
        }
        if (posts) {
            submessages.push({ messageType: RichSubMessageType.TEXT, messageText: 'POSTS' })
        }
        if (products) {
            submessages.push({ messageType: RichSubMessageType.TEXT, messageText: 'PRODUCTS' })
        }
        if (suggested) {
            submessages.push({ messageType: RichSubMessageType.TEXT, messageText: 'SUGGESTED_PROMPT' })
        }
        if (table) {
            submessages.push({
                messageType: RichSubMessageType.TABLE,
                tableMetadata: {
                    title,
                    rows: table.map((items, index) => ({
                        isHeading: !noHeading && index === 0,
                        items
                    }))
                }
            })
        }
        if (footerText) {
            submessages.push({ messageType: RichSubMessageType.TEXT, messageText: footerText })
        }
    }

    const uuid = randomUUID()
    const unified = toUnified(submessages, uuid)

    const richResponseMessage = proto.AIRichResponseMessage.create({
        submessages,
        messageType: proto.AIRichResponseMessageType.AI_RICH_RESPONSE_TYPE_STANDARD,
        unifiedResponse: {
            data: Buffer.from(JSON.stringify(unified))
        },
        contextInfo: {
            isForwarded: true,
            forwardingScore: 1,
            forwardedAiBotMessageInfo: { botJid: '867051314767696@bot' },
            forwardOrigin: 4
        }
    })

    const message = wrapToBotForwardedMessage(richResponseMessage)
    const botMetadata = message.messageContextInfo.botMetadata

    if (disclaimerText) {
        botMetadata.messageDisclaimerText = disclaimerText
    }
    botMetadata.botResponseId = uuid

    return message
}

exports.tokenizeCode = tokenizeCode
exports.toUnified = toUnified
exports.prepareRichResponseMessage = prepareRichResponseMessage
exports.botMetadataSignature = botMetadataSignature
exports.botMetadataCertificate = botMetadataCertificate
exports.wrapToBotForwardedMessage = wrapToBotForwardedMessage
