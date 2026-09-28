FROM node:22-bookworm-slim AS web-builder

WORKDIR /src
COPY package.json pnpm-lock.yaml ./
RUN corepack enable \
    && (pnpm install --frozen-lockfile --ignore-scripts \
        || (echo 'Dependency installation failed; retrying official npm with TLS 1.2' >&2 \
            && NODE_OPTIONS=--tls-max-v1.2 pnpm install --frozen-lockfile --ignore-scripts))
COPY web web
COPY config config
RUN pnpm run build:web

FROM ubuntu:24.04 AS builder

RUN for attempt in 1 2 3; do \
        apt-get -o Acquire::Retries=3 update && break; \
        if [ "$attempt" -eq 3 ]; then exit 1; fi; \
        sleep 2; \
    done \
    && for attempt in 1 2 3; do \
        DEBIAN_FRONTEND=noninteractive apt-get -o Acquire::Retries=3 install -y --no-install-recommends \
            build-essential \
            ca-certificates \
            cmake \
            ninja-build && break; \
        if [ "$attempt" -eq 3 ]; then exit 1; fi; \
        sleep 2; \
    done \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /src
COPY . .

RUN cmake -S . -B build -G Ninja \
        -DCMAKE_BUILD_TYPE=Release \
        -DREGISTRATION_BUILD_TESTS=OFF \
    && cmake --build build --parallel \
    && cmake --install build --prefix /opt/registration

FROM ubuntu:24.04 AS runtime

RUN for attempt in 1 2 3; do \
        apt-get -o Acquire::Retries=3 update && break; \
        if [ "$attempt" -eq 3 ]; then exit 1; fi; \
        sleep 2; \
    done \
    && for attempt in 1 2 3; do \
        DEBIAN_FRONTEND=noninteractive apt-get -o Acquire::Retries=3 install -y --no-install-recommends \
            ca-certificates \
            libstdc++6 \
            python3 \
            python3-venv && break; \
        if [ "$attempt" -eq 3 ]; then exit 1; fi; \
        sleep 2; \
    done \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --system registration \
    && useradd --system --create-home --gid registration --home-dir /var/lib/registration registration \
    && mkdir -p /data/source /data/runtime /usr/share/licenses/ply-pcd-registration \
    && chown -R registration:registration /data/runtime /var/lib/registration

COPY service/requirements.lock.txt /tmp/service-requirements.txt
RUN python3 -m venv /opt/registration-venv \
    && /opt/registration-venv/bin/pip install --no-cache-dir --require-hashes -r /tmp/service-requirements.txt

COPY --from=builder /opt/registration/bin/registration_worker /usr/local/bin/registration_worker
COPY --from=web-builder /usr/local/bin/node /usr/local/bin/node
COPY LICENSE NOTICE THIRD_PARTY_NOTICES.md /usr/share/licenses/ply-pcd-registration/
COPY LICENSES /usr/share/licenses/ply-pcd-registration/LICENSES
COPY service /opt/registration-service/service
COPY --from=web-builder /src/node_modules /opt/registration-service/node_modules
COPY --from=web-builder /src/service/static /opt/registration-service/service/static
RUN PYTHONPATH=/opt/registration-service /opt/registration-venv/bin/python -c "import service.app"

USER registration
WORKDIR /data

ENTRYPOINT ["registration_worker"]
CMD ["inspect-pcd", "/data/source/pcd/GlobalMap.pcd"]
