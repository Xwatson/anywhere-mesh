import { useEffect, useState } from 'react';
import type { AgentModels, EffortLevel, ModelOption, SessionInfo } from '../../../server/src/shared/protocol';
import { api } from './api';

export const EFFORT_LABELS: Record<EffortLevel, string> = {
  minimal: '最低',
  low: '低',
  medium: '中',
  high: '高',
  xhigh: '超高',
  max: '最大',
  ultra: '极限',
};

let cached: Promise<AgentModels> | null = null;

export function useModels(): AgentModels | null {
  const [models, setModels] = useState<AgentModels | null>(null);
  useEffect(() => {
    cached ??= api.models().catch((e) => {
      cached = null;
      throw e;
    });
    cached.then(setModels, () => {});
  }, []);
  return models;
}

const ALL_EFFORTS: EffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max'];

/** Models the user can pick for an agent; Claude's own "default" entry is our unset value. */
export function modelChoices(models: AgentModels | null, agent: SessionInfo['agent']): { options: ModelOption[]; defaultLabel: string } {
  if (agent === 'claude') {
    return { options: (models?.claude.models ?? []).filter((m) => m.id !== 'default'), defaultLabel: '默认' };
  }
  const configured = models?.codex.configuredModel ?? models?.codex.models.find((m) => m.isDefault)?.id;
  return { options: models?.codex.models ?? [], defaultLabel: configured ? `默认（${configured}）` : '默认' };
}

/** Effort levels valid for a session's agent and model, plus what "default" resolves to. */
export function effortChoices(
  models: AgentModels | null,
  agent: SessionInfo['agent'],
  model?: string,
): { efforts: EffortLevel[]; defaultLabel: string } {
  if (agent === 'claude') {
    const list = models?.claude.models ?? [];
    const m = list.find((x) => x.id === (model || 'default')) ?? list.find((x) => x.id === 'default');
    return { efforts: m ? m.efforts : ALL_EFFORTS, defaultLabel: '默认' };
  }
  const list = models?.codex.models ?? [];
  const wanted = model || models?.codex.configuredModel;
  const m = list.find((x) => x.id === wanted) ?? list.find((x) => x.isDefault);
  const configured = models?.codex.configuredEffort as EffortLevel | undefined;
  const def = configured && m?.efforts.includes(configured) ? configured : m?.defaultEffort;
  return {
    efforts: m?.efforts ?? ['low', 'medium', 'high', 'xhigh'],
    defaultLabel: def ? `默认（${EFFORT_LABELS[def] ?? def}）` : '默认',
  };
}
