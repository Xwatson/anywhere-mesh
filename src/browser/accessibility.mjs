// Compact Accessibility Tree serializer modeled after Playwright MCP's ref-tagged snapshots.

const STRUCTURAL_ROLES = new Set([
  'generic', 'none', 'presentation', 'InlineTextBox', 'LineBreak', 'LayoutTable',
  'LayoutTableRow', 'LayoutTableCell', 'Div', 'Span', 'Paragraph',
]);

const INTERACTIVE_ROLES = new Set([
  'button', 'link', 'textbox', 'searchbox', 'combobox', 'listbox', 'option',
  'checkbox', 'radio', 'switch', 'slider', 'spinbutton', 'tab', 'menuitem',
  'menuitemcheckbox', 'menuitemradio', 'treeitem',
]);

const KEEP_ROLES = new Set([
  ...INTERACTIVE_ROLES,
  'RootWebArea', 'document', 'main', 'navigation', 'banner', 'contentinfo', 'complementary',
  'region', 'form', 'search', 'dialog', 'alertdialog', 'alert', 'status', 'heading',
  'img', 'table', 'row', 'columnheader', 'rowheader', 'cell', 'list', 'listitem',
  'article', 'section', 'toolbar', 'menu', 'menubar', 'tablist', 'tabpanel', 'tree',
]);

function axVal(field) {
  if (!field || typeof field !== 'object') return undefined;
  return field.value;
}

function cleanText(value, max = 140) {
  if (value === undefined || value === null) return '';
  const s = String(value).replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

function getProp(node, name) {
  if (!Array.isArray(node.properties)) return undefined;
  const hit = node.properties.find(p => p?.name === name);
  return hit ? axVal(hit.value) : undefined;
}

export function buildAccessibilitySnapshot(nodes, { maxNodes = 300, url = '', title = '' } = {}) {
  const byId = new Map();
  for (const n of nodes ?? []) {
    if (n?.nodeId !== undefined) byId.set(n.nodeId, n);
  }
  const root = (nodes ?? []).find(n => !n.parentId || !byId.has(n.parentId)) ?? nodes?.[0];
  const lines = [];
  if (title || url) {
    lines.push(`Page: ${cleanText(title || '(untitled)', 120)}${url ? ` (${url})` : ''}`);
  }
  const refMap = new Map();
  let refCounter = 0;
  let emitted = 0;
  let truncated = false;

  const visit = (node, depth) => {
    if (!node || emitted >= maxNodes) {
      if (node && emitted >= maxNodes) truncated = true;
      return;
    }
    const role = cleanText(axVal(node.role) ?? '', 40);
    const name = cleanText(axVal(node.name) ?? '', 140);
    const value = cleanText(axVal(node.value) ?? '', 120);
    const ignored = Boolean(node.ignored);
    const children = (node.childIds ?? []).map(id => byId.get(id)).filter(Boolean);

    if (ignored) {
      for (const child of children) visit(child, depth);
      return;
    }

    if (role === 'StaticText') {
      if (name && depth > 0) {
        lines.push(`${'  '.repeat(Math.min(depth, 10))}- text: ${JSON.stringify(name)}`);
        emitted++;
      }
      return;
    }

    const isRoot = role === 'RootWebArea' || role === 'WebArea';
    const isStructural = STRUCTURAL_ROLES.has(role);
    const isInteractive = INTERACTIVE_ROLES.has(role);
    const hasBackend = Number.isInteger(node.backendDOMNodeId) && node.backendDOMNodeId > 0;
    const shouldEmit = !isRoot && (
      isInteractive ||
      (KEEP_ROLES.has(role) && (name || value || role === 'form' || role === 'dialog' || role === 'alert' || role === 'main' || role === 'navigation' || role === 'table')) ||
      (!isStructural && Boolean(name))
    );

    if (shouldEmit) {
      const attrs = [];
      if (hasBackend && (isInteractive || role === 'heading' || role === 'img' || role === 'listitem' || role === 'cell' || role === 'tab' || role === 'row' || Boolean(name))) {
        const ref = `e${++refCounter}`;
        refMap.set(ref, { backendDOMNodeId: node.backendDOMNodeId, role, name });
        attrs.push(`ref=${ref}`);
      }
      const level = getProp(node, 'level');
      if (level !== undefined && role === 'heading') attrs.push(`level=${level}`);
      const checked = getProp(node, 'checked');
      if (checked === true || checked === 'true' || checked === 'mixed') attrs.push(`checked=${checked}`);
      const selected = getProp(node, 'selected');
      if (selected === true) attrs.push('selected');
      const expanded = getProp(node, 'expanded');
      if (expanded !== undefined) attrs.push(`expanded=${expanded}`);
      const disabled = getProp(node, 'disabled');
      if (disabled === true) attrs.push('disabled');
      const focused = getProp(node, 'focused');
      if (focused === true) attrs.push('focused');
      if (value && value !== name) attrs.push(`value=${JSON.stringify(value)}`);

      const attrStr = attrs.length ? ` [${attrs.join(', ')}]` : '';
      const labelStr = name ? ` ${JSON.stringify(name)}` : '';
      lines.push(`${'  '.repeat(Math.min(depth, 10))}- ${role}${labelStr}${attrStr}`);
      emitted++;

      // Avoid repeating StaticText child when its text is already the interactive element's accessible name.
      if (isInteractive && children.length === 1 && axVal(children[0].role) === 'StaticText' && cleanText(axVal(children[0].name) ?? '') === name) {
        return;
      }
    }

    const nextDepth = isRoot ? 0 : (shouldEmit ? depth + 1 : depth);
    for (const child of children) {
      if (emitted >= maxNodes) { truncated = true; break; }
      visit(child, nextDepth);
    }
  };

  if (root) visit(root, 0);
  if (truncated) lines.push(`... (snapshot truncated at ${maxNodes} nodes)`);
  if (lines.length <= 1) lines.push('(empty page)');
  return {
    text: lines.join('\n'),
    refMap,
    nodeCount: emitted,
    truncated,
  };
}
