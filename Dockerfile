# The stock Audiobookshelf web client is copied out of the official image at
# build time, so ShelfMerge serves exactly the UI that matches ABS_VERSION.
ARG ABS_VERSION=2.37.1

FROM advplyr/audiobookshelf:${ABS_VERSION} AS client

FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim
ARG ABS_VERSION
ENV NODE_ENV=production \
    ABS_VERSION=${ABS_VERSION} \
    SHELFMERGE_CONFIG=/config/shelfmerge.yaml \
    SHELFMERGE_DATA_DIR=/data \
    SHELFMERGE_CLIENT_DIR=/app/client-dist \
    PORT=3333
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=client /app/client/dist ./client-dist
COPY package.json ./
VOLUME ["/config", "/data"]
EXPOSE 3333
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://localhost:3333/healthcheck').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/index.js"]
