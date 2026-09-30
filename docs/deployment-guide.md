# 小白部署指南（从零到跑起来）

> 面向**没有开发经验**的用户：跟着本文一步步操作，30~60 分钟即可把平台部署到自己的电脑上并跑通真实 AI 对话。
> 以 **Windows 11** 为主示例（macOS / Linux 差异已在括号中标注）。
> 架构细节见 `docs/architecture/ai-agent-platform-architecture-v1.md`。

---

## 0. 这套系统是什么

一套前后端一体的 AI Agent 平台：

- **Web 界面**（浏览器打开 `http://localhost:3000`）：对话、派活、知识库、记忆、工作流、数据分析……
- **后端 API**（`http://localhost:3001`）：真正干活的部分——调用你配置的 AI 模型（DeepSeek/OpenAI/Kimi/通义万相等）执行任务
- **三个"底座"服务**（用 Docker 一键启动）：PostgreSQL 数据库、Redis 队列、MinIO 文件存储

```
浏览器 → Web(:3000) → API(:3001) → 你配置的 AI 模型（云端）
                         ↑
                    Worker（后台干活的工人）
```

**启动全平台 = 3 个 Docker 容器 + 3 个程序进程（API / Worker / Web）。**

---

## 1. 准备工作：要装哪些软件

| 软件 | 版本要求 | 干什么用 | 下载地址 |
|---|---|---|---|
| Node.js | **≥ 20（推荐 22 LTS）** | 运行前后端的运行环境 | https://nodejs.org （选 LTS 版，一路"下一步"） |
| Docker Desktop | 最新版 | 一键跑数据库/队列/存储 | https://www.docker.com/products/docker-desktop/ |
| Git | 任意 | 下载代码 | https://git-scm.com/downloads |
| Chrome 浏览器 | 任意（可选） | 日常使用 + 跑自动化测试 | 官网 |

> macOS / Linux：Docker 装 Docker Engine；其余命令相同。

### 1.1 安装后验证（打开终端/命令提示符执行）

```bash
node -v      # 应输出 v22.x.x
git --version
docker --version
```

**Node 装好后还需要启用 pnpm**（包管理器，项目锁定的版本会自动匹配）：

```bash
corepack enable     # 一行命令，什么都不用下载
pnpm -v             # 输出 9.x（若提示命令不存在，先关掉终端重开一次）
```

---

## 2. 下载代码

```bash
git clone https://github.com/Nico-rich/zuixin.git
cd zuixin
```

---

## 3. 启动三个底座服务（Docker）

**先打开 Docker Desktop**（桌面双击图标，等左下角小鲸鱼变绿）——忘了这步是最常见的报错原因。

```bash
docker compose -f docker/compose.yml up -d
```

第一次会下载镜像（几分钟）；之后都是秒启。验证：

```bash
docker ps
# 应看到 docker-postgres-1 / docker-redis-1 / docker-minio-1 三行，STATUS 为 healthy
```

| 服务 | 端口 | 说明 |
|---|---|---|
| PostgreSQL（含向量检索） | 5433 | 所有数据存在这里 |
| Redis | 6379 | 任务队列 |
| MinIO | 9000（存储）/ 9001（控制台） | 图片/视频/文件 |

> 这三个容器的数据都存在 Docker 里，**电脑重启后记得先开 Docker Desktop，再执行上面的 `up -d`**。

---

## 4. 配置环境变量（关键一步）

```bash
cp .env.example .env
```

用记事本打开项目根目录的 `.env`，**必须修改 3 项**（不改也能跑开发模式，但强烈建议改）：

| 变量 | 怎么填 |
|---|---|
| `JWT_SECRET` | 运行 `openssl rand -base64 32` 生成一串乱码，粘贴进去 |
| `ENCRYPTION_KEY` | 同上，再生成一串（AI 模型的 API Key 靠它加密落库，**设好后不要再改**） |
| `SEED_ADMIN_PASSWORD` | 你的管理员登录密码（≥12 位） |

其余保持默认即可（数据库连接、Redis 地址、存储位置都预填好了，对应第 3 步的容器默认配置）。

> 生产模式注意：`JWT_SECRET`/`ENCRYPTION_KEY` 填占位符会被拒绝启动；`SEED_ADMIN_PASSWORD` 过短或为默认口令会被拒绝创建管理员。生成命令在 macOS/Linux 一样是 `openssl rand -base64 32`。

---

## 5. 安装依赖 + 初始化数据库

```bash
pnpm install        # 装依赖（首次几分钟）
pnpm db:migrate     # 建表
pnpm db:seed        # 写入初始数据（管理员账号 + 模型厂商注册表）
```

此时数据库里已有：管理员账号 `admin@example.com`（密码 = 你在 .env 里填的）+ 14 家 AI 厂商的注册信息（DeepSeek、OpenAI、Kimi、智谱、豆包、通义万相等，**默认停用、等待你填 Key**）。

---

## 6. 启动平台

### 方式 A：开发模式（日常使用推荐）

```bash
pnpm dev            # 终端 1：同时起 API(:3001) + Web(:3000)
```

**再开一个终端**（后台工人，必须单独跑）：

```bash
cd apps/api && pnpm dev:worker
```

看到类似 `Worker 已启动（image/video/... 队列消费端）` 即成功。

### 方式 B：生产模式（更接近正式部署）

```bash
pnpm build          # 一次性构建
```

然后**开三个终端**分别执行：

```bash
# 终端 1：API
cd apps/api && pnpm start
# 终端 2：Worker
cd apps/api && pnpm dev:worker
# 终端 3：Web
cd apps/web && pnpm exec next start -p 3000
```

