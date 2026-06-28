FROM oven/bun:1.1-alpine
WORKDIR /app
COPY package.json ./
RUN bun install --frozen-lockfile || bun install
COPY . .
EXPOSE 3000
CMD ["sh", "-c", "bun run migrate && bun run dev"]
