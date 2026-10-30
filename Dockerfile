# 냉장고를 부탁해 (fridge-chef)
# 빌드: docker build -t fridge-chef .
# 실행: docker run --rm -p 8080:8080 --env-file .env fridge-chef
# API 키는 이미지에 넣지 않고 실행할 때 환경 변수로 넣는다 (ACA에서는 secret).

FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:22-alpine
ENV NODE_ENV=production \
    PORT=8080
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY public ./public

USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:${PORT}/healthz || exit 1
CMD ["node", "src/server.js"]