> 注意：跑过开发模式（`pnpm dev`）后再用生产模式，需要重新 `pnpm build` 一次（开发模式会覆盖构建产物）。

### 验证

浏览器打开 **http://localhost:3000** → 能看到登录页 = 成功。健康检查：http://localhost:3001/api/v1/health 返回 `ready:true`。

---

## 7. 登录

- 账号：`admin@example.com`
- 密码：`.env` 里 `SEED_ADMIN_PASSWORD` 填的那个

---

## 8. 配置真实 AI 模型（让它真正会干活）

**不配模型也能用**：平台自带"本地替身"（mock），对话会得到占位回复，供体验流程。**要真实 AI 能力，按下面 3 步走**：

1. 登录后，左侧导航 **系统 → 模型配置**（`/settings/models`）
2. 找一家你想用的厂商，点 **编辑**：
   - **API Key**：粘贴你从厂商官网申请的密钥（密码框，**保存后永不再显示**，留空=不修改）
   - 勾选 **启用**
   - 下方**模型启停**区：勾选你想用的模型（部分厂商的模型默认停用，尤其生图/生视频）
   - 点 **保存**——**立即生效，不用重启**
3. 回到「对话」页面发消息 → 真实模型流式回复

| 用途 | 推荐配置 |
|---|---|
| 对话 / 干活的"大脑" | DeepSeek、Kimi、智谱 GLM、豆包、Qwen、OpenAI（任一即可） |
| 生成图片 | 通义万相、OpenAI Image、智谱 CogView |
| 生成视频 | 通义万相视频 |
| 检索/记忆（Embedding） | 默认内置替身即可，不花钱，无需配置 |

**「默认模型（优先级偏好）」**：只有同一用途配了多家厂商时才需要设置（决定优先用谁）；只配一家时可忽略。

> 提示：跑自动化测试后 mock 替身会被临时自动启用（测试依赖），属正常现象，可在配置页再停用。

---

## 9. 平台能干什么（页面导览）

| 页面 | 用途 |
|---|---|
| 对话 | 聊天派活：做图、做视频、查资料、写方案（任务以"卡片"形式实时展示进度） |
| 工作流 | 把多步任务编排成固定流程（可含人工审批节点） |
| Agents / Agent 运行 | 管理可调用的智能体、查看历史运行与时间线 |
| 知识库 / 记忆 | 喂资料让它记住；长期记忆自动沉淀 |
| 创意工作台 | 创意简报、假设、洞察闭环 |
| 评测 | 给 Agent 出考题、跑分 |
| 分析 / 反馈 / 用量 / 账单 | 使用数据、计费账本、绩效反馈 |
| 连接 / 组织团队 | 外部服务连接、团队与权限 |
| 扩展市场 / 扩展管理 | 安装/管理能力扩展 |
| 设置 / 模型配置 | 会话管理 / AI 厂商接入（管理员） |

---

## 10. 停止与重启

- **停止**：在每个启动终端按 `Ctrl+C`；Docker 底座可以继续开着（省得下次再等）
- **完全关机**：`docker compose -f docker/compose.yml down`（数据不丢，存在 Docker 卷里）
- **重启**：重跑第 6 步的启动命令即可
- Windows 提示：如果 Ctrl+C 后端口仍被占用（`netstat -ano | findstr :3001` 能看到进程），说明子进程没退干净，在任务管理器结束对应的 node.exe 即可

---

## 11. 常见问题（FAQ）

| 现象 | 原因与解决 |
|---|---|
| `Can't reach database server at localhost:5433` | Docker Desktop 没开，或容器没起来 → 执行第 3 步 |
| 端口被占用（EADDRINUSE） | 3000/3001/5433/6379/9000 被别的程序占了 → 换端口（.env 里 API_PORT/WEB_PORT）或关掉占用程序 |
| 登录后提示「未登录/401」 | 会话过期 → 重新登录 |
| 对话提示「当前没有可用的模型服务」 | 没有启用的厂商/模型 → 去模型配置页填 Key 并勾选启用（含模型级开关） |
| 对话提示「请求参数错误（厂商：…）」 | 厂商拒绝了请求，括号里是真实原因（例如 Key 无效会提示鉴权失败） |
| `pnpm` 命令不存在 | `corepack enable` 后重开终端 |
| 中文在界面上正常、但我在终端测试时变乱码 | Windows 终端编码问题，与平台无关（浏览器里正常即正常） |
| 生产模式网页打不开，提示没有构建产物 | 跑过开发模式后需重新 `pnpm build` |
| 装依赖报锁文件过期 | `pnpm install` 会提示；按提示执行即可（不要用 npm） |

---

## 12. 常用命令速查

```bash
docker compose -f docker/compose.yml up -d     # 启动底座（Docker）
docker compose -f docker/compose.yml down      # 停底座（数据保留）
pnpm install                                   # 装/更新依赖
pnpm db:migrate && pnpm db:seed                # 初始化数据库 + 种子数据
pnpm dev                                       # 开发模式启动 API+Web
pnpm build                                     # 生产构建
pnpm test / pnpm typecheck                     # 跑测试 / 类型检查
```

---

## 13. 进阶（可选）

- **换对象存储**：`.env` 里 `STORAGE_DRIVER=s3-compatible` + 填 MinIO/R2/S3 的密钥（默认 local 存本地 `apps/api/data/storage`）
- **备份**：见 `docs/architecture/` 下运维手册（逻辑备份 + 对象存储归档 + PITR 演练均已实现）
- **安全加固**：生产环境设 `NODE_ENV=production` 后，平台会自动启用生产守卫（密钥校验、故障注入开关禁用、限流收紧）
- **多机部署**：仓库含 Dockerfile 与 k8s 配置（见 `docs/architecture/m11-final-baseline.md` §P16）
