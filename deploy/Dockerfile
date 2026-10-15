# AI Novel Writing App — single multi-stage image (backend doc §6).
#   build:  node:22     — npm ci + tsc (TS → dist)
#   runtime:node:22-same— node dist/src/server.js, non-root (node uid 1000)
#
# Runtime layout inside the image:
#   /app/dist/src/**/*.js   compiled app (server.js is the entry)
#   /app/dist/views/**.hbs  hbs templates + schema.sql (copied by build)
#   /app/dist/public/**     static css/js
#   /images                 named volume novel-images (flat image dir)

FROM docker.io/library/node:22 AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json vitest.config.ts ./
COPY src ./src
COPY views ./views
RUN npm run build

FROM docker.io/library/node:22
ENV NODE_ENV=production
WORKDIR /app
# prod deps only (argon2 native module is platform-specific — installed on
# this same glibc/arch in the build stage)
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
RUN mkdir -p /images && chown -R node:node /app /images
USER node
EXPOSE 9187
CMD ["node", "dist/src/server.js"]
