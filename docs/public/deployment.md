# 部署、备份与升级

## 方式一：Linux + Docker Compose

推荐首次部署使用 [Release 的服务端运行包](https://github.com/lgx1103/coding-access/releases/tag/server-v0.1.22)。Linux 服务器需安装 Docker Engine 与 Docker Compose v2，当前账号需有 Docker 操作权限；宿主机不需要安装 Node.js。

### 1. 下载并校验运行包

```sh
mkdir coding-access &&
cd coding-access &&
release_url=https://github.com/lgx1103/coding-access/releases/download/server-v0.1.22 &&
curl -fLO "$release_url/Coding-Access-0.1.22-server.tar.gz" &&
curl -fLO "$release_url/SHA256SUMS" &&
sha256sum --check --ignore-missing SHA256SUMS &&
  tar -xzf Coding-Access-0.1.22-server.tar.gz
```

确认校验输出 `OK` 后再解压。也可以在本机下载这两个文件并上传到服务器的同一目录，再执行校验和解压。不要下载自动生成的 `Source code` 来替代运行包。

### 2. 初始化并启动

将 `YOUR_SERVER_IP` 替换为服务器实际内网 IP；确保团队设备能访问该 IP 的 4317 端口。以下仅适用于首次部署，已有环境请跳到“更新已有 Docker 服务”。

```sh
sh deploy/docker-init.sh http://YOUR_SERVER_IP:4317 &&
docker compose --env-file .env -f deploy/compose.yaml up -d --build &&
docker compose --env-file .env -f deploy/compose.yaml ps
```

初始化只用于空环境，会生成自己的主密钥和初始管理员密码。密码见 `.local/initial-credentials.txt`，首次登录后按页面提示修改。已有 `.env` 或数据库时不要重新初始化。

### 3. 检查服务并登录

容器首次启动可能短暂显示 `health: starting`。执行以下命令检查健康，再在浏览器打开 `http://YOUR_SERVER_IP:4317`：

```sh
curl --noproxy '*' --retry 15 --retry-delay 2 --retry-connrefused \
  -fsS http://YOUR_SERVER_IP:4317/health
```

管理员用户名为 `admin`，密码从 `.local/initial-credentials.txt` 读取，不要将该文件上传到 GitHub。若端口绑定服务器内网 IP，127.0.0.1 不一定能访问宿主机映射端口。容器自己的健康检查使用容器内回环地址。启动失败时查看 `docker compose --env-file .env -f deploy/compose.yaml logs --tail=100 coding-access`。

客户端填写相同的团队服务地址。跨网络使用时需要可达网络（例如团队 VPN）。对外网络部署应配置 HTTPS 和访问限制；应用内更新签名不替代传输加密。

## 方式二：直接运行 Node.js

需要 Node.js 22.16+，建议使用 Node.js 24。先按上文下载、校验并解压服务端运行包，在解压目录执行：

```sh
npm ci --omit=dev
node dist/scripts/setup.js
```

编辑 `.env`：设置 `ACA_HOST=0.0.0.0`、`ACA_PUBLIC_URL=http://YOUR_SERVER_IP:4317`、`NODE_ENV=production`，保留自动生成的主密钥和管理员密码，然后启动：

```sh
npm start
```

默认回环监听只允许本机访问。管理员初始密码仍在 `.local/initial-credentials.txt`，健康检查与上文相同。正式服务应使用进程管理器或 Docker 保持运行。

如果使用的是**源码**，才需要构建步骤（不要对服务端运行包执行下面命令）：

```sh
npm ci
npm run setup
npm run build
```

按上面的说明修改 `.env` 后执行 `npm start`。要从源码生成 Docker 使用的运行包，可执行 `npm run package:server`，再将产物传到服务器。

## 第一次配置

1. 登录管理界面，添加供应商；为不同套餐分别维护协议地址。
2. 添加对应密钥。不要把 Coding Plan 与 Agent Plan 的密钥混放。
3. 创建模型，手填厂商真实模型 ID，配置接入权重和模型能力，发布到需要的成员范围。
4. 添加成员。成员安装客户端并登录后，从服务端获取已授权模型，无需导入管理员的配置文件。

## 更新已有 Docker 服务

先上传新运行包到部署目录，校验 Release 提供的 SHA256。以下命令在部署目录执行，`upgrade_package` 改成实际包名：

```sh
bash <<'SH'
set -eu
upgrade_package=./Coding-Access-0.1.22-server.tar.gz
tar -tzf "$upgrade_package" >/dev/null
backup_dir=$(mktemp -d ../coding-access-backup-XXXXXXXX)
chmod 700 "$backup_dir"
docker compose --env-file .env -f deploy/compose.yaml stop coding-access
if ! tar -czf "$backup_dir/before-upgrade.tar.gz" .env .local dist deploy package.json package-lock.json release; then
  docker compose --env-file .env -f deploy/compose.yaml start coding-access
  exit 1
fi
printf '备份位置：%s/before-upgrade.tar.gz\n' "$backup_dir"
tar -xzf "$upgrade_package" -C .
docker compose --env-file .env -f deploy/compose.yaml up -d --build
docker compose --env-file .env -f deploy/compose.yaml ps
SH
```

升级后检查健康接口、登录、模型列表，并完成一次真实对话和工具调用。服务端与客户端独立更新；服务端修复不意味着必须重装客户端。

## 备份与回退

必须一起保存 `.env` 和 `.local`，同时保存发布文件目录 `release`；自定义了外部目录的，还需备份那些目录。`.local` 包含数据库及上传的客户端发布文件。数据库中的元数据不能代替安装包字节。

若升级失败，停止该项目容器，保留当前目录副本，将升级前备份解压到原部署目录，重新执行 Compose 构建启动。恢复完整备份会恢复到当时的数据状态，升级后的记录不保留。不要将旧数据库与另一份主密钥混用。
