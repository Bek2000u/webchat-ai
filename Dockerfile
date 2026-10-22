FROM node:24-bookworm-slim AS build
WORKDIR /app
# Electron and browser downloads are unnecessary for the server distribution.
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY tsconfig.json vite.config.ts ./
COPY scripts/build.mjs scripts/build.mjs
COPY src ./src
RUN npm run build:server && npm run build:web

FROM node:24-bookworm-slim AS server
ENV NODE_ENV=production \
    WEBCHAT_AI_MODE=server \
    HOST=0.0.0.0 \
    PORT=8001 \
    DATA_DIR=/app/data \
    WEB_DIR=/app/dist/web
WORKDIR /app
COPY --from=build --chown=node:node /app/dist/server ./dist/server
COPY --from=build --chown=node:node /app/dist/web ./dist/web
COPY LICENSE ./LICENSE
RUN mkdir -p /app/data && chown node:node /app/data
USER node
EXPOSE 8001
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8001)+'/health/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/server/index.mjs"]
