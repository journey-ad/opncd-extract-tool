// ============================================================
//  parser.js - opncd.ai 分享页解析器（工具自包含副本）
//  与 reference/opncd-restore-parser.js 同源。
// ============================================================

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

function extractSession(html) {
  const session = {};
  const dirM = html.match(/directory:"([^"]*)"/);
  if (dirM) session.directory = dirM[1].replace(/\\\\/g, "\\");
  const titleM = html.match(/title:"([^"]*)"/);
  if (titleM) session.title = titleM[1];
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
    }
  }
  return operations;
}

function applyOperations(operations) {
  const files = {};
  const errors = [];
  for (let i = 0; i < operations.length; i++) {
    const op = operations[i];
    // 原始会话失败的操作跳过重放，错误信息通过 opList 标注
    if (op.status === "error") continue;
    if (op.op === "write") {
      files[op.filePath] = op.content;
    } else if (op.op === "replace") {
      if (!files[op.filePath]) { errors.push({ op, idx: i + 1, reason: "文件不存在" }); continue; }
      const cur = files[op.filePath];
      const idx = cur.indexOf(op.oldString);
      if (idx === -1) { errors.push({ op, idx: i + 1, reason: "oldString 未找到" }); continue; }
      if (!op.replaceAll && cur.indexOf(op.oldString, idx + 1) !== -1) {
        errors.push({ op, idx: i + 1, reason: "oldString 不唯一" }); continue;
      }
      if (op.replaceAll) {
        files[op.filePath] = cur.split(op.oldString).join(op.newString);
      } else {
        files[op.filePath] = cur.slice(0, idx) + op.newString + cur.slice(idx + op.oldString.length);
      }
    }
  }
  return { files, errors };
}

function normalizePath(p) {
  return p.replace(/\\\\/g, "\\").replace(/\\/g, "/");
}

// 生成相对路径转换函数：绝对路径 -> 相对 session.directory 的路径。
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

  // 操作摘要（不含 content/oldString/newString 全文，只含长度）
  const opList = operations.map((op, idx) => {
    const path = toRel(op.filePath);
    const base = { idx: idx + 1, path, status: op.status || "success", error: op.error || null };
    if (op.op === "write") return { ...base, op: "write", size: op.content.length };
    return { ...base, op: "replace", oldLen: op.oldString.length, newLen: op.newString.length, replaceAll: !!op.replaceAll };
  });

  return {
    directory: session.directory || null,
    title: session.title || null,
    files: fileList,
    operations: opList,
    errors,
    stats: {
      operations: operations.length,
      writes: operations.filter((o) => o.op === "write").length,
      replaces: operations.filter((o) => o.op === "replace").length,
      fileCount: fileList.length,
      errorCount: operations.filter((o) => o.status === "error").length,
    },
  };
}
