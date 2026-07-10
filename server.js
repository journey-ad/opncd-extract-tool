// ============================================================
//  server.js - opncd-restore-tool HTTP 服务器（Express）
//  路由:
//    GET  /                  WebUI（静态文件）
//    POST /api/parse         body:{url} -> {jobId, files, stats, ...}
//    GET  /api/download/:jobId  -> zip 文件
//
//  持久化方案：每个 jobId 在 runtime/<jobId>/ 下落盘
//    share.html   原始分享页 HTML
//    result.zip   解析打包后的 zip
//    meta.json    元数据（title / directory / 创建时间）
// ============================================================

import express from "express";
import path from "node:path";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import JSZip from "jszip";
import { parseShareHtml } from "./parser.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
const RUNTIME_DIR = path.join(__dirname, "runtime");
const JOB_TTL = 30 * 60 * 1000;

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const genId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

async function ensureRuntimeDir() {
  await fs.mkdir(RUNTIME_DIR, { recursive: true });
}

function jobDir(jobId) {
  return path.join(RUNTIME_DIR, jobId);
}

async function readMeta(jobId) {
  try {
    const raw = await fs.readFile(path.join(jobDir(jobId), "meta.json"), "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function cleanupJobs() {
  const cutoff = Date.now() - JOB_TTL;
  let entries;
  try {
    entries = await fs.readdir(RUNTIME_DIR, { withFileTypes: true });
  } catch {
    return;
  }
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    const dir = path.join(RUNTIME_DIR, ent.name);
    try {
      const st = await fs.stat(dir);
      if (st.mtimeMs < cutoff) await fs.rm(dir, { recursive: true, force: true });
    } catch {
      // 单个目录失败不影响其他清理
    }
  }
}

async function fetchShareHtml(url) {
  const r = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 opncd-restore-tool" },
    redirect: "follow",
  });
  if (!r.ok) throw new Error(`下载失败: HTTP ${r.status}`);
  return await r.text();
}

app.post("/api/parse", async (req, res) => {
  const { url } = req.body || {};
  if (!url || typeof url !== "string") return res.status(400).json({ error: "缺少 url 字段" });
  try {
    const html = await fetchShareHtml(url);
    const result = parseShareHtml(html);

    const jobId = genId();
    const dir = jobDir(jobId);
    await fs.mkdir(dir, { recursive: true });

    // 1. 落盘原始 share html
    await fs.writeFile(path.join(dir, "share.html"), html, "utf8");

    // 2. 生成并落盘 zip
    const zip = new JSZip();
    for (const f of result.files) zip.file(f.path, f.content, { createFolders: false });
    const buf = await zip.generateAsync({
      type: "nodebuffer",
      compression: "DEFLATE",
      compressionOptions: { level: 6 },
    });
    await fs.writeFile(path.join(dir, "result.zip"), buf);

    // 3. 落盘元数据
    const meta = {
      jobId,
      title: result.title,
      directory: result.directory,
      createdAt: Date.now(),
    };
    await fs.writeFile(path.join(dir, "meta.json"), JSON.stringify(meta), "utf8");

    cleanupJobs();

    res.json({
      jobId,
      directory: result.directory,
      title: result.title,
      stats: result.stats,
      operations: result.operations,
      errors: result.errors.map((e) => ({ filePath: e.op.filePath, reason: e.reason })),
      files: result.files.map((f) => ({ path: f.path, size: f.size })),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/download/:jobId", async (req, res) => {
  const { jobId } = req.params;
  if (!/^[a-z0-9-]+$/i.test(jobId)) return res.status(400).json({ error: "非法 jobId" });

  const zipPath = path.join(jobDir(jobId), "result.zip");
  if (!existsSync(zipPath)) return res.status(404).json({ error: "任务不存在或已过期，请重新解析" });

  const meta = await readMeta(jobId);
  const utf8Name = ((meta && meta.title) || "opncd-restore").slice(0, 50) + ".zip";
  res.set("Content-Type", "application/zip");
  // RFC 5987/6266：非 ASCII 文件名用 filename*=UTF-8'' 编码，filename="..." 作 ASCII fallback。
  res.set("Content-Disposition", `attachment; filename="restore.zip"; filename*=UTF-8''${encodeURIComponent(utf8Name)}`);

  try {
    const stream = (await import("node:fs")).createReadStream(zipPath);
    stream.on("error", (e) => {
      if (!res.headersSent) res.status(500).json({ error: "读取失败: " + e.message });
    });
    stream.pipe(res);
  } catch (e) {
    res.status(500).json({ error: "打包失败: " + e.message });
  }
});

ensureRuntimeDir().then(() => {
  cleanupJobs();
  app.listen(PORT, () => {
    console.log(`opncd-restore-tool -> http://localhost:${PORT}`);
    console.log(`runtime dir -> ${RUNTIME_DIR}`);
  });
});
