"use strict"

Object.defineProperty(exports, "__esModule", { value: true })

const MexOperations = {
    PROMOTE: "NotificationNewsletterAdminPromote",
    DEMOTE: "NotificationNewsletterAdminDemote",
    UPDATE: "NotificationNewsletterUpdate"
}

const XWAPaths = {
    PROMOTE: "xwa2_notify_newsletter_admin_promote",
    DEMOTE: "xwa2_notify_newsletter_admin_demote",
    ADMIN_COUNT: "xwa2_newsletter_admin",
    CREATE: "xwa2_newsletter_create",
    NEWSLETTER: "xwa2_newsletter",
    SUBSCRIBED: "xwa2_newsletter_subscribed",
    METADATA_UPDATE: "xwa2_notify_newsletter_on_metadata_update",
    // === Paths from official Baileys ===
    SUBSCRIBERS: "xwa2_newsletter_subscribers",
    VIEW: "xwa2_newsletter_view",
    MUTE: "xwa2_newsletter_mute_v2",
    UNMUTE: "xwa2_newsletter_unmute_v2",
    FOLLOW: "xwa2_newsletter_follow",
    UNFOLLOW: "xwa2_newsletter_unfollow",
    JOIN: "xwa2_newsletter_join_v2",
    LEAVE: "xwa2_newsletter_leave_v2",
    CHANGE_OWNER: "xwa2_newsletter_change_owner",
    DEMOTE_NEWSLETTER: "xwa2_newsletter_demote",
    DELETE: "xwa2_newsletter_delete_v2",
    FETCH_ACCOUNT_REACHOUT_TIMELOCK: "xwa2_fetch_account_reachout_timelock",
    MESSAGE_CAPPING_INFO: "xwa2_message_capping_info"
}

const QueryIds = {
    JOB_MUTATION: "7150902998257522",
    METADATA: "6620195908089573",
    UNFOLLOW: "7238632346214362",
    FOLLOW: "7871414976211147",
    UNMUTE: "7337137176362961",
    MUTE: "25151904754424642",
    CREATE: "6996806640408138",
    ADMIN_COUNT: "7130823597031706",
    CHANGE_OWNER: "7341777602580933",
    DELETE: "8316537688363079",
    DEMOTE: "6551828931592903",
    SUBSCRIBED: "6388546374527196",
    SUBSCRIBERS: "7272014489183858",
    UPDATE_METADATA: "7150902998257522",
    // === Query IDs from official Baileys ===
    REACHOUT_TIMELOCK: "23983697327930364",
    MESSAGE_CAPPING_INFO: "24503548349331633"
}

module.exports = {
  MexOperations,
  XWAPaths,
  QueryIds
}