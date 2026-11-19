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
  workspace_read_file: '读取文件', workspace_list_directory: '查看目录', workspace_search: '搜索项目',
  workspace_write_file: '写入文件', workspace_run: '执行命令'
};

function toolStep(event, expanded) {
  const step = element('details', undefined, 'tool-step');
  step.dataset.call = event.id;
  step.open = expanded.has(event.id);
  const summary = element('summary');
  const label = toolLabels[event.name] ?? event.name;
  const subject = event.input?.path ?? event.input?.query ?? '';
  const status = event.status === 'failed' ? '失败' : event.status === 'running' ? '进行中' : '';
  summary.append(icon(event.name === 'workspace_read_file' ? 'file' : 'terminal'),
    element('span', [label, subject, status].filter(Boolean).join(' · ')), icon('down'));
  step.append(summary, element('pre', event.output ?? (event.status === 'running' ? '等待设备返回结果…' : '本次操作已结束。')));
  return step;
}

export function renderThread(container, rows) {
  const latest = new Map();
  const expanded = new Set([...container.querySelectorAll('details[open]')].map(d => d.dataset.call));
  for (const row of rows) if (row.event.type === 'tool_call') latest.set(row.event.id, row.seq);
  const output = document.createDocumentFragment();
  for (let i = 0; i < rows.length; i++) {
    const {event, seq} = rows[i];
    if (event.type === 'user_message') {
      const bubble = element('article', event.text, 'user-message');
      bubble.setAttribute('aria-label', '你的消息');
      output.append(bubble);
    } else if (event.type === 'assistant_text') {
      let text = event.text;
      const group = String(event.id).replace(/-\d+$/, '');
      while (rows[i + 1]?.event.type === 'assistant_text' && String(rows[i + 1].event.id).replace(/-\d+$/, '') === group) {
        text += rows[++i].event.text;
      }
      const message = element('article', undefined, 'assistant-message');
      const author = element('div', undefined, 'author'), mark = element('span', undefined, 'brand-mark');
      mark.append(icon('terminal'));
      author.append(mark, element('span', event.engine === 'codex' ? 'Codex' : '助手'));
      message.append(author, formatted(text));
      output.append(message);
    } else if (event.type === 'tool_call' && latest.get(event.id) === seq) {
      output.append(toolStep(event, expanded));
    } else if (event.type === 'turn_end' && !event.ok) {
      output.append(element('p', event.error || '本次回复中断。', 'turn-error'));
    }
  }
  container.replaceChildren(output);
}
