"use strict"

/**
 * Construye un stanza de ACK/NACK para un nodo recibido.
 * Funcion pura: sin I/O ni efectos secundarios.
 *
 * Replica la construccion de WhatsApp Web:
 * - WAWebHandleMsgSendAck.sendAck / sendNack
 * - WAWebCreateNackFromStanza.createNackFromStanza
 *
 * @param {{tag: string, attrs: Object}} node nodo recibido
 * @param {number} [errorCode] si se indica, produce un NACK
 * @param {string} [meId] JID propio (se incluye en ACKs de clase `message`)
 */
function buildAckStanza(node, errorCode, meId) {
    const { tag, attrs } = node

    const stanza = {
        tag: 'ack',
        attrs: {
            id: attrs.id,
            to: attrs.from,
            class: tag
        }
    }

    if (errorCode) {
        stanza.attrs.error = errorCode.toString()
    }
    if (attrs.participant) {
        stanza.attrs.participant = attrs.participant
    }
    if (attrs.recipient) {
        stanza.attrs.recipient = attrs.recipient
    }
    if (attrs.type) {
        stanza.attrs.type = attrs.type
    }
    // WA Web siempre incluye `from` en los ACK de clase message
    if (tag === 'message' && meId) {
        stanza.attrs.from = meId
    }

    return stanza
}

exports.buildAckStanza = buildAckStanza
