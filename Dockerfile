FROM node:22-alpine

WORKDIR /app

COPY package.json pnpm-lock.yaml ./
RUN corepack enable && pnpm install --frozen-lockfile --prod

COPY parser.js server.js ./
COPY public ./public

RUN mkdir -p runtime

EXPOSE 3000

CMD ["node", "server.js"]
