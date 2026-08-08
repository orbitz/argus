#!/usr/bin/env bash
#
# Issues the TLS certificate the github.com proxy needs and prints the client-side steps.
#
# Two paths: mkcert if it is installed (it also handles the trust stores for you), plain
# openssl otherwise. Either way the output is a CA certificate you install on every machine
# whose browser should see Argus, plus a leaf certificate for github.com that nginx serves.
#
# Usage: sudo deploy/nginx/setup.sh [output-dir]     (default /etc/nginx/certs)
#
# This script writes certificates and nothing else. It does not touch /etc/hosts, reload
# nginx, or install anything into a trust store on its own — those steps are printed at the
# end so you can read them before running them.

set -euo pipefail

CERT_DIR="${1:-/etc/nginx/certs}"
DOMAINS=(github.com www.github.com)
CA_KEY="$CERT_DIR/argus-local-ca-key.pem"
CA_CERT="$CERT_DIR/argus-local-ca.pem"
LEAF_KEY="$CERT_DIR/github.com-key.pem"
LEAF_CERT="$CERT_DIR/github.com.pem"
# Long enough not to be a chore, short enough that a forgotten install expires on its own.
DAYS=825

mkdir -p "$CERT_DIR"
chmod 755 "$CERT_DIR"

if command -v mkcert >/dev/null 2>&1; then
  echo "==> Using mkcert"
  mkcert -install
  mkcert -cert-file "$LEAF_CERT" -key-file "$LEAF_KEY" "${DOMAINS[@]}"
  CA_CERT="$(mkcert -CAROOT)/rootCA.pem"
else
  echo "==> mkcert not found, using openssl"

  if [ ! -f "$CA_CERT" ]; then
    echo "--> Creating local CA"
    openssl req -x509 -newkey rsa:4096 -sha256 -days 3650 -nodes \
      -keyout "$CA_KEY" -out "$CA_CERT" \
      -subj "/CN=Argus Local CA/O=Argus" \
      -addext "basicConstraints=critical,CA:TRUE,pathlen:0" \
      -addext "keyUsage=critical,keyCertSign,cRLSign" 2>/dev/null
    # The CA private key can mint a certificate for any site this machine's users trust.
    chmod 600 "$CA_KEY"
  else
    echo "--> Reusing existing CA at $CA_CERT"
  fi

  echo "--> Issuing certificate for ${DOMAINS[*]}"
  san=""
  for domain in "${DOMAINS[@]}"; do
    san="${san}${san:+,}DNS:${domain}"
  done

  openssl req -newkey rsa:2048 -sha256 -nodes \
    -keyout "$LEAF_KEY" -out "$CERT_DIR/github.com.csr" \
    -subj "/CN=${DOMAINS[0]}" 2>/dev/null

  openssl x509 -req -in "$CERT_DIR/github.com.csr" -days "$DAYS" -sha256 \
    -CA "$CA_CERT" -CAkey "$CA_KEY" -CAcreateserial \
    -out "$LEAF_CERT" \
    -extfile <(printf 'subjectAltName=%s\nbasicConstraints=CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n' "$san") 2>/dev/null

  rm -f "$CERT_DIR/github.com.csr"
fi

chmod 640 "$LEAF_KEY" 2>/dev/null || true
if getent group www-data >/dev/null 2>&1; then
  chgrp www-data "$LEAF_KEY" 2>/dev/null || true
fi

server_ip="$(ip -4 -o addr show scope global 2>/dev/null | awk '{print $4}' | cut -d/ -f1 | head -1)"
server_ip="${server_ip:-<this-server-ip>}"

cat <<EOF

Certificates written:
  CA (install on every client): $CA_CERT
  Server certificate:           $LEAF_CERT
  Server key:                   $LEAF_KEY

Next steps
----------

1. On this server:

     cp deploy/nginx/argus-github.conf /etc/nginx/sites-available/
     ln -sf /etc/nginx/sites-available/argus-github.conf /etc/nginx/sites-enabled/
     nginx -t && systemctl reload nginx

2. On every machine whose browser should see Argus, add a hosts entry
   (/etc/hosts, or C:\\Windows\\System32\\drivers\\etc\\hosts):

     $server_ip  github.com www.github.com

3. On those same machines, install $CA_CERT as a trusted root:

     Linux   sudo cp argus-local-ca.pem /usr/local/share/ca-certificates/argus-local-ca.crt
             sudo update-ca-certificates
     macOS   sudo security add-trusted-cert -d -r trustRoot \\
               -k /Library/Keychains/System.keychain argus-local-ca.pem
     Windows certutil -addstore -f ROOT argus-local-ca.pem
     Firefox has its own store: Settings > Privacy & Security > Certificates >
             View Certificates > Authorities > Import, and tick "identify websites".

   Chrome and Firefox both need a full restart afterwards.

Trusting this CA means whoever holds $CA_KEY
can impersonate any website to those machines. Keep the key on this server only.
EOF
