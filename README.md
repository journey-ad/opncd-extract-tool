<p align="center"><img src="https://count.getloli.com/@opncd-extract-tool?theme=3d-num&padding=7&offset=0&align=top&scale=1&pixelated=1&darkmode=auto" alt="visitor count"></p>

opncd.ai 分享页还原工具。下载 OpenCode 分享页 HTML，解析其中的文件操作序列，重建文件树并打包为 ZIP。

## 功能

- 输入 opncd.ai 分享链接，下载并解析分享页
- 还原 write / replace / read 三类文件操作，重建最终文件树
- 打包为 ZIP 下载（保留原始相对路径）
- 展示会话元数据：标题、目录、模型、agent、token 用量、缓存命中、时间、版本
- 操作日志面板，支持单步 diff 查看
- 文件预览：语法高亮、Markdown 渲染、源码/渲染视图切换
- 基于 share ID 的磁盘缓存，TTL 可配置（默认 30 分钟，-1 永久缓存）

## 技术栈

- Node.js (ESM) + Express
- JSZip 打包，diff 库应用 patch
- 前端：Vue 3 + Tailwind CSS（CDN 引入），highlight.js 语法高亮，marked 渲染 Markdown

## 快速开始

本地运行需 Node.js 22+。

```bash
pnpm install
pnpm start
# 服务启动在 http://localhost:3000
```

打开浏览器访问 `http://localhost:3000`，粘贴 opncd.ai 分享链接即可。

## 部署

### Docker

镜像发布在 ghcr.io，直接拉取运行即可。

```bash
docker pull ghcr.io/journey-ad/opncd-extract-tool:latest
docker run -d -p 3000:3000 \
  -v /path/to/runtime:/app/runtime \
  --name opncd-extract \
  ghcr.io/journey-ad/opncd-extract-tool:latest
```

挂载 runtime 卷用于持久化解析缓存，可选。不挂载时功能正常，仅容器重启后缓存丢失。

### 环境变量

| 变量         | 默认值 | 说明                                                                 |
| ------------ | ------ | -------------------------------------------------------------------- |
| `PORT`       | 3000   | HTTP 监听端口                                                       |
| `CACHE_TTL`  | 1800   | 缓存保留秒数。-1=永久缓存，正数=TTL 秒（最少 300，低于 300 按 300） |

## API 参考

### POST /api/parse

解析分享页。

请求体：

```json
{ "url": "https://opncd.ai/share/<shareId>" }
```

响应：

```json
{
  "jobId": "<shareId>",
  "session": {
    "title": "...",
    "directory": "...",
    "modelID": "...",
    "providerID": "...",
    "family": "...",
    "variant": "...",
    "agent": "...",
    "reasoningEffort": "...",
    "context": 1000000,
    "version": "...",
    "releaseDate": "...",
    "tokens": { "total": 0, "input": 0, "output": 0, "reasoning": 0, "cacheRead": 0, "chunks": 0 },
    "timeCreated": 0,
    "timeUpdated": 0,
    "requests": 0
  },
  "stats": { "operations": 0, "writes": 0, "replaces": 0, "reads": 0, "fileCount": 0, "errorCount": 0 },
  "operations": [...],
  "errors": [...],
  "files": [{ "path": "...", "size": 0 }]
}
```

同一 shareId 的第二次请求命中缓存，直接返回上次结果。

### GET /api/download/:jobId

下载重建后的 ZIP。文件名取自会话标题。

### GET /api/ops/:jobId

获取操作详情列表，每条操作含 diff（统一 diff 格式），用于前端逐操作对比。

## 工作原理

1. 下载 opncd.ai 分享页 HTML
2. 从 React 序列化的 state 块中提取文件操作（write / replace / read）
3. 按顺序应用操作：write 直接写入，read 覆盖或按行范围合并，replace 优先用 diff patch 回退到 oldString 替换
4. 将重建后的文件树打包为 ZIP
5. 从 session script 提取元数据（模型、token、时间等）

read 操作的特殊处理：当 read 是部分读取（带行范围标记）且目标文件已存在，仅替换对应行范围，保留其余内容。

## 项目结构

```
.
├── server.js              Express 服务器，路由与磁盘缓存
├── parser.js              HTML 解析器，操作提取与应用
├── public/
│   └── index.html         Vue 3 单文件前端
├── Dockerfile
├── .github/workflows/
│   └── docker.yml         镜像构建 CI
└── runtime/               运行时缓存（gitignore）
```

## 限制

- 仅支持 opncd.ai 分享页，不通用与其他 AI 会话分享
- replace 操作依赖 oldString 唯一匹配或 diff patch，极端情况下可能应用失败
- 运行时缓存为惰性清理（服务启动和解析完成时触发），非定时清理；容器重启未挂载 runtime 卷时缓存丢失
