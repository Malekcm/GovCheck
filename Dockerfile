# GovCheck — single container: API + built SPA + scheduler
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production PORT=8787
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/migrations ./migrations
COPY package.json ./
# Embedded-database fallback location (mount a volume here if not using DATABASE_URL)
VOLUME ["/app/data"]
EXPOSE 8787
CMD ["node", "dist/server/index.js"]
