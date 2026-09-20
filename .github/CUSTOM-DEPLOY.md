# 🚀 自定义部署说明（CUSTOM-DEPLOY）

> 本文件记录本仓库（RolinShmily/cloud-mail）在**上游 maillab/cloud-mail 之外**新增/修改的部署相关内容，
> 供后续维护、排障、同步上游时查阅。

---

## 1. 仓库双源结构

| 源 | 地址 | 说明 |
|---|---|---|
| `origin` | `https://github.com/RolinShmily/cloud-mail.git` | 本仓库（已同步到上游最新） |
| `upstream` | `https://github.com/maillab/cloud-mail.git` | 上游，默认分支为 `main`，另有 `dev` 分支 |

> ⚠️ 注意：上游历史曾被**完全重写**（force-push），本仓库与上游当前历史**无共同祖先**。
> 已采用「独立文件」策略保证同步零冲突：所有自定义内容都放在上游永远不会出现的路径下。

**备份分支**：`backup/old-main-9fa9f78` —— 含本仓库被弃用前的分支（其中 5 个 CI 提交的净效果已并入 `deploy-cloudflare-custom.yml`）。如需找回：`git checkout backup/old-main-9fa9f78 -- <path>`。

---

## 2. 目录与 Worker 一览

```
.github/
├── CUSTOM-DEPLOY.md                    ← 本文档
├── webhook-relay/                      ← 第二个 Worker：Cloud Mail → 飞书 格式转换中继
│   ├── src/index.js                    ← 中继逻辑（见 §5）
│   └── wrangler.toml                   ← worker 名：webhook-relay
└── workflows/
    ├── deploy-cloudflare.yml           ← 上游原版（仅加 1 行 job 守卫，只在上游仓库运行）
    ├── deploy-cloudflare-custom.yml    ← 本仓库主部署（含 3 个 CI 修复）+ 联动中继部署
    └── deploy-lark-hook.yml            ← 中继 Worker 部署（可被调用 / 可独立触发）
```

**部署形态 = 两个 Worker**：

| Worker 名 | 来源 | 职责 |
|---|---|---|
| `cloud-mail` | 上游 `mail-worker/` | 邮箱服务本体 |
| `webhook-relay` | `.github/webhook-relay/`（本仓库独有） | 接收 Cloud Mail webhook 推送，转换为飞书格式转发 |

---

## 3. 触发方式

| 场景 | 触发 |
|---|---|
| 改动 `mail-worker/**`、`mail-vue/**` | 自动跑 `Deploy cloud-mail (custom)` → 完成后自动联动 `Deploy Webhook Relay` |
| 改动 `.github/webhook-relay/**` | 自动只跑 `Deploy Webhook Relay` |
| 只改 workflow 文件 | **不会自动触发**（push 的 `paths` 不含 workflows），需手动 Run workflow |
| 手动全量部署 | Actions → `🚀 Deploy cloud-mail (custom)` → Run workflow |

---

## 4. 必填 GitHub Secrets

仓库 `Settings → Secrets and variables → Actions`：

| Secret | 必填 | 用途 |
|---|---|---|
| `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` | ✅ | 两个 Worker 部署共用 |
| `FEISHU_WEBHOOK` | ✅ | 飞书机器人 Hook URL，注入中继 Worker（**禁止写入代码**） |
| `WEBHOOK_SECRET` | ✅ 已启用 | 与 Cloud Mail webhook 设置第二个输入框**必须为同一值**；中继校验 `Authorization` 头，不匹配返回 401（见 §5.1 安全模型） |
| 其余（`CUSTOM_DOMAIN`/`DOMAIN`/`ADMIN`/`JWT_SECRET`/`KV_NAMESPACE_ID`/`D1_DATABASE_ID`/`R2_BUCKET_NAME`/`PROJECT_LINK`/`AI_MODEL` 等） | 按需 | 见上游 `deploy-cloudflare.yml` env 段 |

---

## 5. Webhook 中继原理（Cloud Mail → 飞书）

### 为什么必须中转

- Cloud Mail 的 webhook 发送**固定结构 JSON**（`emailId/sendEmail/sendName/toEmail/toName/subject/text/content/code/createTime`），顶层无 `msg_type`；
- 飞书自定义机器人要求 `{"msg_type":"text","content":{"text":"..."}}`，直接对接必然返回 `code: 9499`；
- Cloud Mail 设置弹窗第二个输入框是 **Secret**（作为 `Authorization` 头发送），不是消息模板。

### 中继行为

1. 接收 POST → **鉴权**（`WEBHOOK_SECRET` 与 `Authorization` 头比对，不匹配返回 401）→ 解析 JSON；
2. 提取字段拼装飞书文本（发件人 / 主题 / 验证码 / 时间 / 内容前 200 字）；
3. 转发飞书机器人；**解析返回体**：飞书错误时 HTTP 200 + `code != 0`，中继改回 502，
   让 Cloud Mail 的 `webhookRetry`（0~5 次）生效，避免误判"推送成功"。

### 配置步骤

