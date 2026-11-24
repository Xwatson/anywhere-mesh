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
function inline(parent, text) {
  const tokens = /(`[^`\n]+`|\*\*[^*\n]+\*\*)/g;
  let cursor = 0;
  for (const match of text.matchAll(tokens)) {
    parent.append(text.slice(cursor, match.index));
    const bold = match[0].startsWith('**');
    parent.append(element(bold ? 'strong' : 'code', match[0].slice(bold ? 2 : 1, bold ? -2 : -1)));
    cursor = match.index + match[0].length;
  }
  parent.append(text.slice(cursor));
}

function formatted(text) {
  const body = element('div', undefined, 'answer');
  let paragraph = [], list, code, fence;
  function flush() {
    if (paragraph.length) {
      const block = element('p');
      inline(block, paragraph.join('\n'));
      body.append(block);
      paragraph = [];
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
    const heading = line.match(/^#{1,6}\s+(.+)$/);
    const item = line.match(/^\s*([-*+] |\d+[.)] )(.+)$/);
    if (!line.trim() || start || heading || item) flush();
    if (!item) list = null;
    if (start) { code = []; fence = start[1]; }
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
