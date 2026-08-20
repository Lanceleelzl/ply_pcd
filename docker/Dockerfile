FROM ubuntu:24.04 AS builder

RUN apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
        build-essential \
        ca-certificates \
        cmake \
        ninja-build \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /src
COPY . .

RUN cmake -S . -B build -G Ninja \
        -DCMAKE_BUILD_TYPE=Release \
        -DREGISTRATION_BUILD_TESTS=OFF \
    && cmake --build build --parallel \
    && cmake --install build --prefix /opt/registration

FROM ubuntu:24.04 AS runtime

RUN apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
        ca-certificates \
        libstdc++6 \
        python3 \
        python3-venv \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --system registration \
    && useradd --system --create-home --gid registration --home-dir /var/lib/registration registration \
    && mkdir -p /data/source /data/runtime /usr/share/licenses/ply-pcd-registration \
    && chown -R registration:registration /data/runtime /var/lib/registration

COPY service/requirements.txt /tmp/service-requirements.txt
RUN python3 -m venv /opt/registration-venv \
    && /opt/registration-venv/bin/pip install --no-cache-dir -r /tmp/service-requirements.txt

COPY --from=builder /opt/registration/bin/registration_worker /usr/local/bin/registration_worker
COPY LICENSE NOTICE THIRD_PARTY_NOTICES.md /usr/share/licenses/ply-pcd-registration/
COPY LICENSES /usr/share/licenses/ply-pcd-registration/LICENSES
COPY service /opt/registration-service

USER registration
WORKDIR /data

ENTRYPOINT ["registration_worker"]
CMD ["inspect-pcd", "/data/source/pcd/GlobalMap.pcd"]
