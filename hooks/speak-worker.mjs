/**
 * @fileoverview Detached background voice notifier for Google Antigravity + XiaoZhi.
 *
 * Features:
 * - Filters out internal subagents & run_workflow workers via Antigravity's conversation_summaries.db
 * - Synthesizes natural voice lines via local GPT-SoVITS (19880 /tts) with emotion reference profiles
 * - Plays via XiaoZhi PC Audio Bridge (18900 /audio/play, Bearer-authenticated) or hidden Windows SoundPlayer
 * - Serializes concurrent workers with a stale-safe file lock to prevent overlapping speech
 * - Auto-caches offline fallback WAVs on first live 19880 call so notifications work even with GPU TTS off
 */

import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEFAULT_PLUGIN_ROOT = path.resolve(__dirname, '..');

const DEFAULT_CONFIG = {
  enabled: true,
  ignoreSubagents: true,
  xiaozhiServerDir: '',
  gsvBaseUrl: 'http://127.0.0.1:19880',
  pcMcpBaseUrl: 'http://127.0.0.1:18900',
  volume: 1.0,
  sampleSteps: 8,
  addressPrefix: '',
  doneEmotion: 'gentle',
  errorEmotion: 'serious',
  limitEmotion: 'calm',
  announceOnError: true,
  announceOnLimit: true,
  includeTaskTopic: true,
  dedupeWindowMs: 4000,
  toastCooldownMs: 60000,
  toastAppId: 'electron.app.Antigravity',
  autoPrecacheOfflineFallback: true,
  toastWhenGsvOffline: true,
};

const MEI_EMOTION_FALLBACK = {
  calm: {
    ref_audio_path: 'voices/raiden_mei/mei_default_ref.wav',
    prompt_text: '今夜月色很美，呵...适合与朋友小聚一番。',
    prompt_lang: 'zh',
    speed_factor: 1.0,
    temperature: 0.98,
    top_k: 12,
    top_p: 1.0,
  },
  gentle: {
    ref_audio_path: 'voices/raiden_mei/mei_gentle_ref.wav',
    prompt_text: '你今天已经很努力了，接下来的事就交给我吧。',
    prompt_lang: 'zh',
    speed_factor: 0.96,
    temperature: 0.95,
    top_k: 12,
    top_p: 0.98,
  },
  happy: {
    ref_audio_path: 'voices/raiden_mei/mei_happy_ref.wav',
    prompt_text: '今天天气挺不错的，要和我们一起出去野餐吗？',
    prompt_lang: 'zh',
    speed_factor: 1.04,
    temperature: 1.04,
    top_k: 15,
    top_p: 1.0,
  },
  playful: {
    ref_audio_path: 'voices/raiden_mei/mei_playful_ref.wav',
    prompt_text: '如果你能按时起床，我倒不介意多做一份早餐哦。',
    prompt_lang: 'zh',
    speed_factor: 1.03,
    temperature: 1.05,
    top_k: 15,
    top_p: 1.0,
  },
  serious: {
    ref_audio_path: 'voices/raiden_mei/mei_serious_ref.wav',
    prompt_text: '以律者的身份守护人类，这就是雷电芽衣的选择。',
    prompt_lang: 'zh',
    speed_factor: 1.02,
    temperature: 0.9,
    top_k: 10,
    top_p: 0.95,
  },
  tender: {
    ref_audio_path: 'voices/raiden_mei/mei_tender_ref.wav',
    prompt_text: '那些美好温暖的回忆，会永远留在我的心中。',
    prompt_lang: 'zh',
    speed_factor: 0.93,
    temperature: 0.92,
    top_k: 12,
    top_p: 0.98,
  },
};

const GENERIC_DONE_TEMPLATES = [
  '反重力的任务已经完成了，你可以过来看看结果了。',
  '刚才交给反重力的任务已经处理好了，过来确认一下吧。',
  '反重力这边已经忙完了，有空的时候来看看结果吧。',
];

