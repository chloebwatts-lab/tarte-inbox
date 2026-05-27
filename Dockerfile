# syntax=docker/dockerfile:1.6

FROM node:20-alpine AS builder
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
# Constrain V8 heap so tsc fits on the 2GB droplet (memory in tarte_deploy.md)
ENV NODE_OPTIONS=--max-old-space-size=1536
RUN npm run build

FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY --from=builder /app/dist ./dist
COPY src/db/schema.sql ./dist/db/schema.sql

EXPOSE 8787
USER node

CMD ["node", "--enable-source-maps", "dist/index.js"]
