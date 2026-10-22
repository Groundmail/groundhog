# syntax=docker/dockerfile:1
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json ./
COPY scripts ./scripts
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-alpine
LABEL org.opencontainers.image.title="Groundhog" \
      org.opencontainers.image.description="A local email inbox for development. Catches SMTP and the HTTP send APIs of Groundmail, SendGrid, Postmark, Mailgun, Resend and Amazon SES." \
      org.opencontainers.image.source="https://github.com/Groundmail/groundhog" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.vendor="Groundmail"
ENV NODE_ENV=production GROUNDHOG_HOST=0.0.0.0 GROUNDHOG_NO_OPEN=1 GROUNDHOG_CONFIG_DIR=/data/config
WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 1025 3025
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s CMD wget -qO- http://127.0.0.1:3025/api/health >/dev/null || exit 1
ENTRYPOINT ["node", "dist/cli.js"]
