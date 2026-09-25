#!/usr/bin/env bash
# Rakazo one-command installer.
#
# Checks prerequisites, creates .env from .env.example (generating a random
# JWT_SECRET if needed), then builds and starts the stack with Docker Compose.
#
# Usage: ./install.sh
set -euo pipefail

cd "$(dirname "$0")"

missing=()

# --- Prerequisite checks -------------------------------------------------
if ! command -v docker >/dev/null 2>&1; then
  missing+=("Docker Engine (docker)")
elif ! docker --version >/dev/null 2>&1; then
  missing+=("Docker Engine (docker is installed but 'docker --version' failed — is the daemon reachable?)")
fi

if ! docker compose version >/dev/null 2>&1; then
  missing+=("Docker Compose plugin ('docker compose version' failed — install docker-compose-plugin)")
fi

if ! command -v curl >/dev/null 2>&1; then
  missing+=("curl")
fi

if ! command -v openssl >/dev/null 2>&1; then
  missing+=("openssl (needed to generate JWT_SECRET)")
fi

if [ "${#missing[@]}" -gt 0 ]; then
  echo "ERROR: Rakazo cannot be installed — the following prerequisites are missing:" >&2
  for item in "${missing[@]}"; do
    echo "  - ${item}" >&2
  done
  echo "" >&2
  echo "Install the missing tools and run ./install.sh again." >&2
  echo "See https://docs.docker.com/engine/install/ for Docker Engine + Compose." >&2
  exit 1
fi

echo "✔ Prerequisites OK: $(docker --version | head -n1), $(docker compose version --short 2>/dev/null || docker compose version | head -n1)"

# --- .env bootstrap -------------------------------------------------------
if [ -f .env ]; then
  echo "✔ .env already exists — leaving it untouched."
else
  if [ ! -f .env.example ]; then
    echo "ERROR: .env.example not found in $(pwd) — cannot create .env." >&2
    exit 1
  fi
  echo "Creating .env from .env.example ..."
  cp .env.example .env
  secret="$(openssl rand -hex 32)"
  if grep -q '^JWT_SECRET=' .env; then
    # Replace the value on the JWT_SECRET line, preserving any surrounding text.
    sed -i "s|^JWT_SECRET=.*|JWT_SECRET=${secret}|" .env
  else
    echo "JWT_SECRET=${secret}" >> .env
  fi
  echo "✔ .env created with a freshly generated JWT_SECRET."
  echo "  Tip: edit .env (CORS_ORIGINS, model provider keys) before going to production."
fi

# --- Build & start --------------------------------------------------------
echo "Building and starting the Rakazo stack (this may take a few minutes) ..."
docker compose up -d --build

# --- Next steps -----------------------------------------------------------
echo ""
echo "=============================================="
echo "  Rakazo is up and running!"
echo "=============================================="
echo ""
echo "  API:              http://localhost:8000"
echo "  Interactive docs: http://localhost:8000/docs"
echo "  Health check:     http://localhost:8000/api/health"
echo ""
echo "  The API container mounts /var/run/docker.sock so the built-in"
echo "  local_docker sandbox can spawn a real container per bot session."
echo ""
echo "  Next steps:"
echo "    - Point a web client at the API:"
echo "        cd web && npm install && npm run dev"
echo "    - View logs:"
echo "        docker compose logs -f"
echo "    - Check container status:"
echo "        docker compose ps"
echo "    - Stop everything:"
echo "        docker compose down"
echo ""
echo "  Self-hosting, backups, and upgrade notes: docs/self-hosting.md"
