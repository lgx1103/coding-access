#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
if [ "$#" -ne 1 ]; then
  echo '用法：sh deploy/docker-init.sh http://服务器内网IP:4317' >&2
  exit 1
fi
if [ -e .env ] || [ -e .local/access.sqlite ] || [ -e .local/initial-credentials.txt ]; then
  echo '已有配置或数据；迁移部署请保留配套 .env 和数据库，不要重新初始化。' >&2
  exit 1
fi
docker info >/dev/null
docker build -f deploy/Dockerfile.runtime -t coding-access-runtime .
docker run --rm --user 0 --mount "type=bind,src=$PWD,dst=/workspace" --workdir /workspace coding-access-runtime node /app/dist/scripts/setup.js --docker "$1"
