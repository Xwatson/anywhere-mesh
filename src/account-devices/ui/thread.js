export function element(tag, text, className) {
  const result = document.createElement(tag);
  if (text !== undefined) result.textContent = text;
  if (className) result.className = className;
  return result;
}

export function icon(name) {
  const ns = 'http://www.w3.org/2000/svg';
  const graphic = document.createElementNS(ns, 'svg');
  graphic.setAttribute('class', 'icon');
  graphic.setAttribute('aria-hidden', 'true');
  const shape = document.createElementNS(ns, 'use');
  shape.setAttribute('href', '#i-' + name);
  graphic.append(shape);
  return graphic;
}

// Construct text nodes even when model output or a file contains HTML.
const ALERT_LABELS = { NOTE: '说明', TIP: '提示', IMPORTANT: '重要', WARNING: '注意', CAUTION: '警告' };

function parseFileUrl(rawUrl) {
  try {
    const u = new URL(rawUrl);
    if (u.protocol !== 'file:') return null;
    let path = decodeURIComponent(u.pathname || '');
    if (/^\/[A-Za-z]:\//.test(path)) path = path.slice(1);
    const hashMatch = (u.hash || '').match(/^#L(\d+)(?:-L?(\d+))?$/i);
    const lineRange = hashMatch ? (hashMatch[2] ? `${hashMatch[1]}-${hashMatch[2]}` : hashMatch[1]) : '';
    return { path: path || rawUrl, lineRange };
  } catch {
    return null;
  }
}

function makeFileChip(label, copyPath, lineRange = '', rawUrl = '') {
  const btn = element('button', undefined, 'md-file');
  btn.type = 'button';
  btn.dataset.copyText = copyPath;
  if (rawUrl && rawUrl !== copyPath) btn.dataset.rawUrl = rawUrl;
  if (lineRange) btn.dataset.lineRange = lineRange;
  const showRange = lineRange && !label.includes(lineRange) && !/#L\d+/i.test(label);
  btn.append(icon('file'), element('span', label));
  if (showRange) btn.append(element('small', ':' + lineRange));
  return btn;
}

function unwrapCodeLabel(rawLabel) {
  const trimmed = rawLabel.trim();
  if (trimmed.length >= 2 && trimmed.startsWith('`') && trimmed.endsWith('`') && !trimmed.slice(1, -1).includes('`')) {
    return trimmed.slice(1, -1);
  }
  return rawLabel;
}

function findMarkdownLink(text, startIdx) {
  let i = startIdx + 1;
  let inCode = false;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '\n') return null;
    if (ch === '`') inCode = !inCode;
    else if (!inCode && ch === ']') break;
    i++;
  }
  if (i >= text.length || text[i] !== ']' || text[i + 1] !== '(') return null;
  const rawLabel = text.slice(startIdx + 1, i);
  if (!rawLabel.trim()) return null;
  let j = i + 2;
  let depth = 0;
  while (j < text.length) {
    const ch = text[j];
    if (ch === '\n' || (depth === 0 && /\s/.test(ch))) return null;
    if (ch === '(') depth++;
    else if (ch === ')') {
      if (depth === 0) break;
      depth--;
    }
    j++;
  }
  if (j >= text.length || text[j] !== ')') return null;
  const rawTarget = text.slice(i + 2, j).trim();
  if (!rawTarget) return null;
  return { rawLabel, rawTarget, endIdx: j + 1 };
}

