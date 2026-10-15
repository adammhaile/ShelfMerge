/**
 * Replace the JWT signing secret and sign everyone out.
 * Dev:    npm run rotate-secret
 * Docker: docker exec shelfmerge node dist/tools/rotate-secret.js
 * Restart ShelfMerge afterwards; the running process keeps the old secret in memory.
 */
import crypto from 'node:crypto'
import { loadConfig, isConfigUrl } from '../config.js'
import { openDb, kvSet } from '../db.js'

const source = process.env.SHELFMERGE_CONFIG ?? 'config/shelfmerge.yaml'
const dataDir = process.env.SHELFMERGE_DATA_DIR ?? (isConfigUrl(source) ? null : loadConfig(source).dataDir)
if (!dataDir) throw new Error('config comes from a URL; set SHELFMERGE_DATA_DIR to the data directory')
const db = openDb(dataDir)
kvSet(db, 'tokenSecret', crypto.randomBytes(32).toString('base64'))
const sessions = db.prepare('DELETE FROM auth_sessions').run().changes
db.close()
console.log(`Token secret rotated; ${sessions} session${sessions === 1 ? '' : 's'} invalidated. Restart ShelfMerge to apply.`)
