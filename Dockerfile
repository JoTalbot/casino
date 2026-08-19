# API — боевой сервер Fastify + PostgreSQL
FROM node:20-alpine AS base
WORKDIR /app

# зависимости
COPY package.json package-lock.json ./
RUN npm ci --production=false

# код (кэшируем зависимости отдельно)
COPY tsconfig.json ./
COPY config/ ./config/
COPY src/ ./src/
COPY db/ ./db/
COPY api/ ./api/
COPY scripts/ ./scripts/
COPY tests/fixtures/ ./tests/fixtures/

RUN npm run build

# runtime
FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=base /app/package.json /app/package-lock.json ./
COPY --from=base /app/node_modules ./node_modules
COPY --from=base /app/build ./build
COPY --from=base /app/config ./config
COPY --from=base /app/db ./db
COPY --from=base /app/api ./api
COPY --from=base /app/src ./src

EXPOSE 3000
# Миграции + старт сервера. DATABASE_URL и JWT_SECRET — обязательны.
CMD ["sh", "-c", "node build/server/migrate.js && node build/server/main.js"]
