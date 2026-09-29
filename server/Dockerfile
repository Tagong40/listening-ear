FROM node:22-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY src ./src
COPY public ./public
RUN mkdir -p /app/data && chown node:node /app/data

ENV NODE_ENV=production
ENV PORT=6001
EXPOSE 6001
VOLUME ["/app/data"]

USER node

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 6001) + '/health').then(r => { if (!r.ok) process.exit(1) }).catch(() => process.exit(1))"

CMD ["node", "src/server.js"]