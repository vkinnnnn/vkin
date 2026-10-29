# Vkin hosted API. Build from the server/ directory: docker build -t vkin-server .
FROM node:22-slim

ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY prices.json ./
COPY src ./src

# The official image ships an unprivileged "node" user.
USER node

EXPOSE 8080
CMD ["node", "src/index.js"]
