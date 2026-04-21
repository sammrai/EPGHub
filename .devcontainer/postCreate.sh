#!/usr/bin/env bash
# Idempotent devcontainer setup: tools, Postgres init, npm installs, migrations.
set -euo pipefail

sudo apt-get update -qq
sudo apt-get install -y -qq build-essential python3 ffmpeg

# Postgres is provided by the devcontainer feature but ensure service and role
# exist. The itsmechlark/postgresql feature sets up postgres user; we create
# an app role + database if they're missing.
if ! command -v psql >/dev/null; then
  echo "psql not found; falling back to apt" >&2
  sudo apt-get install -y -qq postgresql postgresql-contrib
fi
sudo -n service postgresql start

sudo -n su postgres -c "psql -tAc \"SELECT 1 FROM pg_roles WHERE rolname='epghub'\"" | grep -q 1 \
  || sudo -n su postgres -c "psql -c \"CREATE ROLE epghub LOGIN PASSWORD 'epghub' SUPERUSER\""

sudo -n su postgres -c "psql -tAc \"SELECT 1 FROM pg_database WHERE datname='epghub'\"" | grep -q 1 \
  || sudo -n su postgres -c "psql -c \"CREATE DATABASE epghub OWNER epghub\""

# Project installs
if [ -d EPGStation ]; then (cd EPGStation && npm run all-install); fi
if [ -d server ]; then
  (cd server && [ -f .env ] || cp .env.example .env)
  (cd server && npm install && npm run db:migrate)
fi
if [ -d app ]; then (cd app && npm install); fi

echo "postCreate complete"