const TRIVIAL_TOPICS = new Set([
  '好',
  '好了',
  '好的',
  '行',
  '可以',
  '继续',
  '继续吧',
  '继续执行',
  '确认',
  '确认继续',
  '确认执行',
  '开始',
  '开始吧',
  '开始执行',
  '执行',
  '是的',
  '嗯',
  '收到',
  '明白',
  '下一步',
  '看看',
  '看下',
  '检查一下',
  '检查bug',
  '查bug',
  '修bug',
  '测试一下',
  '再试一次',
  '重试',
  'ok',
  'yes',
  'go',
  'run',
  'continue',
  'done',
]);

const WORKER_BOILERPLATE_RE = /^(?:你是|本轮任务|请严格按|Task\s*:|\*\*Task\*\*|You are\b)/i;

function normalizeForwardSlash(p) {
  return String(p || '').replace(/\\/g, '/').replace(/\/+$/, '');
}

function sleepMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getAddressPrefix(config = DEFAULT_CONFIG) {
  return String(config?.addressPrefix || '').trim();
}

export function getOfflineCacheLines(config = DEFAULT_CONFIG) {
  const pfx = getAddressPrefix(config);
  return {
    done: {
      emotionKey: String(config.doneEmotion || 'gentle'),
      text: `${pfx}反重力的任务已经完成了，你可以过来看看结果了。`,
    },
    error: {
      emotionKey: String(config.errorEmotion || 'serious'),
      text: `${pfx}反重力这边的任务刚刚遇到异常停下来了，你方便的时候过来检查一下吧。`,
    },
    limit: {
      emotionKey: String(config.limitEmotion || 'calm'),
      text: `${pfx}反重力任务已经告一段落停下来了，等你过来确认一下后续步骤。`,
    },
  };
}

export function loadConfig(pluginRoot = DEFAULT_PLUGIN_ROOT) {
  let fileCfg = {};
  for (const name of ['config.json', 'config.example.json']) {
    const cfgPath = path.join(pluginRoot, name);
    try {
      const raw = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
      if (raw && typeof raw === 'object') {
        fileCfg = raw;
        break;
      }
    } catch {
      // Try next fallback
    }
  }
  const merged = { ...DEFAULT_CONFIG, ...fileCfg };
  if (!merged.xiaozhiServerDir && process.env.XIAOZHI_SERVER_DIR) {
    merged.xiaozhiServerDir = process.env.XIAOZHI_SERVER_DIR;
  }
  return merged;
}

export function appendLog(pluginRoot, level, message) {
  try {
    const stateDir = path.join(pluginRoot, 'state');
    fs.mkdirSync(stateDir, { recursive: true });
    const logPath = path.join(stateDir, 'notifier.log');
    try {
      const st = fs.statSync(logPath);
      if (st.size > 256 * 1024) {
        const tail = fs.readFileSync(logPath, 'utf8').slice(-64 * 1024);
        fs.writeFileSync(logPath, tail, 'utf8');
      }
    } catch {
      // ignore if file doesn't exist yet
    }
    const ts = new Date().toISOString();
    fs.appendFileSync(logPath, `[${ts}] [${level}] ${message}\n`, 'utf8');
  } catch {
    // Never throw from logging
  }
}

