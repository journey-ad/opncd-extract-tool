// ============================================================
//  server.js - opncd-restore-tool HTTP 服务器（Express）
//  路由:
//    GET  /                  WebUI（静态文件）
//    POST /api/parse         body:{url} -> {jobId, files, stats, ...}
//    GET  /api/download/:jobId  -> zip 文件
// ============================================================

import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import JSZip from "jszip";
import { parseShareHtml } from "./parser.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// 内存缓存解析结果，30 分钟过期
const jobs = new Map();
const JOB_TTL = 30 * 60 * 1000;

const genId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
function cleanupJobs() {
  const cutoff = Date.now() - JOB_TTL;
  for (const [k, v] of jobs) if (v.ts < cutoff) jobs.delete(k);
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
    jobs.set(jobId, {
      files: result.files,
      directory: result.directory,
      title: result.title,
      ts: Date.now(),
    });
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
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: "任务不存在或已过期，请重新解析" });
  try {
    const zip = new JSZip();
    for (const f of job.files) zip.file(f.path, f.content, { createFolders: false });
    const buf = await zip.generateAsync({
      type: "nodebuffer",
      compression: "DEFLATE",
      compressionOptions: { level: 6 },
    });
    // RFC 5987/6266：非 ASCII 文件名用 filename*=UTF-8'' 编码，filename="..." 作 ASCII fallback。
    const utf8Name = (job.title || "opncd-restore").slice(0, 50) + ".zip";
    res.set("Content-Type", "application/zip");
    res.set("Content-Disposition", `attachment; filename="restore.zip"; filename*=UTF-8''${encodeURIComponent(utf8Name)}`);
    res.send(buf);
  } catch (e) {
    res.status(500).json({ error: "打包失败: " + e.message });
  }
});

app.listen(PORT, () => {
  console.log(`opncd-restore-tool -> http://localhost:${PORT}`);
});
