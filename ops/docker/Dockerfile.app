FROM node:24.14.0-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund && npm cache clean --force
COPY tsconfig.json ./
COPY packages ./packages
COPY apps/api ./apps/api
COPY apps/worker ./apps/worker
COPY ops/scripts ./ops/scripts
RUN mkdir -p /app/media/private /app/media/published && chown -R node:node /app/media
USER node
EXPOSE 3000
CMD ["npm","run","start:api"]
