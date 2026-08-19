"use strict"

Object.defineProperty(exports, "__esModule", { value: true })

const WAProto_1 = require("../../WAProto")
const Defaults_1 = require("../Defaults")
const community_1 = require("./community")
const banner_1 = require("../Utils/banner")

const FULL_HISTORY_SYNC = WAProto_1.proto.Message.HistorySyncType.FULL

// export the last socket layer
const makeWASocket = (config) => {
	const newConfig = {
    	...Defaults_1.DEFAULT_CONNECTION_CONFIG,
   	 ...config
    }

    // Only FULL history is gated behind syncFullHistory. Rejecting every sync type
    // (the old default) also throws away the initial LID mappings, which is what
    // produces "No sessions" / bad-MAC errors and the reconnect loop that follows.
    if (config.shouldSyncHistoryMessage === undefined) {
        newConfig.shouldSyncHistoryMessage = ({ syncType } = {}) => {
            return newConfig.syncFullHistory ? true : syncType !== FULL_HISTORY_SYNC
        }
    }

    // el banner se dibuja en paralelo: no debe retrasar la conexion ni tumbarla
    // si el stdout del usuario falla (pipe cerrado, etc.)
    if (newConfig.printBanner !== false) {
        banner_1.printBanner().catch(() => {})
    }

    return community_1.makeCommunitiesSocket(newConfig)
}

exports.default = makeWASocket