function writeJsonAtomic(filePath, obj) {
  const raw = JSON.stringify(obj);
  const tmp = `${filePath}.${process.pid}.${crypto.randomBytes(2).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, raw, 'utf8');
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      fs.renameSync(tmp, filePath);
      return;
    } catch {
      // Windows concurrent reader may briefly hold file; retry
    }
  }
  try {
    fs.writeFileSync(filePath, raw, 'utf8');
  } finally {
    try {
      fs.unlinkSync(tmp);
    } catch {
      // ignore
    }
  }
}

export async function acquireWorkerLock(
  pluginRoot,
  { waitTimeoutMs = 15000, staleLockMs = 30000 } = {}
) {
  const stateDir = path.join(pluginRoot, 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  const lockPath = path.join(stateDir, 'worker.lock');
  const deadline = Date.now() + Math.max(200, waitTimeoutMs);

  while (Date.now() < deadline) {
    try {
      const fd = fs.openSync(lockPath, 'wx');
      try {
        fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, ts: Date.now() }), 'utf8');
      } finally {
        fs.closeSync(fd);
      }
      return () => {
        try {
          fs.unlinkSync(lockPath);
        } catch {
          // ignore
        }
      };
    } catch (err) {
      if (err?.code !== 'EEXIST') {
        return () => {};
      }
      try {
        const st = fs.statSync(lockPath);
        if (Date.now() - st.mtimeMs > staleLockMs) {
          fs.unlinkSync(lockPath);
          continue;
        }
      } catch {
        continue;
      }
      await sleepMs(80);
    }
  }
  return () => {};
}

export function resolveSummariesDbPath(payload = {}, config = {}) {
  if (config.conversationSummariesDbPath) {
    return String(config.conversationSummariesDbPath);
  }
  const tPath = String(payload?.transcriptPath || '').trim();
  if (tPath) {
    const norm = path.resolve(tPath);
    const parts = norm.split(path.sep);
    const brainIdx = parts.lastIndexOf('brain');
    if (brainIdx > 0) {
      const agRoot = parts.slice(0, brainIdx).join(path.sep);
      const cand = path.join(agRoot, 'conversation_summaries.db');
      if (fs.existsSync(cand)) {
        return cand;
      }
    }
  }
  return path.join(os.homedir(), '.gemini', 'antigravity', 'conversation_summaries.db');
}

export async function detectSubagentConversation(
  convId,
  payload = {},
  config = DEFAULT_CONFIG,
  { retryDelayMs = 120 } = {}
) {
  if (!convId || config.ignoreSubagents === false) {
    return { isSubagent: false, reason: '' };
  }

  const dbPath = resolveSummariesDbPath(payload, config);
  if (!fs.existsSync(dbPath)) {
    return { isSubagent: false, reason: 'db_missing' };
  }

  let DatabaseSync = null;
  try {
    ({ DatabaseSync } = await import('node:sqlite'));
  } catch {
    return { isSubagent: false, reason: 'sqlite_unavailable' };
  }

  const queryOnce = () => {
    const db = new DatabaseSync(dbPath, { readOnly: true, timeout: 1000 });
    try {
      const row = db
        .prepare(
          `SELECT cs.agent_name, cs.parent_conversation_id, cs.nesting_depth, cp.parent_id
           FROM conversation_summaries cs
           LEFT JOIN conversation_parents cp ON cp.conversation_id = cs.conversation_id
           WHERE cs.conversation_id = ?`
        )
        .get(convId);
      if (row) return row;
      const parentRow = db
        .prepare('SELECT parent_id FROM conversation_parents WHERE conversation_id = ?')
        .get(convId);
      if (parentRow && parentRow.parent_id) {
        return {
          agent_name: '',
          parent_conversation_id: '',
          nesting_depth: 1,
          parent_id: parentRow.parent_id,
        };
      }
      return null;
    } finally {
      db.close();
    }
  };

  let row = null;
  try {
    row = queryOnce();
    if (!row && retryDelayMs > 0) {
      await sleepMs(retryDelayMs);
      row = queryOnce();
    }
  } catch {
    return { isSubagent: false, reason: 'db_error' };
  }

  if (!row) {
    return { isSubagent: false, reason: 'not_found' };
  }

  const agentName = String(row.agent_name || '').trim();
  const parentConvId = String(row.parent_conversation_id || '').trim();
  const depth = Number(row.nesting_depth || 0);
  const cpParentId = String(row.parent_id || '').trim();

  if (agentName || parentConvId || depth > 0 || cpParentId) {
    return {
      isSubagent: true,
      reason: `agent=${agentName || '-'} parent=${(parentConvId || cpParentId || '-').slice(0, 8)} depth=${depth}`,
    };
  }
  return { isSubagent: false, reason: 'main' };
}

export function extractCleanTopic(rawInput) {
  if (!rawInput || typeof rawInput !== 'string') return '';
  const trimmedRaw = rawInput.trim();
  if (!trimmedRaw || WORKER_BOILERPLATE_RE.test(trimmedRaw)) {
    return '';
  }

  let text = trimmedRaw;
  text = text.replace(/```[\s\S]*?```/g, ' ');
  text = text.replace(/`[^`]*`/g, ' ');
  text = text.replace(/https?:\/\/\S+/gi, ' ');
  text = text.replace(/[A-Za-z]:\\[^\s"'`<>|]+/g, ' ');
  text = text.replace(/[A-Za-z]:\/[^\s"'`<>|]+/g, ' ');
  text = text.replace(/(?:^|\s)\/[a-zA-Z0-9_-]+/g, ' ');
  text = text.replace(/[\r\n\t]+/g, ' ');
  text = text.split(/[。！？!?；;]/)[0] || '';
  text = text.replace(/[^\u4e00-\u9fffA-Za-z0-9\s]/g, ' ');
  text = text.replace(/\s+/g, ' ').trim();

  if (!text) return '';
  const compactLower = text.replace(/\s+/g, '').toLowerCase();
  if (TRIVIAL_TOPICS.has(compactLower)) return '';

  let cjkClean = text
    .replace(/\b[A-Za-z0-9_]+\b/g, ' ')
    .replace(/\s+/g, '')
    .trim();

  if (TRIVIAL_TOPICS.has(cjkClean.toLowerCase())) return '';

  const cjkMatches = cjkClean.match(/[\u4e00-\u9fff]/g) || [];
  if (cjkMatches.length < 4) return '';

  cjkClean = cjkClean.replace(/^(?:请帮我|帮我|麻烦帮我|请先|请你|帮我把|我想让你|我想让小智|现在开始)/, '').trim();
  if (cjkClean.length < 4 || TRIVIAL_TOPICS.has(cjkClean.toLowerCase())) return '';

  let topic = cjkClean.slice(0, 12);
  topic = topic.replace(/[的了和与及在把将向对第这那其]+$/, '').trim();
  if (topic.length < 4 || TRIVIAL_TOPICS.has(topic.toLowerCase())) {
    return '';
  }
  return topic;
}

export function buildSpokenMessage(kind, payload = {}, config = DEFAULT_CONFIG) {
  const lines = getOfflineCacheLines(config);
  if (kind === 'error') {
    return lines.error;
  }
  if (kind === 'limit') {
    return lines.limit;
  }

  const pfx = getAddressPrefix(config);
  const emotionKey = String(config.doneEmotion || 'gentle');
  const topic = config.includeTaskTopic === false ? '' : extractCleanTopic(payload.lastUserInput);
  if (topic) {
    if (topic.endsWith('任务')) {
      return {
        emotionKey,
        text: `${pfx}反重力这边，${topic}已经完成了，你可以过来看看结果了。`,
      };
    }
    return {
      emotionKey,
      text: `${pfx}反重力这边，关于${topic}的任务已经完成了，你可以过来看看结果了。`,
    };
  }

  const convId = String(payload.conversationId || '');
  const idx = convId
    ? Math.abs(convId.split('').reduce((acc, ch) => (acc * 31 + ch.charCodeAt(0)) | 0, 0)) %
      GENERIC_DONE_TEMPLATES.length
    : 0;
  return {
    emotionKey,
    text: `${pfx}${GENERIC_DONE_TEMPLATES[idx]}`,
  };
}

export function resolveMeiProfile(emotionKey, config = DEFAULT_CONFIG) {
  const serverDir = normalizeForwardSlash(config.xiaozhiServerDir || process.env.XIAOZHI_SERVER_DIR || '');
  const voicesDir = serverDir ? `${serverDir}/voices` : 'voices';
  const emotionsJsonPath = serverDir
    ? path.join(serverDir, 'voices', 'raiden_mei', 'mei_emotions.json')
    : '';

  let catalog = null;
  if (emotionsJsonPath) {
    try {
      const parsed = JSON.parse(fs.readFileSync(emotionsJsonPath, 'utf8'));
      if (parsed && typeof parsed.emotions === 'object') {
        catalog = parsed.emotions;
      }
    } catch {
      catalog = null;
    }
  }

  const chosenKey =
    (catalog && catalog[emotionKey] && emotionKey) ||
    (MEI_EMOTION_FALLBACK[emotionKey] && emotionKey) ||
    'gentle';

  const rawProf = (catalog && catalog[chosenKey]) || MEI_EMOTION_FALLBACK[chosenKey];
  let refPath = String(rawProf.ref_audio_path || '');
  if (refPath.includes('${HOST_VOICES_DIR}')) {
    refPath = refPath.replace(/\$\{HOST_VOICES_DIR\}/g, voicesDir);
  } else if (refPath.includes('${HOST_DATA_DIR}')) {
    refPath = refPath.replace(/\$\{HOST_DATA_DIR\}/g, serverDir ? `${serverDir}/data` : 'data');
  } else if (serverDir && !/^[A-Za-z]:[\\/]/.test(refPath) && !refPath.startsWith('/')) {
    refPath = `${serverDir}/${refPath.replace(/^\/+/, '')}`;
  }

  return {
    emotionKey: chosenKey,
    ref_audio_path: normalizeForwardSlash(refPath),
    prompt_text: String(rawProf.prompt_text || MEI_EMOTION_FALLBACK.gentle.prompt_text),
    prompt_lang: String(rawProf.prompt_lang || 'zh'),
    speed_factor: Number(rawProf.speed_factor ?? 0.96),
    temperature: Number(rawProf.temperature ?? 0.95),
    top_k: Number(rawProf.top_k ?? 12),
    top_p: Number(rawProf.top_p ?? 0.98),
  };
}

export function buildGsvTtsPayload(text, emotionKey, config = DEFAULT_CONFIG) {
  const prof = resolveMeiProfile(emotionKey, config);
  const steps = Math.max(4, Math.min(32, Number(config.sampleSteps || 8)));
  return {
    text: String(text || '').slice(0, 120),
    text_lang: 'zh',
    ref_audio_path: prof.ref_audio_path,
    aux_ref_audio_paths: [],
    prompt_text: prof.prompt_text,
    prompt_lang: prof.prompt_lang,
    top_k: prof.top_k,
    top_p: prof.top_p,
    temperature: prof.temperature,
    text_split_method: 'cut0',
    batch_size: 1,
    speed_factor: prof.speed_factor,
    media_type: 'wav',
    streaming_mode: false,
    seed: -1,
    parallel_infer: true,
    repetition_penalty: 1.35,
    sample_steps: steps,
  };
}

function isValidWavBuffer(buf) {
  return (
    Buffer.isBuffer(buf) &&
    buf.length >= 44 &&
    buf.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buf.subarray(8, 12).toString('ascii') === 'WAVE'
  );
}

export async function synthesizeMeiWav(text, emotionKey, config, { fetchFn = fetch, timeoutMs = 20000 } = {}) {
  const baseUrl = String(config.gsvBaseUrl || DEFAULT_CONFIG.gsvBaseUrl).replace(/\/+$/, '');
  const body = buildGsvTtsPayload(text, emotionKey, config);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const resp = await fetchFn(`${baseUrl}/tts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!resp.ok) {
      throw new Error(`GSV /tts HTTP ${resp.status}`);
    }
    const arrBuf = await resp.arrayBuffer();
    const wavBuf = Buffer.from(arrBuf);
    if (!isValidWavBuffer(wavBuf)) {
      throw new Error(`GSV /tts returned invalid WAV (${wavBuf.length} bytes)`);
    }
    return wavBuf;
  } finally {
    clearTimeout(timer);
  }
}

export function readPcMcpToken(config = DEFAULT_CONFIG) {
  if (process.env.PC_MCP_TOKEN && process.env.PC_MCP_TOKEN.trim()) {
    return process.env.PC_MCP_TOKEN.trim();
  }
  const serverDir = config.xiaozhiServerDir || process.env.XIAOZHI_SERVER_DIR || '';
  if (!serverDir) return '';
  const candidates = [
    path.join(serverDir, 'secrets', 'pc_mcp_token.txt'),
    path.join(serverDir, 'data', 'pc_mcp_token.txt'),
  ];
  for (const fp of candidates) {
    try {
      const tok = fs.readFileSync(fp, 'utf8').trim();
      if (tok) return tok;
    } catch {
      // try next candidate
    }
  }
  return '';
}

export async function playViaPcAudioBridge(wavBuf, config, { fetchFn = fetch, turnId = '', timeoutMs = 4000 } = {}) {
  const tok = readPcMcpToken(config);
  if (!tok) {
    return { ok: false, reason: 'missing_pc_mcp_token' };
  }
  const baseUrl = String(config.pcMcpBaseUrl || DEFAULT_CONFIG.pcMcpBaseUrl).replace(/\/+$/, '');
  const vol = Math.max(0.1, Math.min(1.8, Number(config.volume ?? 1.0) || 1.0));
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const resp = await fetchFn(`${baseUrl}/audio/play`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${tok}`,
        'Content-Type': 'audio/wav',
        'X-Turn-Id': turnId || `agy-${Date.now()}`,
        'X-Volume': String(vol),
      },
      body: wavBuf,
      signal: ctrl.signal,
    });
    if (!resp.ok) {
      return { ok: false, reason: `http_${resp.status}` };
    }
    return { ok: true, via: 'pc_mcp_18900' };
  } catch (err) {
    return { ok: false, reason: String(err?.message || err) };
  } finally {
    clearTimeout(timer);
  }
}

export function playViaWindowsSoundPlayer(wavBuf, pluginRoot = DEFAULT_PLUGIN_ROOT) {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') {
      resolve({ ok: false, reason: 'non_windows' });
      return;
    }
    const stateDir = path.join(pluginRoot, 'state');
    fs.mkdirSync(stateDir, { recursive: true });
    const tmpWav = path.join(stateDir, `play_${process.pid}_${Date.now()}_${crypto.randomBytes(3).toString('hex')}.wav`);
    try {
      fs.writeFileSync(tmpWav, wavBuf);
    } catch (err) {
      resolve({ ok: false, reason: `write_tmp_failed: ${err?.message || err}` });
      return;
    }

    const psScript = `
$ErrorActionPreference = 'Stop'
$player = New-Object System.Media.SoundPlayer $env:AGY_MEI_WAV_PATH
try {
  $player.Load()
  $player.PlaySync()
} finally {
  $player.Dispose()
}
`.trim();

    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', psScript],
      {
        stdio: 'ignore',
        windowsHide: true,
        env: {
          ...process.env,
          AGY_MEI_WAV_PATH: tmpWav,
        },
      }
    );

    const cleanup = () => {
      try {
        fs.unlinkSync(tmpWav);
      } catch {
        // ignore
      }
    };

    const killTimer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        // ignore
      }
    }, 20000);
    killTimer.unref?.();

    child.on('exit', (code) => {
      clearTimeout(killTimer);
      cleanup();
      resolve(code === 0 ? { ok: true, via: 'windows_soundplayer' } : { ok: false, reason: `ps_exit_${code}` });
    });
    child.on('error', (err) => {
      clearTimeout(killTimer);
      cleanup();
      resolve({ ok: false, reason: `ps_spawn_error: ${err?.message || err}` });
    });
  });
}

