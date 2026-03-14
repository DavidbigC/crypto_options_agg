# Stage 1: build
FROM rust:1.78-alpine AS builder

RUN apk add --no-cache musl-dev openssl-dev pkgconfig

WORKDIR /app
COPY Cargo.toml Cargo.lock ./
# Pre-cache dependencies by building a dummy main
RUN mkdir src && echo "fn main() {}" > src/main.rs && cargo build --release && rm -rf src

COPY src ./src
RUN touch src/main.rs && cargo build --release

# Stage 2: runtime (minimal image)
FROM alpine:3.20 AS runner

RUN apk add --no-cache ca-certificates

WORKDIR /app
COPY --from=builder /app/target/release/options-backend .

EXPOSE 3500

CMD ["./options-backend"]
