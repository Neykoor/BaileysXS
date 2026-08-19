"use strict"

/**
 * Estado de autenticacion persistido en SQLite.
 *
 * Alternativa a `useMultiFileAuthState` para sesiones grandes: en vez de miles
 * de archivos JSON sueltos usa una sola base de datos con indices, lo que
 * reduce muchisimo el I/O en bots con mucho trafico.
 *
 * Requiere el peer dependency `better-sqlite3`:
 *   npm install better-sqlite3
 *
 * Portado de @itsliaaa/baileys a CommonJS para Ryzewa.
 */

const { proto } = require("../../WAProto")
const { initAuthCreds } = require("./auth-utils")
const { BufferJSON } = require("./generics")

function loadBetterSqlite3() {
    try {
        const mod = require('better-sqlite3')
        return mod.default ?? mod
    } catch (err) {
        const helpful = new Error('`better-sqlite3` es necesario para `useSqliteAuthState`. Instalalo con: npm install better-sqlite3')
        helpful.cause = err
        throw helpful
    }
}

const CREDS_ROW_KEY = '__creds__'

const CREATE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS creds (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS signal_keys (
  type TEXT NOT NULL,
  id TEXT NOT NULL,
  value TEXT NOT NULL,
  PRIMARY KEY (type, id)
);
CREATE INDEX IF NOT EXISTS signal_keys_type_idx ON signal_keys(type);
`

/**
 * @param {{dbPath?: string, database?: Object}} opts ruta al archivo .db o una instancia ya abierta
 * @returns {Promise<{state: Object, saveCreds: Function, clearKeys: Function, close: Function}>}
 */
async function useSqliteAuthState(opts) {
    let db
    if (opts.database) {
        db = opts.database
    } else {
        const Database = loadBetterSqlite3()
        db = new Database(opts.dbPath)
    }

    // WAL permite lecturas concurrentes con un unico escritor: ideal para bots
    db.pragma('journal_mode = WAL')
    db.pragma('synchronous = NORMAL')
    db.exec(CREATE_SCHEMA_SQL)

    const stmts = {
        credsSelect: db.prepare('SELECT value FROM creds WHERE key = ?'),
        credsUpsert: db.prepare('INSERT INTO creds (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'),
        keySelect: db.prepare('SELECT value FROM signal_keys WHERE type = ? AND id = ?'),
        keyUpsert: db.prepare('INSERT INTO signal_keys (type, id, value) VALUES (?, ?, ?) ON CONFLICT(type, id) DO UPDATE SET value = excluded.value'),
        keyDelete: db.prepare('DELETE FROM signal_keys WHERE type = ? AND id = ?'),
        keyListIds: db.prepare('SELECT id FROM signal_keys WHERE type = ?'),
        keyList: db.prepare('SELECT id, value FROM signal_keys WHERE type = ?'),
        clearKeys: db.prepare('DELETE FROM signal_keys')
    }

    const loadCreds = () => {
        const row = stmts.credsSelect.get(CREDS_ROW_KEY)
        if (!row) return initAuthCreds()
        return JSON.parse(row.value, BufferJSON.reviver)
    }

    const persistCreds = creds => {
        stmts.credsUpsert.run(CREDS_ROW_KEY, JSON.stringify(creds, BufferJSON.replacer))
    }

    const creds = loadCreds()

    return {
        state: {
            creds,
            keys: {
                get: async (type, ids) => {
                    const data = {}
                    for (const id of ids) {
                        const row = stmts.keySelect.get(type, id)
                        if (row) {
                            let value = JSON.parse(row.value, BufferJSON.reviver)
                            if (type === 'app-state-sync-key' && value) {
                                value = proto.Message.AppStateSyncKeyData.fromObject(value)
                            }
                            data[id] = value
                        }
                    }
                    return data
                },
                set: async data => {
                    const writeTx = db.transaction(() => {
                        for (const category in data) {
                            for (const id in data[category]) {
                                const value = data[category][id]
                                if (value) {
                                    stmts.keyUpsert.run(category, id, JSON.stringify(value, BufferJSON.replacer))
                                } else {
                                    stmts.keyDelete.run(category, id)
                                }
                            }
                        }
                    })
                    writeTx()
                }
            }
        },
        saveCreds: async () => {
            persistCreds(creds)
        },
        /** Borra todas las claves Signal manteniendo las credenciales */
        clearKeys: async () => {
            stmts.clearKeys.run()
        },
        /** Cierra la base de datos */
        close: () => {
            db.close()
        }
    }
}

exports.useSqliteAuthState = useSqliteAuthState
