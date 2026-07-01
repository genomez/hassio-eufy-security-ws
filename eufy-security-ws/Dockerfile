ARG BUILD_FROM
FROM $BUILD_FROM

ARG EUFY_SECURITY_WS_VERSION
ARG EUFY_SECURITY_CLIENT_GIT

WORKDIR /usr/src/app
COPY eufy-security-ws-mega-login.patch /tmp/

RUN \
    set -x \
    && apk add --no-cache jq nodejs npm patch \
    && case "$(node --version)" in v24.*) ;; *) echo "Expected Node 24, got $(node --version)" >&2; exit 1 ;; esac \
    && npm install --force "eufy-security-ws@${EUFY_SECURITY_WS_VERSION}" \
    && if [ -n "$EUFY_SECURITY_CLIENT_GIT" ]; then \
         npm install --force "$EUFY_SECURITY_CLIENT_GIT" --prefix node_modules/eufy-security-ws \
         && cd node_modules/eufy-security-ws/node_modules/eufy-security-client \
         && npm install --include=dev \
         && npm run build; \
       fi \
    && cd node_modules/eufy-security-ws \
    && patch -p1 < /tmp/eufy-security-ws-mega-login.patch \
    && npm install --include=dev \
    && npm run build

COPY run.sh /
RUN chmod a+x /run.sh
WORKDIR /data

CMD [ "/run.sh" ]