export function showWindowsToastAsync(title, body, appId = DEFAULT_CONFIG.toastAppId) {
  if (process.platform !== 'win32') return;
  const psScript = `
$ErrorActionPreference = 'SilentlyContinue'
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null
$xml = New-Object Windows.Data.Xml.Dom.XmlDocument
$xml.LoadXml('<toast><visual><binding template="ToastGeneric"><text></text><text></text></binding></visual></toast>')
$nodes = $xml.GetElementsByTagName('text')
$nodes.Item(0).AppendChild($xml.CreateTextNode($env:AGY_MEI_TOAST_TITLE)) | Out-Null
$nodes.Item(1).AppendChild($xml.CreateTextNode($env:AGY_MEI_TOAST_BODY)) | Out-Null
$toast = [Windows.UI.Notifications.ToastNotification]::new($xml)
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($env:AGY_MEI_TOAST_APPID).Show($toast)
`.trim();
  try {
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', psScript],
      {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
        env: {
          ...process.env,
          AGY_MEI_TOAST_TITLE: String(title || ''),
          AGY_MEI_TOAST_BODY: String(body || ''),
          AGY_MEI_TOAST_APPID: String(appId || DEFAULT_CONFIG.toastAppId),
        },
      }
    );
    child.unref?.();
  } catch {
    // best-effort only
  }
}

