// ============================================================
//  parser.js - opncd.ai 分享页解析器（工具自包含副本）
//  与 reference/opncd-restore-parser.js 同源。
// ============================================================

import { applyPatch } from "diff";

function findStates(str) {
  const results = [];
  const re = /state:\$R\[\d+\]=\{|state:\{/g;
  let m;
  while ((m = re.exec(str)) !== null) {
    const start = m.index + m[0].length;
    let depth = 1;
    let i = start;
    let inStr = false, strCh = "", escape = false;
    while (i < str.length && depth > 0) {
      const c = str[i];
      if (escape) { escape = false; i++; continue; }
      if (inStr) {
        if (c === "\\") { escape = true; i++; continue; }
        if (c === strCh) inStr = false;
        i++; continue;
      }
      if (c === '"' || c === "'") { inStr = true; strCh = c; i++; continue; }
      if (c === "{") depth++;
      else if (c === "}") depth--;
      i++;
    }
    results.push({ text: str.slice(m.index, i), pos: m.index });
  }
  return results;
}

function extractField(objText, field) {
  const re = new RegExp(field + ':"((?:[^"\\\\]|\\\\.)*)"');
  const m = objText.match(re);
  if (!m) return null;
  try { return eval('"' + m[1] + '"'); } catch (e) { return null; }
}

function extractBool(objText, field) {
  const re = new RegExp(field + ":(true|false)");
  const m = objText.match(re);
  return m ? m[1] === "true" : false;
}

// 从 read 工具的 output XML 中提取文件内容（去掉行号前缀）。
// 完整读取（从第1行到文件尾）：返回 { content }。
// 部分读取：返回 { content, startLine, endLine }，仅覆盖对应行范围。
// 非 read 输出或无 <content>：返回 null。
function extractContentFromReadOutput(rawStateText) {
  const output = extractField(rawStateText, "output");
  if (!output) return null;
  const ctStart = output.indexOf("<content>");
  if (ctStart === -1) return null;
  const ctEnd = output.indexOf("</content>", ctStart);
  if (ctEnd === -1) return null;

  const rawLines = output.slice(ctStart + 9, ctEnd).split("\n");

  // 先解析尾行标记（标记可能在最后一行或倒数第二行，取决于尾随空行）
  let partialStart = null, partialEnd = null, totalLines = null;
  for (let j = rawLines.length - 1; j >= 0; j--) {
    const showM = rawLines[j].match(/\(Showing lines (\d+)-(\d+) of (\d+)/);
    if (showM) {
      partialStart = parseInt(showM[1]);
      partialEnd = parseInt(showM[2]);
      break;
    }
    const endM = rawLines[j].match(/\(End of file - total (\d+) lines\)/);
    if (endM) {
      totalLines = parseInt(endM[1]);
      break;
    }
  }

  // 去掉尾部的空行和标记行
  while (rawLines.length && (rawLines[rawLines.length - 1] === "" || rawLines[rawLines.length - 1].startsWith("("))) {
    rawLines.pop();
  }
  while (rawLines.length && rawLines[0] === "") {
    rawLines.shift();
  }
  if (rawLines.length === 0) return null;

  // 去掉行号前缀得到纯文件内容
  const content = rawLines.map((l) => l.replace(/^\d+: /, "")).join("\n");

  // 部分读取：有 (Showing lines) 标记，或首行不是第1行
  if (partialStart !== null) {
    return { content, startLine: partialStart, endLine: partialEnd };
  }
  if (rawLines[0] && !rawLines[0].startsWith("1: ")) {
    const firstNumM = rawLines[0].match(/^(\d+): /);
    const start = firstNumM ? parseInt(firstNumM[1]) : 1;
    return { content, startLine: start, endLine: totalLines || (start + rawLines.length - 1) };
  }

  // 完整读取（从第1行开始）
  return { content };
}

function extractSession(html) {
  const session = {};
  const dirM = html.match(/directory:"([^"]*)"/);
  if (dirM) session.directory = dirM[1].replace(/\\\\/g, "\\");
  const titleM = html.match(/title:"([^"]*)"/);
  if (titleM) session.title = titleM[1];

  // 会话元数据（token、model 等，仅 opncd.ai 分享页有）
  // 多个 script 标签中都有 ($R[，需要找到包含 sessionID 的那个
  let script = "";
  let pos = 0;
  while ((pos = html.indexOf("($R[", pos)) !== -1) {
    const end = html.indexOf("</script>", pos);
    const s = html.substring(pos, end > 0 ? end : pos + 100000);
    if (s.includes("sessionID:") || s.includes('session:"') || s.includes("session:$R")) {
      script = s;
      break;
    }
    pos += 1;
  }
  if (!script) return session;

  session.modelID = (script.match(/modelID:"([^"]+)"/) || [])[1] || null;
  session.providerID = (script.match(/providerID:"([^"]+)"/) || [])[1] || null;

  // 汇总 token 用量
  const tokenRe = /tokens:\$R\[\d+\]=\{total:(\d+),input:(\d+),output:(\d+),reasoning:(\d+),cache:\$R\[\d+\]=\{read:(\d+),write:(\d+)\}\}/g;
  let tm, total = 0, input = 0, output = 0, reasoning = 0, cacheRead = 0, chunks = 0;
  while ((tm = tokenRe.exec(script)) !== null) {
    total += parseInt(tm[1]);
    input += parseInt(tm[2]);
    output += parseInt(tm[3]);
    reasoning += parseInt(tm[4]);
    cacheRead += parseInt(tm[5]);
    chunks++;
  }
  if (chunks > 0) {
    session.tokens = { total, input, output, reasoning, cacheRead, chunks };
  }

  // 时间
  const timeM = script.match(/time:\$R\[\d+\]=\{created:(\d+),updated:(\d+)\}/);
  if (timeM) {
    session.timeCreated = parseInt(timeM[1]);
    session.timeUpdated = parseInt(timeM[2]);
  }

  // 请求数
  const assistantCount = (script.match(/role:"assistant"/g) || []).length;
  if (assistantCount > 0) session.requests = assistantCount;

  return session;
}

export function parseOperations(html) {
  const states = findStates(html);
  const operations = [];
  for (const s of states) {
    const filePath = extractField(s.text, "filePath");
    if (!filePath) continue;
    const content = extractField(s.text, "content");
    const oldString = extractField(s.text, "oldString");
    const newString = extractField(s.text, "newString");
    const replaceAll = extractBool(s.text, "replaceAll");
    const status = extractField(s.text, "status");
    const error = extractField(s.text, "error");
    const diff = extractField(s.text, "diff");
    if (content !== null) {
      operations.push({ pos: s.pos, filePath, op: "write", content, status, error, diff });
    } else if (oldString !== null && newString !== null) {
      operations.push({ pos: s.pos, filePath, op: "replace", oldString, newString, replaceAll, status, error, diff });
    } else {
      // read 工具的 output 中可能包含完整或部分文件内容
      const snap = extractContentFromReadOutput(s.text);
      if (snap !== null) {
        operations.push({
          pos: s.pos, filePath, op: "read",
          content: snap.content,
          startLine: snap.startLine || null,
          endLine: snap.endLine || null,
          status, error,
        });
      }
    }
  }
  return operations;
}

function applyOperations(operations) {
  const files = {};
  const errors = [];
  for (let i = 0; i < operations.length; i++) {
    const op = operations[i];
    if (op.status === "error") continue;
    if (op.op === "write") {
      files[op.filePath] = op.content;
    } else if (op.op === "read") {
      if (op.startLine != null && files[op.filePath]) {
        // 部分读取：仅替换对应行范围
        const curLines = files[op.filePath].split("\n");
        const newLines = op.content.split("\n");
        const start = op.startLine - 1;
        const count = op.endLine - op.startLine + 1;
        curLines.splice(start, count, ...newLines);
        files[op.filePath] = curLines.join("\n");
      } else {
        // 完整读取或无现有文件：直接覆盖
        files[op.filePath] = op.content;
      }
    } else if (op.op === "replace") {
      if (!files[op.filePath]) { errors.push({ op, idx: i + 1, reason: "文件不存在" }); continue; }
      const cur = files[op.filePath];
      let applied = false;
      if (op.diff) {
        try {
          const result = applyPatch(cur, op.diff, { fuzzFactor: 2 });
          if (result !== false) {
            files[op.filePath] = result;
            applied = true;
          }
        } catch {}
      }
      if (!applied) {
        const idx = cur.indexOf(op.oldString);
        if (idx !== -1 && (op.replaceAll || cur.indexOf(op.oldString, idx + 1) === -1)) {
          if (op.replaceAll) {
            files[op.filePath] = cur.split(op.oldString).join(op.newString);
          } else {
            files[op.filePath] = cur.slice(0, idx) + op.newString + cur.slice(idx + op.oldString.length);
          }
          applied = true;
        }
      }
      if (!applied) {
        errors.push({ op, idx: i + 1, reason: "oldString 未找到" });
      }
    }
  }
  return { files, errors };
}

function normalizePath(p) {
  return p.replace(/\\\\/g, "\\").replace(/\\/g, "/");
}

function makeToRelPath(directory) {
  const root = directory ? normalizePath(directory) : null;
  return (absPath) => {
    const norm = normalizePath(absPath);
    if (root && norm.startsWith(root + "/")) return norm.slice(root.length + 1);
    if (root && norm.startsWith(root)) return norm.slice(root.length);
    return "_extra/" + norm.replace(/^([A-Za-z]:\/)/, "").replace(/^\//, "");
  };
}

export function parseShareHtml(html) {
  const session = extractSession(html);
  const operations = parseOperations(html);
  const { files, errors } = applyOperations(operations);

  const toRel = makeToRelPath(session.directory);

  const fileList = [];
  for (const [absPath, content] of Object.entries(files)) {
    fileList.push({ path: toRel(absPath), size: content.length, content });
  }
  fileList.sort((a, b) => a.path.localeCompare(b.path));

  const opList = operations.map((op, idx) => {
    const path = toRel(op.filePath);
    const base = { idx: idx + 1, path, status: op.status || "success", error: op.error || null };
    if (op.op === "write") return { ...base, op: "write", size: op.content.length };
    if (op.op === "read") return { ...base, op: "read", size: op.content.length };
    return { ...base, op: "replace", oldLen: op.oldString.length, newLen: op.newString.length, replaceAll: !!op.replaceAll };
  });

  return {
    session: {
      directory: session.directory || null,
      title: session.title || null,
      modelID: session.modelID || null,
      providerID: session.providerID || null,
      tokens: session.tokens || null,
      timeCreated: session.timeCreated || null,
      timeUpdated: session.timeUpdated || null,
      requests: session.requests || null,
    },
    files: fileList,
    operations: opList,
    errors,
    stats: {
      operations: operations.length,
      writes: operations.filter((o) => o.op === "write").length,
      replaces: operations.filter((o) => o.op === "replace").length,
      reads: operations.filter((o) => o.op === "read").length,
      fileCount: fileList.length,
      errorCount: operations.filter((o) => o.status === "error").length,
    },
  };
}
