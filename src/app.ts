import fs from 'node:fs'
import path from 'node:path'
import express from 'express'
import cookieParser from 'cookie-parser'
import type { Context } from './context.js'
import { authRoutes } from './auth/routes.js'
import { authMiddleware } from './auth/middleware.js'
import { meRoutes } from './routes/me.js'
import { userRoutes } from './routes/users.js'
import { libraryRoutes } from './routes/libraries.js'
import { mergedRoutes } from './routes/merged.js'
import { collectionRoutes } from './routes/collections.js'
import { itemRoutes } from './routes/items.js'
import { apiForward, sessionForward } from './routes/forward.js'
import { log } from './logger.js'

/** Client-side routes of the Nuxt web client; copied from upstream Server.js. */
const SPA_ROUTES = [
  '/item/:id',
  '/author/:id',
  '/audiobook/:id/chapters',
  '/audiobook/:id/edit',
  '/audiobook/:id/manage',
  '/library/:library',
  '/library/:library/search',
  '/library/:library/bookshelf/:id?',
  '/library/:library/authors',
  '/library/:library/narrators',
  '/library/:library/stats',
  '/library/:library/series/:id?',
  '/library/:library/podcast/search',
  '/library/:library/podcast/latest',
  '/library/:library/podcast/download-queue',
  '/config/users/:id',
  '/config/users/:id/sessions',
  '/config/item-metadata-utils/:id',
  '/collection/:id',
  '/playlist/:id',
  '/share/:slug'
]

/**
 * The stock web client is built with this router base path, so its assets and
 * API calls are prefixed with it. Like upstream, bare URLs (mobile apps,
 * older clients) are rewritten to include it, so both forms work.
 */
export const BASE_PATH = normalizeBasePath(process.env.ROUTER_BASE_PATH ?? '/audiobookshelf')

function normalizeBasePath(p: string): string {
  const t = p.trim()
  if (!t || t === '/') return ''
  const lead = t.startsWith('/') ? t : `/${t}`
  return lead.endsWith('/') ? lead.slice(0, -1) : lead
}

export function createApp(ctx: Context) {
  const app = express()
  app.disable('x-powered-by')
  app.set('trust proxy', true)

  app.use((req, _res, next) => {
    const hasBase = BASE_PATH && (req.url === BASE_PATH || req.url.startsWith(BASE_PATH + '/') || req.url.startsWith(BASE_PATH + '?'))
    req.smPath = hasBase ? req.url.slice(BASE_PATH.length) || '/' : req.url
    if (BASE_PATH && !hasBase) req.url = BASE_PATH + req.url
    next()
  })

  const root = express.Router()
  app.use(BASE_PATH || '/', root)

  root.use((req, res, next) => {
    res.setHeader('Referrer-Policy', 'no-referrer')
    // Same CORS carve-out as upstream for the mobile ereader and cover colour extraction.
    if (/\/api\/items\/[a-z0-9-]{36}\/(ebook|cover)(\/[0-9]+)?/.test(req.path)) {
      const origin = req.get('origin')
      if (origin && ['capacitor://localhost', 'http://localhost'].includes(origin)) {
        res.header('Access-Control-Allow-Origin', origin)
        res.header('Access-Control-Allow-Methods', 'GET, POST, PATCH, PUT, DELETE, OPTIONS')
        res.header('Access-Control-Allow-Headers', '*')
        res.header('Access-Control-Allow-Credentials', 'true')
        if (req.method === 'OPTIONS') return res.sendStatus(200)
      }
    }
    next()
  })

  root.use(cookieParser())
  root.use(express.json({ limit: '10mb' }))
  root.use(express.urlencoded({ extended: true, limit: '5mb' }))

  root.use((req, _res, next) => {
    log.debug(`${req.method} ${req.smPath}`)
    next()
  })

  root.use(authRoutes(ctx))

  const api = express.Router()
  api.use(authMiddleware(ctx))
  api.use(meRoutes(ctx))
  api.use(userRoutes(ctx))
  api.use(mergedRoutes(ctx))
  api.use(libraryRoutes(ctx))
  api.use(collectionRoutes(ctx))
  api.use(itemRoutes(ctx))
  api.use(apiForward(ctx))
  root.use('/api', api)

  root.use('/hls', sessionForward(ctx, '/hls'))
  root.use('/public', sessionForward(ctx, '/public'))
  root.use('/feed', (req, res) => ctx.registry.default.relay(req, res, '/feed' + req.url))

  const clientDir = ctx.cfg.clientDir
  const indexHtml = path.join(clientDir, 'index.html')
  if (fs.existsSync(indexHtml)) {
    root.use(express.static(clientDir))
    for (const route of SPA_ROUTES) root.get(route, (_req, res) => res.sendFile(indexHtml))
  } else {
    log.warn(`[app] web client not found at ${clientDir}; run scripts/fetch-client.sh`)
    root.get('/', (_req, res) => res.status(503).send('ShelfMerge: web client not installed'))
  }

  return app
}