export function shouldSkipAsDuplicate(pluginRoot, convId, kind, dedupeWindowMs) {
  const windowMs = Math.max(0, Number(dedupeWindowMs ?? 4000));
  if (windowMs <= 0 || !convId) return false;
  const stateDir = path.join(pluginRoot, 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  const dedupeFile = path.join(stateDir, 'last_notified.json');
  const now = Date.now();
  let state = {};
  try {
    state = JSON.parse(fs.readFileSync(dedupeFile, 'utf8')) || {};
  } catch {
    state = {};
  }
  const key = `${convId}:${kind}`;
  const prevTs = Number(state[key] || 0);
  if (prevTs > 0 && now - prevTs < windowMs) {
    return true;
  }
  const pruned = {};
  for (const [k, ts] of Object.entries(state)) {
    if (now - Number(ts) < Math.max(60000, windowMs * 4)) {
      pruned[k] = ts;
    }
  }
  pruned[key] = now;
  try {
    writeJsonAtomic(dedupeFile, pruned);
  } catch {
    // ignore
  }
  return false;
}

export function shouldThrottleToast(pluginRoot, toastCooldownMs) {
  const cooldown = Math.max(0, Number(toastCooldownMs ?? 60000));
  if (cooldown <= 0) return false;
  const stateDir = path.join(pluginRoot, 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  const toastFile = path.join(stateDir, 'last_toast.json');
  const now = Date.now();
  let prev = 0;
  try {
    prev = Number((JSON.parse(fs.readFileSync(toastFile, 'utf8')) || {}).ts || 0);
  } catch {
    prev = 0;
  }
  if (prev > 0 && now - prev < cooldown) {
    return true;
  }
  try {
    writeJsonAtomic(toastFile, { ts: now });
  } catch {
    // ignore
  }
  return false;
}

function getOfflineCachePath(pluginRoot, kind) {
  const safeKind = kind === 'error' || kind === 'limit' ? kind : 'done';
  return path.join(pluginRoot, 'cache', `fallback_${safeKind}.wav`);
}

export async function precacheOfflineMeiWavs(pluginRoot, config, { fetchFn = fetch } = {}) {
  const cacheDir = path.join(pluginRoot, 'cache');
  fs.mkdirSync(cacheDir, { recursive: true });
  const created = [];
  const specs = getOfflineCacheLines(config);
  for (const [kind, spec] of Object.entries(specs)) {
    const target = getOfflineCachePath(pluginRoot, kind);
    try {
      if (fs.existsSync(target) && fs.statSync(target).size >= 44) {
        continue;
      }
    } catch {
      // synthesize below
    }
    try {
      const wavBuf = await synthesizeMeiWav(spec.text, spec.emotionKey, config, {
        fetchFn,
        timeoutMs: 25000,
      });
      const tmp = `${target}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, wavBuf);
      fs.renameSync(tmp, target);
      created.push(kind);
    } catch (err) {
      appendLog(pluginRoot, 'WARN', `precache(${kind}) failed: ${err?.message || err}`);
      break;
    }
  }
  return created;
}

export async function handleNotificationJob(
  job,
  {
    pluginRoot = DEFAULT_PLUGIN_ROOT,
    fetchFn = fetch,
    playFallbackFn = playViaWindowsSoundPlayer,
    toastFn = showWindowsToastAsync,
    detectSubagentFn = detectSubagentConversation,
    skipDedupe = false,
  } = {}
) {
  const config = loadConfig(pluginRoot);
  if (config.enabled === false) {
    return { ok: false, skipped: 'disabled' };
  }

  const kind = String(job?.kind || 'done');
  const payload = job?.payload && typeof job.payload === 'object' ? job.payload : {};
  const convId = String(payload.conversationId || '');

  const subCheck = await detectSubagentFn(convId, payload, config);
  if (subCheck?.isSubagent) {
    appendLog(pluginRoot, 'INFO', `Skipped subagent/worker Stop conv=${convId} (${subCheck.reason})`);
    return { ok: true, skipped: 'subagent', reason: subCheck.reason };
  }

  const releaseLock = await acquireWorkerLock(pluginRoot);
  try {
    if (!skipDedupe && shouldSkipAsDuplicate(pluginRoot, convId, kind, config.dedupeWindowMs)) {
      appendLog(pluginRoot, 'INFO', `Skipped duplicate Stop notification for conv=${convId} kind=${kind}`);
      return { ok: true, skipped: 'duplicate' };
    }

    const { emotionKey, text } = buildSpokenMessage(kind, payload, config);
    let wavBuf = null;
    let source = 'live_gsv_19880';

    try {
      wavBuf = await synthesizeMeiWav(text, emotionKey, config, { fetchFn });
    } catch (err) {
      appendLog(
        pluginRoot,
        'WARN',
        `Live 19880 GPT-SoVITS synthesis unavailable (${err?.message || err}); checking offline cache`
      );
      const cachePath = getOfflineCachePath(pluginRoot, kind);
      try {
        const cached = fs.readFileSync(cachePath);
        if (isValidWavBuffer(cached)) {
          wavBuf = cached;
          source = 'offline_voice_cache';
        }
      } catch {
        wavBuf = null;
      }
    }

    if (!wavBuf) {
      appendLog(
        pluginRoot,
        'WARN',
        `No voice audio available (19880 offline & no offline cache yet) for text="${text}"`
      );
      if (config.toastWhenGsvOffline !== false && !shouldThrottleToast(pluginRoot, config.toastCooldownMs)) {
        toastFn(
          '小智·任务播报提醒',
          `${text}（19880 本地语音服务未启动，启动后将自动播报并缓存离线语音）`,
          config.toastAppId
        );
      }
      return { ok: false, reason: 'gsv_offline_no_cache', text, emotionKey };
    }

    let playRes = await playViaPcAudioBridge(wavBuf, config, {
      fetchFn,
      turnId: `agy-${kind}-${Date.now()}`,
    });
    if (!playRes.ok) {
      appendLog(pluginRoot, 'INFO', `18900 /audio/play unavailable (${playRes.reason}); using hidden Windows SoundPlayer`);
      playRes = await playFallbackFn(wavBuf, pluginRoot);
    }

    appendLog(
      pluginRoot,
      playRes.ok ? 'INFO' : 'ERROR',
      `Announced kind=${kind} emotion=${emotionKey} source=${source} via=${playRes.via || playRes.reason} text="${text}"`
    );

    if (source === 'live_gsv_19880' && config.autoPrecacheOfflineFallback !== false) {
      await precacheOfflineMeiWavs(pluginRoot, config, { fetchFn });
    }

    return { ok: playRes.ok, source, via: playRes.via || playRes.reason, text, emotionKey };
  } finally {
    releaseLock();
  }
}

function parseCliArgs(argv) {
  const args = { jobFile: '', testText: '', testKind: 'done', precache: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--job-file' && argv[i + 1]) {
      args.jobFile = argv[++i];
    } else if (a === '--test-text' && argv[i + 1]) {
      args.testText = argv[++i];
    } else if (a === '--kind' && argv[i + 1]) {
      args.testKind = argv[++i];
    } else if (a === '--precache') {
      args.precache = true;
    }
  }
  return args;
}

async function main() {
  const pluginRoot = process.env.XIAOZHI_NOTIFIER_PLUGIN_ROOT || DEFAULT_PLUGIN_ROOT;
  const cli = parseCliArgs(process.argv.slice(2));

  if (cli.precache) {
    const config = loadConfig(pluginRoot);
    const created = await precacheOfflineMeiWavs(pluginRoot, config);
    process.stdout.write(`${JSON.stringify({ ok: true, created })}\n`);
    return;
  }

  if (cli.testText) {
    const res = await handleNotificationJob(
      {
        kind: cli.testKind,
        payload: { conversationId: `manual-${Date.now()}`, lastUserInput: cli.testText },
      },
      {
        pluginRoot,
        skipDedupe: true,
        detectSubagentFn: async () => ({ isSubagent: false, reason: 'manual_test' }),
      }
    );
    process.stdout.write(`${JSON.stringify(res)}\n`);
    return;
  }

  if (!cli.jobFile) {
    return;
  }

  let job = null;
  try {
    job = JSON.parse(fs.readFileSync(cli.jobFile, 'utf8'));
  } catch (err) {
    appendLog(pluginRoot, 'ERROR', `Failed to read job file ${cli.jobFile}: ${err?.message || err}`);
    return;
  } finally {
    try {
      fs.unlinkSync(cli.jobFile);
    } catch {
      // ignore
    }
  }

  try {
    await handleNotificationJob(job, { pluginRoot });
  } catch (err) {
    appendLog(pluginRoot, 'ERROR', `Unhandled worker error: ${err?.message || err}`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  main();
}
