/**
 * @fileoverview Native Antigravity `Stop` lifecycle hook for agy-xiaozhi-notifier.
 *
 * Reads the Stop hook JSON payload from stdin, filters out user cancellations and non-idle
 * intermediate stops, sweeps stale temp files, spawns a fully detached hidden background worker
 * to verify main-vs-subagent status and speak via local GPT-SoVITS / cached voice, and
 * IMMEDIATELY prints `{"decision":"allow"}` so it never blocks or loops the agent.
 */

import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PLUGIN_ROOT = path.resolve(__dirname, '..');

function readStdinSafe(timeoutMs = 1500) {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) {
      resolve('');
      return;
    }
    let buf = '';
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(buf);
    };
    const timer = setTimeout(finish, timeoutMs);
    timer.unref?.();

    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      buf += chunk;
    });
    process.stdin.on('end', finish);
    process.stdin.on('error', finish);
  });
}

export function loadPluginConfig(pluginRoot = PLUGIN_ROOT) {
  for (const name of ['config.json', 'config.example.json']) {
    const cfgPath = path.join(pluginRoot, name);
    try {
      const raw = fs.readFileSync(cfgPath, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        return parsed;
      }
    } catch {
      // Try next fallback
    }
  }
  return { enabled: true };
}

export function classifyStopEvent(payload, config = {}) {
  if (!payload || typeof payload !== 'object') {
    return { shouldNotify: false, kind: 'skip', reason: 'empty_payload' };
  }
  if (config.enabled === false) {
    return { shouldNotify: false, kind: 'skip', reason: 'disabled' };
  }
  // Only announce once all background tasks/subagents for this turn are completely idle.
  if (payload.fullyIdle === false) {
    return { shouldNotify: false, kind: 'skip', reason: 'not_fully_idle' };
  }

  const termReason = String(payload.terminationReason || 'NO_TOOL_CALL').trim().toUpperCase();
  if (termReason === 'USER_CANCELED') {
    return { shouldNotify: false, kind: 'skip', reason: 'user_canceled' };
  }
  if (termReason === 'ERROR') {
    if (config.announceOnError === false) {
      return { shouldNotify: false, kind: 'skip', reason: 'error_disabled' };
    }
    return { shouldNotify: true, kind: 'error', reason: termReason };
  }
  if (
    termReason === 'MAX_INVOCATIONS' ||
    termReason === 'MAX_FORCED_INVOCATIONS' ||
    termReason === 'MAX_TOKEN_BUDGET_EXCEEDED'
  ) {
    if (config.announceOnLimit === false) {
      return { shouldNotify: false, kind: 'skip', reason: 'limit_disabled' };
    }
    return { shouldNotify: true, kind: 'limit', reason: termReason };
  }
  return { shouldNotify: true, kind: 'done', reason: termReason || 'NO_TOOL_CALL' };
}

function sweepStaleStateFiles(stateDir, maxAgeMs = 10 * 60 * 1000) {
  try {
    const now = Date.now();
    for (const name of fs.readdirSync(stateDir)) {
      if (!/^(?:job_.*\.json|play_.*\.wav|.*\.tmp)$/.test(name)) continue;
      const fp = path.join(stateDir, name);
      try {
        const st = fs.statSync(fp);
        if (now - st.mtimeMs > maxAgeMs) {
          fs.unlinkSync(fp);
        }
      } catch {
        // ignore concurrent deletion
      }
    }
  } catch {
    // ignore
  }
}

export function dispatchStopPayload(payload, { pluginRoot = PLUGIN_ROOT, spawnFn = spawn } = {}) {
  const config = loadPluginConfig(pluginRoot);
  const verdict = classifyStopEvent(payload, config);
  if (!verdict.shouldNotify) {
    return { dispatched: false, ...verdict };
  }

  const stateDir = path.join(pluginRoot, 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  sweepStaleStateFiles(stateDir);

  const jobId = `${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
  const payloadFile = path.join(stateDir, `job_${jobId}.json`);
  const jobData = {
    jobId,
    createdAt: Date.now(),
    kind: verdict.kind,
    terminationReason: verdict.reason,
    payload,
  };
  fs.writeFileSync(payloadFile, JSON.stringify(jobData), 'utf8');

  const workerPath = path.join(pluginRoot, 'hooks', 'speak-worker.mjs');
  const child = spawnFn(process.execPath, ['--no-warnings', workerPath, '--job-file', payloadFile], {
    cwd: pluginRoot,
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: {
      ...process.env,
      XIAOZHI_NOTIFIER_PLUGIN_ROOT: pluginRoot,
    },
  });
  child.unref?.();
  return { dispatched: true, jobId, payloadFile, ...verdict };
}

async function main() {
  try {
    const raw = (await readStdinSafe()).trim();
    if (raw) {
      const payload = JSON.parse(raw);
      dispatchStopPayload(payload);
    }
  } catch {
    // Best-effort only; never break or block the Antigravity agent loop.
  }
  process.stdout.write('{"decision":"allow"}\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  main();
}
