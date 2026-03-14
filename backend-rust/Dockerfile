# Stage 1: build
FROM rust:1.83-bookworm AS builder

RUN apt-get update \
    && apt-get install -y --no-install-recommends pkg-config libssl-dev \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY Cargo.toml Cargo.lock ./
# Pre-cache dependencies by building a dummy main
RUN mkdir src && echo "fn main() {}" > src/main.rs && cargo build --release --bin options-backend && rm -rf src

COPY src ./src
RUN touch src/main.rs && cargo build --release --bin options-backend

# Stage 2: runtime
FROM debian:bookworm-slim AS runner

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates libssl3 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --from=builder /app/target/release/options-backend .

EXPOSE 3500

CMD ["./options-backend"]
