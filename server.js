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
//    meta.json    元数据 + 完整响应（缓存命中时直接复用）
// ============================================================

import express from "express";
import path from "node:path";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import JSZip from "jszip";
import { createPatch } from "diff";
import { parseShareHtml, parseOperations } from "./parser.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
const RUNTIME_DIR = path.join(__dirname, "runtime");
const JOB_TTL = 30 * 60 * 1000;

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const genId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

function extractShareId(url) {
  try {
    const m = new URL(url).pathname.match(/^\/share\/([A-Za-z0-9_-]+)$/);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

function ts(d = new Date()) {
  const pad = (n, w = 2) => String(n).padStart(w, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

function fmtVal(v) {
  const s = String(v);
  return /\s/.test(s) ? `"${s}"` : s;
}

function log(jobId, level, msg, fields = {}) {
  const pairs = Object.entries(fields)
    .map(([k, v]) => `${k}=${fmtVal(v)}`)
    .join("  ");
  console.log(`${ts()}  ${level.padEnd(5)} [${jobId}] ${msg}  ${pairs}`);
}

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

  const shareId = extractShareId(url);
  const jobId = shareId || genId();
  const startedAt = Date.now();

  // 缓存命中检查
  if (shareId) {
    const cached = await readMeta(jobId);
    if (cached) {
      log(jobId, "INFO", "parse start", { url, cached: true });
      // 更新目录 mtime，避免被 cleanup 清掉
      try {
        const now = new Date();
        await fs.utimes(jobDir(jobId), now, now);
      } catch {}
      const elapsed = Date.now() - startedAt;
      log(jobId, "INFO", "parse done (cache hit)", {
        title: cached.title || "",
        files: cached.files.length,
        ops: cached.stats.operations,
        errors: cached.stats.errorCount,
        elapsed: elapsed + "ms",
      });
      return res.json({
        jobId: cached.jobId,
        directory: cached.directory,
        title: cached.title,
        stats: cached.stats,
        operations: cached.operations,
        errors: cached.errors,
        files: cached.files,
      });
    }
  }

  log(jobId, "INFO", "parse start", { url, cached: false });

  try {
    const html = await fetchShareHtml(url);
    const result = parseShareHtml(html);

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

    // 3. 落盘元数据（含完整响应字段，供缓存命中直接返回）
    const response = {
      jobId,
      directory: result.directory,
      title: result.title,
      stats: result.stats,
      operations: result.operations,
      errors: result.errors.map((e) => ({ idx: e.idx, filePath: e.op.filePath, reason: e.reason })),
      files: result.files.map((f) => ({ path: f.path, size: f.size })),
    };
    const meta = {
      ...response,
      shareUrl: url,
      createdAt: Date.now(),
    };
    await fs.writeFile(path.join(dir, "meta.json"), JSON.stringify(meta), "utf8");

    cleanupJobs();

    const elapsed = Date.now() - startedAt;
    log(jobId, "INFO", "parse done", {
      title: result.title || "",
      files: result.files.length,
      ops: result.stats.operations,
      errors: result.stats.errorCount,
      elapsed: elapsed + "ms",
    });

    res.json(response);
  } catch (e) {
    const elapsed = Date.now() - startedAt;
    log(jobId, "ERROR", "parse failed", { elapsed: elapsed + "ms", error: e.message });
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/download/:jobId", async (req, res) => {
  const { jobId } = req.params;
  if (!/^[A-Za-z0-9_-]+$/.test(jobId)) return res.status(400).json({ error: "非法 jobId" });

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

app.get("/api/ops/:jobId", async (req, res) => {
  const { jobId } = req.params;
  if (!/^[A-Za-z0-9_-]+$/.test(jobId)) return res.status(400).json({ error: "非法 jobId" });
  const sharePath = path.join(jobDir(jobId), "share.html");
  if (!existsSync(sharePath)) return res.status(404).json({ error: "分享页不存在或已过期" });
  try {
    const html = await fs.readFile(sharePath, "utf8");
    const operations = parseOperations(html);
    res.json(operations.map((op, i) => {
      let diff = op.diff;
      if (!diff) {
        if ((op.op === "write" || op.op === "read") && op.content) {
          diff = createPatch(op.filePath, "", op.content, "", "");
        } else if (op.op === "replace" && op.oldString !== null && op.newString !== null) {
          diff = createPatch(op.filePath, op.oldString, op.newString, "", "");
        }
      }
      return {
        idx: i + 1,
        op: op.op,
        path: op.filePath,
        status: op.status || "success",
        error: op.error || null,
        replaceAll: !!op.replaceAll,
        diff: diff || null,
      };
    }));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

ensureRuntimeDir().then(() => {
  cleanupJobs();
  app.listen(PORT, () => {
    console.log(`opncd-restore-tool -> http://localhost:${PORT}`);
    console.log(`runtime dir -> ${RUNTIME_DIR}`);
  });
});
