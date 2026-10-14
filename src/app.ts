import fs from 'node:fs'
import path from 'node:path'
import express from 'express'
import cookieParser from 'cookie-parser'
import type { Context } from './context.js'
import { authRoutes } from './auth/routes.js'
import { authMiddleware } from './auth/middleware.js'
import { meRoutes } from './routes/me.js'
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

export function createApp(ctx: Context) {
  const app = express()
  app.disable('x-powered-by')
  app.set('trust proxy', true)

  app.use((req, res, next) => {
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

  app.use(cookieParser())
  app.use(express.json({ limit: '10mb' }))
  app.use(express.urlencoded({ extended: true, limit: '5mb' }))

  app.use((req, _res, next) => {
    log.debug(`${req.method} ${req.originalUrl}`)
    next()
  })

  app.use(authRoutes(ctx))

  const api = express.Router()
  api.use(authMiddleware(ctx))
  api.use(meRoutes(ctx))
  api.use(itemRoutes(ctx))
  api.use(apiForward(ctx))
  app.use('/api', api)

  app.use('/hls', sessionForward(ctx, '/hls'))
  app.use('/public', sessionForward(ctx, '/public'))
  app.use('/feed', (req, res) => ctx.registry.default.relay(req, res, '/feed' + req.url))

  const clientDir = ctx.cfg.clientDir
  const indexHtml = path.join(clientDir, 'index.html')
  if (fs.existsSync(indexHtml)) {
    app.use(express.static(clientDir))
    for (const route of SPA_ROUTES) app.get(route, (_req, res) => res.sendFile(indexHtml))
  } else {
    log.warn(`[app] web client not found at ${clientDir}; run scripts/fetch-client.sh`)
    app.get('/', (_req, res) => res.status(503).send('ShelfMerge: web client not installed'))
  }

  return app
}
