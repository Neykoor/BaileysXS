"use strict"

/**
 * Manejo de notificaciones `identity change` de WhatsApp.
 *
 * Cuando un contacto reinstala o cambia de dispositivo, WhatsApp emite una
 * notificacion de cambio de identidad. Esta rutina decide si hay que refrescar
 * la sesion Signal con ese contacto, evitando trabajo innecesario:
 * ignora dispositivos companion, la propia identidad, notificaciones offline,
 * contactos sin sesion previa, y aplica un debounce para no repetir el trabajo.
 *
 * Portado de @itsliaaa/baileys a CommonJS para Ryzewa.
 */

const { areJidsSameUser, getBinaryNodeChild, jidDecode } = require("../WABinary")

const isStringNullOrEmpty = str => !str || str.trim().length === 0

/**
 * @param {Object} node nodo binario de la notificacion
 * @param {Object} ctx contexto: { logger, meId, meLid, debounceCache, validateSession, assertSessions, onBeforeSessionRefresh }
 * @returns {Promise<{action: string, device?: number, error?: Error}>}
 */
async function handleIdentityChange(node, ctx) {
    const from = node.attrs.from
    if (!from) {
        return { action: 'invalid_notification' }
    }

    const identityNode = getBinaryNodeChild(node, 'identity')
    if (!identityNode) {
        return { action: 'no_identity_node' }
    }

    ctx.logger.info({ jid: from }, 'identidad cambiada')

    const decoded = jidDecode(from)
    if (decoded?.device && decoded.device !== 0) {
        ctx.logger.debug({ jid: from, device: decoded.device }, 'se ignora cambio de identidad de dispositivo companion')
        return { action: 'skipped_companion_device', device: decoded.device }
    }

    const isSelfPrimary = ctx.meId && (areJidsSameUser(from, ctx.meId) || (ctx.meLid && areJidsSameUser(from, ctx.meLid)))
    if (isSelfPrimary) {
        ctx.logger.info({ jid: from }, 'cambio de identidad propio')
        return { action: 'skipped_self_primary' }
    }

    if (ctx.debounceCache?.get(from)) {
        ctx.logger.debug({ jid: from }, 'cambio de identidad omitido (debounce)')
        return { action: 'debounced' }
    }
    ctx.debounceCache?.set(from, true)

    const isOfflineNotification = !isStringNullOrEmpty(node.attrs.offline)
    const hasExistingSession = await ctx.validateSession(from)
    if (!hasExistingSession.exists) {
        ctx.logger.debug({ jid: from }, 'sin sesion previa, no se refresca')
        return { action: 'skipped_no_session' }
    }

    ctx.logger.debug({ jid: from }, 'existe sesion previa, se refrescara')

    if (isOfflineNotification) {
        ctx.logger.debug({ jid: from }, 'refresco omitido durante procesamiento offline')
        return { action: 'skipped_offline' }
    }

    ctx.onBeforeSessionRefresh?.(from)

    try {
        await ctx.assertSessions([from], true)
        return { action: 'session_refreshed' }
    } catch (error) {
        ctx.logger.warn({ error, jid: from }, 'fallo al refrescar sesiones tras cambio de identidad')
        return { action: 'session_refresh_failed', error }
    }
}

exports.isStringNullOrEmpty = isStringNullOrEmpty
exports.handleIdentityChange = handleIdentityChange
