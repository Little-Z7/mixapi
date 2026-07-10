# 部署到服务器(Docker)

mixapi 是单进程 Bun 应用,数据存一个 SQLite 文件,无外部数据库。下面用 Docker + Caddy(自动 HTTPS)一键部署。

## 前提
- 一台装了 **Docker + Docker Compose** 的 Linux 服务器
- 一个**域名**,A 记录解析到该服务器 IP
- 服务器**开放 80 / 443** 端口(Caddy 申请证书 + 对外服务)

## 步骤

```bash
# 1. 拉代码(内网/国内走 Gitee,与 GitHub 实时同步)
git clone https://gitee.com/tangenzhe/mixapi.git
cd mixapi

# 2. 配置环境变量
cp .env.example .env
openssl rand -hex 32          # 复制输出,填到 .env 的 MASTER_KEY
vi .env                       # 填 MASTER_KEY / ADMIN_KEY / GATEWAY_KEY / DOMAIN

# 3. 起服务(首次会构建镜像 + Caddy 自动签发 HTTPS 证书)
docker compose up -d --build

# 4. 看日志确认
docker compose logs -f mixapi
```

就绪后访问 **`https://<你的域名>/admin`**,用 `ADMIN_KEY` 登录。

## 配置账号池
控制台 → **账号池 → 添加账号**:
- 适配器:GLM(Anthropic 兼容)填 `anthropic`;OpenCode(OpenAI 兼容)填 `openai`
- 基础 URL:上游渠道地址(见 `config.example.json` 示例)
- 密钥:上游 API key
- 模型:手填,或点 **「从渠道检测模型」** 自动拉取
保存即生效(自动被 `/v1/models` 列出 + 可路由)。

## 客户端接入
把请求发到 **`https://<你的域名>`**,`Authorization: Bearer <gateway-key>`:
- OpenAI 客户端:`base_url = https://<域名>/v1`
- Claude Code / Anthropic:`ANTHROPIC_BASE_URL = https://<域名>`,token = gateway-key
- 端点:`/v1/chat/completions`(OpenAI)、`/v1/responses`(OpenAI Responses API)、`/v1/messages`(Anthropic)、`/v1/models`

## 运维

```bash
# 升级(拉新代码后重建)
git pull && docker compose up -d --build

# 备份数据库(整个池子的配置+日志都在这一个文件)
docker compose cp mixapi:/data/mixapi.sqlite ./mixapi-backup-$(date +%F).sqlite

# 停 / 起 / 看状态
docker compose down
docker compose up -d
docker compose ps
```

- **数据**:持久化在 docker 卷 `mixapi-data`(容器内 `/data/mixapi.sqlite`)。删容器不丢数据;删卷才丢。
- **HTTPS**:Caddy 自动签发/续期,证书存在 `caddy-data` 卷,无需手动管理。
- **MASTER_KEY**:务必固定。一旦更换,已存的账号密钥将无法解密(需重新录入所有账号密钥)。

## 内网 / 连不上 GitHub

- **代码**:用 Gitee 源(每次提交自动镜像同步):`git clone https://gitee.com/tangenzhe/mixapi.git`。
- `docker compose up --build` 还会拉两样外网资源,内网需确认能否访问,否则配国内镜像:
  - **基础镜像** `oven/bun:1`、`caddy:2`(Docker Hub)。连不上就给 Docker 配加速器:`/etc/docker/daemon.json` 里加 `{"registry-mirrors":["https://<你的镜像地址>"]}` 后 `systemctl restart docker`;或从内网私有 registry 拉。
  - **依赖 hono**(`bun install` 走 npm)。连不上就用国内源:在 `Dockerfile` 的 `RUN bun install` 之前加一行 `ENV BUN_CONFIG_REGISTRY=https://registry.npmmirror.com`。
- **彻底离线**(内网完全无外网):在一台能联网的机器上 `docker build -t mixapi .`,再 `docker save mixapi | gzip > mixapi.tar.gz` 拷进内网 `gunzip -c mixapi.tar.gz | docker load`;把 `docker-compose.yml` 里 `build: .` 改成 `image: mixapi`。`caddy:2` 同理离线导入;若内网不需要公网 HTTPS,直接用下面的「纯本地」变体 + 内网/自签证书即可。

## 无域名 / 纯本地调试
不想上 HTTPS 时:编辑 `docker-compose.yml` 删掉 `caddy` 服务、给 `mixapi` 加 `ports: ["8080:8080"]`,并在 `.env` 加 `ADMIN_INSECURE_COOKIE=1`,然后 `docker compose up -d --build`,访问 `http://<服务器IP>:8080/admin`。仅供测试,别对公网这么开。
