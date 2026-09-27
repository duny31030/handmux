import { useCallback, useEffect, useRef, useState } from 'react';
import {
  readAgentModelControl,
  updateAgentModelControl,
} from '../agentSessionControlApi.js';
import type {
  AgentModelControlPatch,
  AgentModelControlSnapshot,
} from '../agentSessionControlApi.js';
import type { AgentRunRef } from '../agentCatalog.js';
import { UnauthorizedError } from '../apiErrors.js';

export interface AgentSessionControlController {
  status: 'idle' | 'loading' | 'ready' | 'unavailable' | 'error';
  error: string | null;
  modelControl: AgentModelControlSnapshot | null;
  saving: boolean;
  refresh(): Promise<void>;
  update(patch: AgentModelControlPatch): Promise<void>;
}

const message = (): string => 'session_control_unavailable';

function cacheKey(run: AgentRunRef): string {
  return JSON.stringify([run.agentId, run.paneId, run.runId, run.sessionId ?? null]);
}

function isCurrentRun(current: AgentRunRef | null, expected: AgentRunRef): boolean {
  return current !== null && cacheKey(current) === cacheKey(expected);
}

export function useAgentSessionControl(
  run: AgentRunRef | null,
  onAuthFail?: () => void,
): AgentSessionControlController {
  const [status, setStatus] = useState<AgentSessionControlController['status']>('idle');
  const [error, setError] = useState<string | null>(null);
  const [modelControl, setModelControl] = useState<AgentModelControlSnapshot | null>(null);
  const [saving, setSaving] = useState(false);
  const generation = useRef(0);
  const operation = useRef(0);
  const writeToken = useRef(0);
  // Keep one snapshot per exact run identity; a cached null means this run has no control.
  const snapshots = useRef(new Map<string, AgentModelControlSnapshot | null>());
  const savingRef = useRef(false);
  const runRef = useRef(run);
  const modelControlRef = useRef(modelControl);
  const authRef = useRef(onAuthFail);
  runRef.current = run;
  modelControlRef.current = modelControl;
  authRef.current = onAuthFail;

  const load = useCallback(async (refresh: boolean, silent = false): Promise<void> => {
    const active = runRef.current;
    if (!active || savingRef.current) return;
    const requestGeneration = generation.current;
    const requestOperation = ++operation.current;
    setError(null);
    if (!silent) setStatus('loading');
    try {
      const next = await readAgentModelControl(active, { refresh });
      if (generation.current !== requestGeneration || operation.current !== requestOperation
        || !isCurrentRun(runRef.current, active)) return;
      snapshots.current.set(cacheKey(active), next);
      setModelControl(next);
      setStatus(next ? 'ready' : 'unavailable');
    } catch (cause) {
      if (generation.current !== requestGeneration || operation.current !== requestOperation
        || !isCurrentRun(runRef.current, active)) return;
      if (cause instanceof UnauthorizedError) authRef.current?.();
      setError(message());
      setStatus('error');
    }
  }, []);

  useEffect(() => {
    generation.current += 1;
    operation.current += 1;
    writeToken.current += 1;
    savingRef.current = false;
    const cached = run ? snapshots.current.get(cacheKey(run)) : undefined;
    setModelControl(cached === undefined ? null : cached);
    setError(null);
    setSaving(false);
    if (!run) {
      setStatus('idle');
      return undefined;
    }
    setStatus(cached === undefined ? 'loading' : cached ? 'ready' : 'unavailable');
    void load(false, cached !== undefined);
    return () => { generation.current += 1; };
  }, [run?.agentId, run?.paneId, run?.runId, run?.sessionId, load]);

  const update = useCallback(async (patch: AgentModelControlPatch): Promise<void> => {
    const active = runRef.current;
    if (!active || savingRef.current) return;
    if (!modelControlRef.current?.canUpdate) throw new Error('session_control_read_only');
    const requestGeneration = generation.current;
    const requestOperation = ++operation.current;
    const requestWriteToken = ++writeToken.current;
    savingRef.current = true;
    setSaving(true);
    setError(null);
    try {
      const next = await updateAgentModelControl(active, patch);
      if (generation.current !== requestGeneration || operation.current !== requestOperation
        || !isCurrentRun(runRef.current, active)) return;
      snapshots.current.set(cacheKey(active), next);
      setModelControl(next);
      setStatus('ready');
    } catch (cause) {
      if (generation.current !== requestGeneration || operation.current !== requestOperation
        || !isCurrentRun(runRef.current, active)) return;
      if (cause instanceof UnauthorizedError) authRef.current?.();
      setError(message());
      throw cause;
    } finally {
      if (writeToken.current === requestWriteToken) savingRef.current = false;
      if (generation.current === requestGeneration && writeToken.current === requestWriteToken
        && isCurrentRun(runRef.current, active)) {
        setSaving(false);
      }
    }
  }, []);

  return {
    status,
    error,
    modelControl,
    saving,
    refresh: () => load(true),
    update,
  };
}