> ⚠️ 已启用 `WEBHOOK_SECRET` 鉴权（PUBLIC 仓库下 relay URL 对全网可见，必须开鉴权）。

1. 生成密钥并**同步填到两处（必须同一值）**：
   - Cloud Mail 后台 → webhook 设置 → **第二个输入框（Secret）**，填 `openssl rand -hex 32` 生成的值；
   - GitHub → `Settings → Secrets → Actions` → 新增 **`WEBHOOK_SECRET`** 为同一值
     （或 `gh secret set WEBHOOK_SECRET --repo RolinShmily/cloud-mail`，交互式输入不回显）；
2. 触发一次部署，从日志取中继地址 `https://webhook-relay.<subdomain>.workers.dev`，填入**第一个输入框（URL）**；
3. 发测试邮件验证。

**成对约束**（两个输入框同存同空，否则行为异常）：

| Cloud Mail ②号框 | GitHub `WEBHOOK_SECRET` | 结果 |
|---|---|---|
| 填 X | 填 X | ✅ 正常鉴权 |
| 留空 | 留空 | ⚠️ 开放（等同无鉴权） |
| 留空 | 填 X | ❌ 所有推送全 401，webhook 永远失败 |
| 填 X | 留空 | ⚠️ 中继不校验，等同开放 |

**验证**：

```bash
# 反向：不带/错带 Authorization 头应返回 401
curl -i -X POST "https://webhook-relay.<子域>.workers.dev" \
  -H "Content-Type: application/json" \
  -d '{"msg_type":"text","content":{"text":"test"}}'
# 预期：HTTP/1.1 401 Unauthorized
```

### 5.1 安全模型

- 仓库为 **PUBLIC**：relay URL（`::notice::` 打印在 Actions 日志）对全网可见，**任何人可向无鉴权端点 POST**；
- 鉴权边界：`WEBHOOK_SECRET` 保护的是 **攻击者 → relay** 这一段；飞书 hook 存在 relay 的 env 中，密钥不经过攻击者之手，
  攻击者直接调用飞书 hook 才需要密钥——**不要误以为"不知道飞书密钥就用不了"，未开鉴权时通过 relay 刷屏不需要任何密钥**；
- 已启用 `WEBHOOK_SECRET`（配置即可，零代码改动，中继代码内置支持）；
- **已评估未采用**：飞书机器人「加签」模式（需要中继按 HMAC-SHA256 计算 `timestamp`/`sign` 字段，约 15 行代码）。
  当时结论：`WEBHOOK_SECRET` 已挡住未经授权的调用，加签主要防 "FEISHU_WEBHOOK 本身泄露"，暂不必要；如日后需要再补。

---

## 6. 上游同步流程（零冲突维护）

```bash
git fetch upstream
git merge --ff-only upstream/main   # 本地 main 直接快进
git push origin main                # 推送本仓库
```

- 自定义文件（`.github/webhook-relay/`、`deploy-cloudflare-custom.yml`、`deploy-lark-hook.yml`、本文档）上游不存在 → 永不冲突；
- 唯一可能冲突的是 `deploy-cloudflare.yml` 上的 1 行守卫 `if: github.repository == 'maillab/cloud-mail'`，属机械性小冲突，保留该行即可；
- 上游 force-push 时 `--ff-only` 会失败，需 `git reset --hard upstream/main`（先确认无本地独有提交未备份）。

---

## 7. 历史问题与既有修复（供排障参考）

| 现象 | 根因 | 修复位置 |
|---|---|---|
| Cloudflare `100113 hostname invalid` | `CUSTOM_DOMAIN` 首尾带空白/协议头 | `deploy-cloudflare-custom.yml` 环境设置步：sed 清洗后写入 `GITHUB_ENV` |
| Cloudflare `100117 DNS 记录已存在` | 自定义域名 DNS 已存在于账户 | 部署失败时 grep 日志，命中则降级警告不标红；`100113` 仍显式失败 |
| 数据库初始化失败 | 自定义域名 DNS 未生效 / 单 URL 无重试 | 多候选 URL 降级（自定义域名 → workers.dev）+ 每地址重试 3 次 |

---

## 8. 常见排障

- **部署红但日志有 `Uploaded cloud-mail`**：多半命中 100117 容错分支或新错误码，检查 `CUSTOM_DOMAIN` 格式与小字 warning。
- **relay 部署报 `FEISHU_WEBHOOK 未配置`**：GitHub Secret 未添加，添加后重跑。
- **推送全 401**：`WEBHOOK_SECRET` 已配但 Cloud Mail ②号框留空（或值不一致），见 §5 成对约束表。
- **飞书收不到消息但部署全绿**：先 GET 中继地址确认存活（`curl https://<relay>.<子域>.workers.dev` 应返回 `webhook-relay ok`）；
  再手动 `curl -X POST` 带 `Authorization: <你的密钥>` 和 fake payload 测中继；看 Cloud Mail 后台是否有 webhook 错误日志（会打印中继返回的 5xx 原因）。
- **workers.dev 不可用**：账号未启用 workers.dev subdomain 时中继部署会告警，需为中继配置自定义路由（暂未内置，需要时按需加）。