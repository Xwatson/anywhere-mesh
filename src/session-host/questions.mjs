const RECOMMENDED_PREFIX_RE = /^\s*\(Recommended\)\s*/i;
const RECOMMENDED_SUFFIX_RE = /\s*\(Recommended\)\s*$/i;

function clip(value, max) {
  return String(value ?? '').trim().slice(0, max);
}

export function normalizeQuestionOption(opt) {
  if (typeof opt === 'string') {
    const rawLabel = clip(opt, 600);
    if (!rawLabel) return null;
    const recommended = RECOMMENDED_PREFIX_RE.test(rawLabel) || RECOMMENDED_SUFFIX_RE.test(rawLabel);
    const label = rawLabel.replace(RECOMMENDED_PREFIX_RE, '').replace(RECOMMENDED_SUFFIX_RE, '').trim() || rawLabel;
    return { label, rawLabel, ...(recommended ? { recommended: true } : {}) };
  }
  if (!opt || typeof opt !== 'object') return null;
  const rawLabel = clip(opt.rawLabel ?? opt.label ?? opt.title ?? opt.value ?? '', 600);
  if (!rawLabel) return null;
  const recommended = Boolean(opt.recommended) || RECOMMENDED_PREFIX_RE.test(rawLabel) || RECOMMENDED_SUFFIX_RE.test(rawLabel);
  const label = rawLabel.replace(RECOMMENDED_PREFIX_RE, '').replace(RECOMMENDED_SUFFIX_RE, '').trim() || rawLabel;
  const description = clip(opt.description ?? opt.detail ?? '', 800);
  return {
    label,
    rawLabel,
    ...(description ? { description } : {}),
    ...(recommended ? { recommended: true } : {}),
  };
}

export function normalizeQuestions(rawList) {
  if (!Array.isArray(rawList) || !rawList.length) return [];
  const usedIds = new Set();
  const out = [];
  for (let i = 0; i < rawList.length && out.length < 12; i++) {
    const item = rawList[i];
    if (!item || typeof item !== 'object') continue;
    const question = clip(item.question ?? item.prompt ?? item.text ?? '', 1200);
    if (!question) continue;
    let id = clip(item.id ?? '', 80) || `q${out.length + 1}`;
    if (usedIds.has(id)) {
      let n = 2;
      while (usedIds.has(`${id}_${n}`)) n++;
      id = `${id}_${n}`;
    }
    usedIds.add(id);
    const header = clip(item.header ?? item.title ?? '', 80);
    const multiSelect = Boolean(item.multiSelect ?? item.is_multi_select ?? item.isMultiSelect);
    const secret = Boolean(item.secret ?? item.isSecret ?? item.is_secret);
    const allowOther = item.allowOther !== undefined
      ? Boolean(item.allowOther)
      : (item.isOther !== undefined ? Boolean(item.isOther) : true);
    const rawOptions = Array.isArray(item.options) ? item.options : [];
    const options = [];
    for (const rawOpt of rawOptions) {
      if (options.length >= 12) break;
      const normalized = normalizeQuestionOption(rawOpt);
      if (normalized) options.push(normalized);
    }
    out.push({
      id,
      ...(header ? { header } : {}),
      question,
      multiSelect,
      ...(secret ? { secret: true } : {}),
      allowOther,
      options,
    });
  }
  return out;
}

export function formatAgyQuestionFallback(questions) {
  return (questions ?? []).map(q => {
    const lines = [q.question];
    for (let i = 0; i < (q.options?.length ?? 0); i++) {
      lines.push(`- [${i + 1}] ${q.options[i].rawLabel ?? q.options[i].label}`);
    }
    return lines.join('\n');
  }).join('\n\n');
}

