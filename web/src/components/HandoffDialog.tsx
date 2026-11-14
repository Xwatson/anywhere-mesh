import { useState } from 'react';
import type { ClaudePermissionMode, EffortLevel, SessionInfo, SessionOptions } from '../../../server/src/shared/protocol';
import { api } from '../lib/api';
import { EFFORT_LABELS, effortChoices, modelChoices, useModels } from '../lib/models';
import { addSession } from '../lib/store';
import type { BriefRef } from './BriefCard';
import { PERMISSION_MODES } from './NewDialogs';
import { Button, cx, ErrorText, Icon, Modal } from './ui';

const KEY = 'handoffOptions';
/** The "+" menu's Claude presets, unless the user picked something else last time. */
const DEFAULTS: SessionOptions = { model: 'opus', effort: 'high', permissionMode: 'auto' };

function savedOptions(): SessionOptions {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) || '{}') };
  } catch {
    return DEFAULTS;
  }
}

const label = 'block text-sm text-zinc-400 mb-1';
const input = 'w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 outline-none focus:border-emerald-500';

/** Model, reasoning effort and permission mode for the coding session a brief is handed to. */
export function HandoffDialog({ session, brief, onClose }: { session: SessionInfo; brief: BriefRef; onClose: () => void }) {
  const [opts, setOpts] = useState<SessionOptions>(savedOptions);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const models = useModels();
  const modelList = modelChoices(models, 'claude');
  const choices = effortChoices(models, 'claude', opts.model);
  const effort = opts.effort && choices.efforts.includes(opts.effort) ? opts.effort : '';
  const mode = opts.permissionMode ?? 'auto';

  const go = async () => {
    setBusy(true);
    setError('');
    const options: SessionOptions = { model: opts.model || undefined, effort: effort || undefined, permissionMode: mode };
    try {
      const s = await api.handoff(session.id, brief.file, options);
      try {
        localStorage.setItem(KEY, JSON.stringify(options));
      } catch {
        /* storage unavailable */
      }
      addSession(s);
      onClose();
      location.hash = `#/s/${s.id}`;
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  return (
    <Modal
      onClose={onClose}
      title={
        <span className="flex items-center gap-2">
          <Icon name="send" /> 交给编码会话
        </span>
      }
    >
      <div className="space-y-4 p-4">
        <div className="rounded-lg border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-sm">
          <div className="font-medium">需求书：{brief.title}</div>
          <div className="mt-0.5 text-xs text-zinc-500">会在独立的 worktree 里新建一个 Claude 会话，首条消息就是这份需求书。开始后仍可在工具栏里改模型和推理强度。</div>
        </div>

        <div className="grid grid-cols-2 gap-2">
          <label>
            <span className={label}>模型</span>
            <select className={input} value={opts.model ?? ''} onChange={(e) => setOpts({ ...opts, model: e.target.value || undefined })}>
              <option value="">{modelList.defaultLabel}</option>
              {modelList.options.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
              {opts.model && !modelList.options.some((m) => m.id === opts.model) && <option value={opts.model}>{opts.model}</option>}
            </select>
          </label>
          <label>
            <span className={label}>推理强度</span>
            <select className={input} value={effort} onChange={(e) => setOpts({ ...opts, effort: (e.target.value || undefined) as EffortLevel | undefined })}>
              <option value="">{choices.defaultLabel}</option>
              {choices.efforts.map((lvl) => (
                <option key={lvl} value={lvl}>
                  {EFFORT_LABELS[lvl] ?? lvl}
                </option>
              ))}
            </select>
          </label>
        </div>

        <div>
          <span className={label}>权限模式</span>
          <div className="space-y-1.5">
            {PERMISSION_MODES.map((m) => (
              <label
                key={m.value}
                className={cx(
                  'flex cursor-pointer gap-2.5 rounded-lg border px-3 py-2',
                  mode === m.value ? 'border-emerald-500/60 bg-emerald-500/5' : 'border-zinc-800 hover:border-zinc-700',
                )}
              >
                <input
                  type="radio"
                  className="mt-1 accent-emerald-500"
                  checked={mode === m.value}
                  onChange={() => setOpts({ ...opts, permissionMode: m.value as ClaudePermissionMode })}
                />
                <span>
                  <span className="text-sm">{m.label}</span>
                  <span className="block text-xs text-zinc-500">{m.hint}</span>
                </span>
              </label>
            ))}
          </div>
        </div>

        <ErrorText>{error}</ErrorText>
        <div className="flex justify-end gap-2">
          <Button onClick={onClose} disabled={busy}>
            取消
          </Button>
          <Button variant="primary" onClick={go} disabled={busy}>
            {busy ? '正在交接…' : '开始'}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
