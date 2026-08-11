FROM rustlang/rust:nightly-slim AS builder

WORKDIR /app

COPY Cargo.toml Cargo.lock ./
COPY osmium-agent ./osmium-agent
COPY osmium-router ./osmium-router
RUN cargo build --release -p osmium-router

FROM debian:bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*

RUN useradd --system --create-home --shell /usr/sbin/nologin osmium

WORKDIR /app

COPY --from=builder /app/target/release/osmium-router /app/osmium-router

RUN mkdir -p /agent && chown -R osmium:osmium /agent /app

USER osmium

ENV OSMIUM_WS_URL="wss://<backend-url>/ws/agent"

VOLUME ["/agent"]

ENTRYPOINT ["/app/osmium-router"]
