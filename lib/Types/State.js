"use strict"

Object.defineProperty(exports, "__esModule", { value: true })

const SyncState = {
	Connecting: 0,
	AwaitingInitialSync: 1,
	Syncing: 2,
	Online: 3
}

// === Reachout Timelock (from official Baileys) ===
const ReachoutTimelockEnforcementType = {
	DEFAULT: 'DEFAULT',
	NEW_CHAT: 'NEW_CHAT',
	MESSAGE_SENDING: 'MESSAGE_SENDING'
}

const ReachoutTimelockState = {
	isActive: false,
	timeEnforcementEnds: undefined,
	enforcementType: ReachoutTimelockEnforcementType.DEFAULT
}

// === New Chat Message Capping (from official Baileys) ===
const NewChatMessageCappingStatusType = {
	NOT_ELIGIBLE: 'NOT_ELIGIBLE',
	NOT_ACTIVE: 'NOT_ACTIVE',
	ACTIVE: 'ACTIVE',
	ACTIVE_UPGRADE_AVAILABLE: 'ACTIVE_UPGRADE_AVAILABLE'
}

const NewChatMessageCappingOTEStatusType = {
	NOT_ELIGIBLE: 'NOT_ELIGIBLE',
	ELIGIBLE: 'ELIGIBLE',
	ACTIVE_IN_CURRENT_CYCLE: 'ACTIVE_IN_CURRENT_CYCLE',
	EXHAUSTED: 'EXHAUSTED'
}

const NewChatMessageCappingMVStatusType = {
	NOT_ELIGIBLE: 'NOT_ELIGIBLE',
	NOT_ACTIVE: 'NOT_ACTIVE',
	ACTIVE: 'ACTIVE',
	ACTIVE_UPGRADE_AVAILABLE: 'ACTIVE_UPGRADE_AVAILABLE'
}

const NewChatMessageCapInfo = {
	total_quota: undefined,
	used_quota: undefined,
	cycle_start_timestamp: undefined,
	cycle_end_timestamp: undefined,
	server_sent_timestamp: undefined,
	ote_status: undefined,
	mv_status: undefined,
	capping_status: undefined
}

module.exports = {
  SyncState,
  ReachoutTimelockEnforcementType,
  ReachoutTimelockState,
  NewChatMessageCappingStatusType,
  NewChatMessageCappingOTEStatusType,
  NewChatMessageCappingMVStatusType,
  NewChatMessageCapInfo
}