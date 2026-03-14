# Stage 1: build
FROM node:18-alpine AS builder

WORKDIR /app

COPY package*.json ./
RUN npm ci

# BACKEND_BASE_URL is needed at build time because Next.js bakes rewrites()
# into the build output when evaluating next.config.js during `next build`.
ARG BACKEND_BASE_URL=http://backend:3500
ENV BACKEND_BASE_URL=$BACKEND_BASE_URL

ARG NEXT_PUBLIC_APP_MODE=private
ENV NEXT_PUBLIC_APP_MODE=$NEXT_PUBLIC_APP_MODE

COPY . .
RUN npm run build

# Stage 2: production runner (smaller image, no devDependencies)
FROM node:18-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production

COPY --from=builder /app/package*.json ./
COPY --from=builder /app/next.config.js ./
COPY --from=builder /app/.next ./.next

# Install production deps only
RUN npm ci --omit=dev

EXPOSE 3000

CMD ["npm", "start"]