export function stripAgyQuestionFallback(text, questions) {
  const raw = String(text ?? '');
  if (!raw.trim() || !Array.isArray(questions) || !questions.length) return raw;
  const normRaw = raw.replace(/\r\n/g, '\n');
  const expected = formatAgyQuestionFallback(questions).replace(/\r\n/g, '\n').trim();
  if (!expected) return raw;
  const trimmed = normRaw.trim();
  if (trimmed === expected) return '';
  if (trimmed.endsWith(expected)) {
    return trimmed.slice(0, trimmed.length - expected.length).trimEnd();
  }
  const idx = normRaw.lastIndexOf(expected);
  if (idx >= 0) {
    return (normRaw.slice(0, idx) + normRaw.slice(idx + expected.length)).trim();
  }
  // Fallback line-based match: strip trailing question + `- [1] ...` blocks if every question matches.
  let remainder = normRaw.trimEnd();
  for (let qi = questions.length - 1; qi >= 0; qi--) {
    const q = questions[qi];
    const blockLines = [q.question.trim()];
    for (let oi = 0; oi < (q.options?.length ?? 0); oi++) {
      blockLines.push(`- [${oi + 1}] ${(q.options[oi].rawLabel ?? q.options[oi].label).trim()}`);
    }
    const block = blockLines.join('\n');
    const pos = remainder.lastIndexOf(block);
    if (pos < 0) return raw;
    if (remainder.slice(pos + block.length).trim()) return raw;
    remainder = remainder.slice(0, pos).trimEnd();
  }
  return remainder;
}

export function normalizeSubmittedAnswers(questions, rawAnswers = {}, skipped = false) {
  if (!Array.isArray(questions) || !questions.length) throw Error('INVALID_FIELDS');
  if (rawAnswers !== null && rawAnswers !== undefined && (typeof rawAnswers !== 'object' || Array.isArray(rawAnswers))) {
    throw Error('INVALID_FIELDS');
  }
  const src = rawAnswers ?? {};
  const answers = {};
  const displayAnswers = {};
  const codexAnswers = {};
  for (const q of questions) {
    if (skipped) {
      answers[q.id] = [];
      displayAnswers[q.id] = [];
      codexAnswers[q.id] = { answers: [] };
      continue;
    }
    const rawVal = Object.hasOwn(src, q.id) ? src[q.id] : (Object.hasOwn(src, q.question) ? src[q.question] : undefined);
    const list = Array.isArray(rawVal) ? rawVal : (typeof rawVal === 'string' ? [rawVal] : []);
    const cleaned = [];
    const seen = new Set();
    const maxItems = q.multiSelect ? 16 : 2;
    for (const entry of list) {
      if (typeof entry !== 'string') throw Error('INVALID_FIELDS');
      const v = entry.trim();
      if (!v) continue;
      if (v.length > 4000) throw Error('INVALID_TEXT');
      if (seen.has(v)) continue;
      seen.add(v);
      cleaned.push(v);
      if (cleaned.length >= maxItems) break;
    }
    if (!cleaned.length) throw Error('INVALID_ANSWER');
    answers[q.id] = cleaned;
    displayAnswers[q.id] = q.secret ? ['••••••'] : cleaned;
    codexAnswers[q.id] = { answers: cleaned };
  }
  return { answers, displayAnswers, codexAnswers };
}

export function formatAnswersForPrompt(questions, answersMap = {}, skipped = false) {
  if (skipped) return '跳过上述提问，请按推荐方案或自行判断继续。';
  if (!Array.isArray(questions) || !questions.length) return '';
  if (questions.length === 1) {
    const q = questions[0];
    const list = answersMap[q.id] ?? answersMap[q.question] ?? [];
    const joined = list.join('；');
    return `关于「${q.question}」：\n选择：${joined}`;
  }
  return questions.map((q, idx) => {
    const list = answersMap[q.id] ?? answersMap[q.question] ?? [];
    return `${idx + 1}. ${q.question}\n选择：${list.join('；')}`;
  }).join('\n\n');
}

export function formatQuestionPromptTranscript(event) {
  const qs = Array.isArray(event?.questions) ? event.questions : [];
  if (!qs.length) return '';
  return formatAgyQuestionFallback(qs);
}

export function formatQuestionAnswerTranscript(event, promptEvent = null) {
  if (event?.skipped) return event?.cancelled ? '[用户已取消提问]' : '[用户跳过提问]';
  const qs = Array.isArray(promptEvent?.questions) ? promptEvent.questions : [];
  const map = event?.answers ?? {};
  if (qs.length) {
    return qs.map((q, idx) => {
      const list = Array.isArray(map[q.id]) ? map[q.id] : [];
      const val = q.secret ? '[已填写私密内容]' : (list.join('；') || '(无)');
      return qs.length === 1 ? `回答「${q.question}」：${val}` : `${idx + 1}. ${q.question} -> ${val}`;
    }).join('\n');
  }
  const entries = Object.entries(map)
    .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join('；') : String(v ?? '')}`)
    .filter(Boolean);
  return entries.length ? `用户回答：\n${entries.join('\n')}` : '[用户已回答]';
}