function renderLinkNode(rawLabel, rawTarget) {
  const cleanLabel = unwrapCodeLabel(rawLabel);
  if (/^file:\/\//i.test(rawTarget)) {
    const info = parseFileUrl(rawTarget);
    const filePath = info?.path || rawTarget.replace(/^file:\/\//i, '');
    return makeFileChip(cleanLabel, filePath, info?.lineRange || '', rawTarget);
  }
  if (/^https?:\/\//i.test(rawTarget)) {
    try {
      const u = new URL(rawTarget);
      if (u.protocol === 'http:' || u.protocol === 'https:') {
        const a = element('a', undefined, 'md-link');
        a.href = u.href;
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        inline(a, cleanLabel, false);
        return a;
      }
    } catch {}
  }
  if (/^conversation:\/\//i.test(rawTarget) || !/^[a-z][a-z0-9+.-]*:/i.test(rawTarget)) {
    return makeFileChip(cleanLabel, rawTarget, '', rawTarget);
  }
  return document.createTextNode(cleanLabel);
}

function inline(parent, text, allowLinks = true) {
  let cursor = 0;
  let plainStart = 0;
  const flushPlain = end => {
    if (end > plainStart) parent.append(text.slice(plainStart, end));
  };
  while (cursor < text.length) {
    const ch = text[cursor];
    if (ch === '`') {
      const close = text.indexOf('`', cursor + 1);
      if (close > cursor + 1 && !text.slice(cursor + 1, close).includes('\n')) {
        flushPlain(cursor);
        parent.append(element('code', text.slice(cursor + 1, close)));
        cursor = plainStart = close + 1;
        continue;
      }
    }
    if (ch === '*' && text[cursor + 1] === '*') {
      const close = text.indexOf('**', cursor + 2);
      if (close > cursor + 2 && !text.slice(cursor + 2, close).includes('\n')) {
        flushPlain(cursor);
        const strong = element('strong');
        inline(strong, text.slice(cursor + 2, close), allowLinks);
        parent.append(strong);
        cursor = plainStart = close + 2;
        continue;
      }
    }
    if (allowLinks && ch === '[') {
      const link = findMarkdownLink(text, cursor);
      if (link) {
        flushPlain(cursor);
        parent.append(renderLinkNode(link.rawLabel, link.rawTarget));
        cursor = plainStart = link.endIdx;
        continue;
      }
    }
    if (allowLinks && ch === 'f' && text.startsWith('file:///', cursor)) {
      const m = text.slice(cursor).match(/^file:\/\/\/[^\s<>()`"'\]]+/);
      if (m) {
        const rawUrl = m[0].replace(/[.,;:!?。，；：！？]+$/, '');
        const info = parseFileUrl(rawUrl);
        if (info?.path) {
          flushPlain(cursor);
          const base = info.path.split('/').filter(Boolean).at(-1) || info.path;
          parent.append(makeFileChip(base, info.path, info.lineRange, rawUrl));
          cursor = plainStart = cursor + rawUrl.length;
          continue;
        }
      }
    }
    cursor++;
  }
  flushPlain(text.length);
}

function formatted(text) {
  const body = element('div', undefined, 'answer');
  let paragraph = [], quote = [], list, code, fence;
  function flush() {
    if (paragraph.length) {
      const block = element('p');
      inline(block, paragraph.join('\n'));
      body.append(block);
      paragraph = [];
    }
    if (quote.length) {
      let kind = '';
      const lines = [...quote];
      const alertMatch = lines[0].match(/^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*(.*)$/i);
      if (alertMatch) {
        kind = alertMatch[1].toUpperCase();
        if (alertMatch[2]) lines[0] = alertMatch[2];
        else lines.shift();
      }
      const warn = kind === 'WARNING' || kind === 'CAUTION';
      const q = element('blockquote', undefined, 'md-quote' + (kind ? ' md-alert' + (warn ? ' warn' : '') : ''));
      if (kind && ALERT_LABELS[kind]) q.append(element('span', ALERT_LABELS[kind], 'md-alert-title'));
      if (lines.length) {
        const content = element('div');
        inline(content, lines.join('\n'));
        q.append(content);
      }
      body.append(q);
      quote = [];
    }
  }
  for (const line of text.split(/\r?\n/)) {
    if (code) {
      if (line.trim() === fence) {
        const pre = element('pre');
        pre.append(element('code', code.join('\n')));
        body.append(pre);
        code = null;
      } else code.push(line);
      continue;
    }
    const start = line.match(/^\s*(`{3,}|~{3,})[^\s]*\s*$/);
    const hr = line.match(/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/);
    const heading = line.match(/^#{1,6}\s+(.+)$/);
    const quoteLine = line.match(/^\s*>\s?(.*)$/);
    const item = line.match(/^\s*([-*+] |\d+[.)] )(.+)$/);
    if (quoteLine) {
      if (paragraph.length) flush();
      list = null;
      quote.push(quoteLine[1]);
      continue;
    }
    if (!line.trim() || start || hr || heading || item || quote.length) flush();
    if (!item) list = null;
    if (start) { code = []; fence = start[1]; }
    else if (hr) body.append(element('hr', undefined, 'md-hr'));
    else if (heading) {
      const h = element('h3');
      inline(h, heading[1]);
      body.append(h);
    } else if (item) {
      const tag = /\d/.test(item[1]) ? 'ol' : 'ul';
      if (list?.localName !== tag) { list = element(tag); body.append(list); }
      const li = element('li');
      inline(li, item[2]);
      list.append(li);
    } else if (line.trim()) paragraph.push(line);
  }
  flush();
  if (code) {
    const pre = element('pre');
    pre.append(element('code', code.join('\n')));
    body.append(pre);
  }
  return body;
}

const toolLabels = {
  workspace_read_file: '读取文件', workspace_read_files: '批量读取', workspace_list_directory: '查看目录',
  workspace_file_info: '文件信息', workspace_search: '搜索项目', workspace_create_directory: '创建目录',
  workspace_write_file: '写入文件', workspace_edit_file: '编辑文件', workspace_delete_file: '删除文件',
  workspace_move_file: '移动文件', workspace_apply_patch: '应用补丁', workspace_run: '执行命令',
  session_read_attachment: '读取附件', session_send_attachment: '写入附件',
};

function fmtSize(bytes) {
  if (bytes >= 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  if (bytes >= 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return bytes + ' B';
}
function fmtDuration(ms) {
  if (!ms) return '';
  return ms >= 1000 ? (ms / 1000).toFixed(1) + 's' : ms + 'ms';
}

function toolStep(event, expanded, liveOutput) {
  const step = element('details', undefined, 'tool-step');
  step.dataset.call = event.id;
  step.open = expanded.has(event.id);
  const summary = element('summary');
  const label = toolLabels[event.name] ?? event.name;
  const subject = event.input?.path ?? event.input?.fromPath ?? event.input?.attachment ?? event.input?.pattern ?? event.input?.command?.slice(0, 48) ?? '';
  const status = event.status === 'failed' ? '失败' : event.status === 'running' ? '进行中' : '';
  summary.append(icon(event.name?.includes('read') ? 'file' : 'terminal'),
    element('span', [label, subject, status].filter(Boolean).join(' · ')), icon('down'));
  const outputText = event.output ?? (event.status === 'running' && liveOutput ? liveOutput : null);
  step.append(summary, element('pre', outputText ?? (event.status === 'running' ? '等待设备返回结果…' : '本次操作已结束。')));
  return step;
}

function thinkingStep(id, text, expanded, openDefault = false) {
  const details = element('details', undefined, 'thinking-step');
  details.dataset.think = id;
  details.open = expanded.has(id) || openDefault;
  const summary = element('summary');
  summary.append(icon('spark'), element('span', '思考过程'), icon('down'));
  details.append(summary, element('div', text, 'thinking-body'));
  return details;
}

export function renderThread(container, rows, { sessionId, isWeb = false, liveToolOutput = new Map() } = {}) {
  const latest = new Map();
  const expandedTools = new Set([...container.querySelectorAll('details.tool-step[open]')].map(d => d.dataset.call));
  const expandedThink = new Set([...container.querySelectorAll('details.thinking-step[open]')].map(d => d.dataset.think));
  for (const row of rows) if (row.event.type === 'tool_call') latest.set(row.event.id, row.seq);
  const output = document.createDocumentFragment();
  for (let i = 0; i < rows.length; i++) {
    const { event, seq } = rows[i];
    if (event.type === 'user_message') {
      const bubble = element('article', undefined, 'user-message');
      bubble.setAttribute('aria-label', '你的消息');
      bubble.append(element('div', event.text));
      if (Array.isArray(event.attachments) && event.attachments.length) {
        const list = element('div', undefined, 'msg-atts');
        for (const att of event.attachments) {
          const url = isWeb && sessionId ? `/api/sessions/${sessionId}/attachments/${att.id}` : null;
          if (url && /^image\//.test(att.mime)) {
            const btn = element('button', undefined, 'msg-att-img-btn');
            btn.type = 'button';
            btn.dataset.previewUrl = url;
            btn.dataset.previewName = att.name;
            btn.dataset.previewSize = String(att.size ?? 0);
            btn.title = `点击查看大图：${att.name} (${fmtSize(att.size)})`;
            btn.setAttribute('aria-label', `预览图片 ${att.name}`);
            const img = element('img', undefined, 'msg-att-img');
            img.src = url; img.alt = att.name; img.loading = 'lazy';
            btn.append(img, element('span', att.name, 'msg-att-img-cap'));
            list.append(btn);
          } else {
            const chip = element(url ? 'a' : 'span', undefined, 'msg-att');
            if (url) { chip.href = url; chip.target = '_blank'; chip.rel = 'noopener'; }
            chip.append(icon('paperclip'), element('span', `${att.name} (${fmtSize(att.size)})`));
            list.append(chip);
          }
        }
        bubble.append(list);
      }
      output.append(bubble);
    } else if (event.type === 'thinking' && event.text) {
      output.append(thinkingStep(event.id ?? String(seq), event.text, expandedThink));
    } else if (event.type === 'assistant_text') {
      let text = event.text;
      const group = String(event.id).replace(/-\d+$/, '');
      while (rows[i + 1]?.event.type === 'assistant_text' && String(rows[i + 1].event.id).replace(/-\d+$/, '') === group) {
        text += rows[++i].event.text;
      }
      const message = element('article', undefined, 'assistant-message');
      const author = element('div', undefined, 'author'), mark = element('span', undefined, 'brand-mark');
      mark.append(icon('terminal'));
      author.append(mark, element('span', event.engine === 'antigravity' ? 'Antigravity' : event.engine === 'codex' ? 'Codex' : '助手'));
      message.append(author, formatted(text));
      output.append(message);
    } else if (event.type === 'tool_call' && latest.get(event.id) === seq) {
      output.append(toolStep(event, expandedTools, liveToolOutput.get(event.id)));
    } else if (event.type === 'turn_end') {
      if (!event.ok) {
        output.append(element('p', event.error || '本次回复中断。', 'turn-error'));
      } else {
        const parts = [];
        if (event.model) parts.push(event.model);
        if (event.durationMs) parts.push(fmtDuration(event.durationMs));
        if (event.usage?.inputTokens || event.usage?.outputTokens) {
          parts.push(`in ${event.usage.inputTokens ?? 0} / out ${event.usage.outputTokens ?? 0}`);
        }
        if (parts.length) output.append(element('p', parts.join(' · '), 'turn-meta'));
      }
    }
  }
  container.replaceChildren(output);
}

export function renderLive(container, live, engineLabel = 'Codex') {
  const hasContent = Boolean(live.thinking || live.text);
  container.hidden = !hasContent;
  if (!hasContent) { container.replaceChildren(); return; }
  const frag = document.createDocumentFragment();
  if (live.thinking) {
    const details = element('details', undefined, 'thinking-step');
    details.open = true;
    const summary = element('summary');
    summary.append(icon('spark'), element('span', '思考中…'), icon('down'));
    details.append(summary, element('div', live.thinking, 'thinking-body'));
    frag.append(details);
  }
  if (live.text) {
    const msg = element('article', undefined, 'assistant-message');
    const author = element('div', undefined, 'author'), mark = element('span', undefined, 'brand-mark');
    mark.append(icon('terminal'));
    author.append(mark, element('span', engineLabel));
    msg.append(author, formatted(live.text));
    frag.append(msg);
  }
  container.replaceChildren(frag);
}
