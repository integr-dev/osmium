FROM node:24-bookworm-slim AS builder

WORKDIR /app

# Dependencies first, so a change to the source does not reinstall them.
COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:24-bookworm-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=builder /app/dist ./dist

# The linker ships alongside the router: this host is headless and containerized, so acquiring a
# credential means `docker exec` into the running container. A binary left on a build machine would
# be no use to it.
RUN ln -s /app/dist/bin/link.js /usr/local/bin/osmium-link \
    && chmod +x /app/dist/bin/link.js

RUN mkdir -p /agent && chown -R node:node /agent /app

USER node

ENV OSMIUM_WS_URL="wss://<backend-url>/ws/host"

VOLUME ["/agent"]

ENTRYPOINT ["node", "/app/dist/index.js"]
