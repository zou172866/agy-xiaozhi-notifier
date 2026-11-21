import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { classifyStopEvent, dispatchStopPayload } from '../hooks/on-stop.mjs';
import {
  acquireWorkerLock,
  buildGsvTtsPayload,
  buildSpokenMessage,
  detectSubagentConversation,
  extractCleanTopic,
  handleNotificationJob,
  resolveMeiProfile,
} from '../hooks/speak-worker.mjs';

function makeSilentWav(durationSec = 0.05, sampleRate = 24000) {
  const numSamples = Math.max(1, Math.floor(durationSec * sampleRate));
  const dataSize = numSamples * 2;
  const buf = Buffer.alloc(44 + dataSize);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(dataSize, 40);
  return buf;
}

test('classifyStopEvent filters USER_CANCELED and non-idle while accepting done/error/limit', () => {
  assert.equal(classifyStopEvent({ terminationReason: 'NO_TOOL_CALL', fullyIdle: true }).kind, 'done');
  assert.equal(classifyStopEvent({ terminationReason: 'NO_TOOL_CALL', fullyIdle: false }).shouldNotify, false);
  assert.equal(classifyStopEvent({ terminationReason: 'USER_CANCELED', fullyIdle: true }).shouldNotify, false);
  assert.equal(classifyStopEvent({ terminationReason: 'ERROR', fullyIdle: true }).kind, 'error');
  assert.equal(classifyStopEvent({ terminationReason: 'MAX_INVOCATIONS', fullyIdle: true }).kind, 'limit');
  assert.equal(
    classifyStopEvent({ terminationReason: 'NO_TOOL_CALL', fullyIdle: true }, { enabled: false }).shouldNotify,
    false
  );
});

test('extractCleanTopic filters trivial/boilerplate prompts and avoids half-word/number truncation', () => {
  assert.equal(extractCleanTopic('好了'), '');
  assert.equal(extractCleanTopic('确认继续'), '');
  assert.equal(extractCleanTopic('检查bug'), '');
  assert.equal(extractCleanTopic('你是课程逐字稿多轮复用精修 Worker。你会按顺序连续接收'), '');
  assert.equal(extractCleanTopic('本轮任务：请精修课次 101 第 02 段'), '');
  assert.equal(extractCleanTopic('/boost 修复云端测试失败问题'), '修复云端测试失败问题');
  assert.equal(
    extractCleanTopic('帮我检查 C:\\mock\\xiaozhi-server\\app\\boot.py 里的启动逻辑'),
    '检查里的启动逻辑'
  );
  assert.equal(extractCleanTopic('fix bug in app.js'), '');
});

test('buildSpokenMessage respects addressPrefix concisely without 反重力 boilerplate', () => {
  const m1 = buildSpokenMessage(
    'done',
    { lastUserInput: '监控反重力的任务', conversationId: 'c1' },
    { doneEmotion: 'gentle', includeTaskTopic: true, addressPrefix: '' }
  );
  assert.equal(m1.emotionKey, 'gentle');
  assert.equal(m1.text, '监控反重力的任务完成了。');

  const m2 = buildSpokenMessage(
    'done',
    { lastUserInput: '帮我修复登录接口', conversationId: 'c2' },
    { doneEmotion: 'gentle', includeTaskTopic: true, addressPrefix: '哥哥，' }
  );
  assert.equal(m2.text, '哥哥，关于修复登录接口的任务完成了。');

  const m2b = buildSpokenMessage(
    'done',
    { lastUserInput: '关于部署脚本调整', conversationId: 'c2b' },
    { doneEmotion: 'gentle', includeTaskTopic: true, addressPrefix: '' }
  );
  assert.equal(m2b.text, '关于部署脚本调整的任务完成了。');

  const m3 = buildSpokenMessage(
    'done',
    { lastUserInput: '确认继续', conversationId: 'c3' },
    { doneEmotion: 'gentle', includeTaskTopic: true, addressPrefix: '' }
  );
  assert.doesNotMatch(m3.text, /反重力|确认继续|看看结果/);

  const m4 = buildSpokenMessage(
    'error',
    { lastUserInput: '随便', conversationId: 'c4' },
    { errorEmotion: 'serious', includeTaskTopic: true, addressPrefix: '' }
  );
  assert.equal(m4.emotionKey, 'serious');
  assert.equal(m4.text, '刚才的任务遇到异常停下来了。');
  assert.doesNotMatch(m4.text, /反重力/);

  const m4b = buildSpokenMessage(
    'error',
    { lastUserInput: '帮我修复登录接口', conversationId: 'c4b' },
    { errorEmotion: 'serious', includeTaskTopic: true, addressPrefix: '哥哥，' }
  );
  assert.equal(m4b.text, '哥哥，关于修复登录接口的任务遇到异常停下来了。');

  const m5 = buildSpokenMessage(
    'limit',
    { lastUserInput: '随便', conversationId: 'c5' },
    { limitEmotion: 'calm', includeTaskTopic: true, addressPrefix: '哥哥，' }
  );
  assert.equal(m5.emotionKey, 'calm');
  assert.equal(m5.text, '哥哥，刚才的任务告一段落了。');
  assert.doesNotMatch(m5.text, /反重力/);

  const m5b = buildSpokenMessage(
    'limit',
    { lastUserInput: '帮我修复登录接口', conversationId: 'c5b' },
    { limitEmotion: 'calm', includeTaskTopic: true, addressPrefix: '' }
  );
  assert.equal(m5b.text, '关于修复登录接口的任务告一段落了。');
});

test('detectSubagentConversation distinguishes main conversations from workflow workers and subagents', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xz-notify-db-'));
  const dbPath = path.join(tmpDir, 'conversation_summaries.db');
  const db = new DatabaseSync(dbPath);
  try {
    db.exec(`
      CREATE TABLE conversation_summaries (
        conversation_id TEXT PRIMARY KEY,
        agent_name TEXT NOT NULL DEFAULT '',
        parent_conversation_id TEXT NOT NULL DEFAULT '',
        nesting_depth INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE conversation_parents (
        conversation_id TEXT PRIMARY KEY,
        parent_id TEXT NOT NULL
      );
      INSERT INTO conversation_summaries VALUES ('main-1', '', '', 0);
      INSERT INTO conversation_summaries VALUES ('worker-1', 'self', '', 0);
      INSERT INTO conversation_summaries VALUES ('sub-1', 'DeepCoder', 'main-1', 1);
      INSERT INTO conversation_parents VALUES ('child-only', 'main-1');
    `);
    db.close();

    const cfg = { ignoreSubagents: true, conversationSummariesDbPath: dbPath };
    assert.equal((await detectSubagentConversation('main-1', {}, cfg, { retryDelayMs: 0 })).isSubagent, false);
    assert.equal((await detectSubagentConversation('worker-1', {}, cfg, { retryDelayMs: 0 })).isSubagent, true);
    assert.equal((await detectSubagentConversation('sub-1', {}, cfg, { retryDelayMs: 0 })).isSubagent, true);
    assert.equal((await detectSubagentConversation('child-only', {}, cfg, { retryDelayMs: 0 })).isSubagent, true);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('resolveMeiProfile and buildGsvTtsPayload match GPT-SoVITS TTS_Request schema', () => {
  const prof = resolveMeiProfile('gentle', { xiaozhiServerDir: 'C:/mock/xiaozhi-server' });
  assert.match(prof.ref_audio_path, /\/voices\/raiden_mei\/mei_gentle_ref\.wav$/);
  const body = buildGsvTtsPayload('任务完成了', 'gentle', {
    xiaozhiServerDir: 'C:/mock/xiaozhi-server',
    sampleSteps: 8,
  });
  assert.equal(body.text_lang, 'zh');
  assert.equal(body.text_split_method, 'cut0');
  assert.equal(body.media_type, 'wav');
  assert.equal('return_fragment' in body, false);
  assert.equal(body.sample_steps, 8);
  assert.equal(body.parallel_infer, true);
});

test('dispatchStopPayload writes temp job file and spawns hidden detached worker with --no-warnings', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xz-notify-dispatch-'));
  try {
    fs.writeFileSync(path.join(tmpRoot, 'config.json'), JSON.stringify({ enabled: true }), 'utf8');
    const calls = [];
    const fakeSpawn = (exe, args, opts) => {
      calls.push({ exe, args, opts });
      return { unref() {} };
    };
    const res = dispatchStopPayload(
      { conversationId: 'conv-1', terminationReason: 'NO_TOOL_CALL', fullyIdle: true, lastUserInput: '整理部署文档' },
      { pluginRoot: tmpRoot, spawnFn: fakeSpawn }
    );
    assert.equal(res.dispatched, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].args[0], '--no-warnings');
    assert.equal(calls[0].opts.detached, true);
    assert.equal(calls[0].opts.windowsHide, true);
    assert.ok(fs.existsSync(res.payloadFile));
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('acquireWorkerLock recovers stale locks and serializes concurrent workers', async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xz-notify-lock-'));
  try {
    const stateDir = path.join(tmpRoot, 'state');
    fs.mkdirSync(stateDir, { recursive: true });
    const lockPath = path.join(stateDir, 'worker.lock');
    fs.writeFileSync(lockPath, '{"pid":999999,"ts":0}', 'utf8');
    const oldTime = new Date(Date.now() - 60000);
    fs.utimesSync(lockPath, oldTime, oldTime);

    const release = await acquireWorkerLock(tmpRoot, { waitTimeoutMs: 1000, staleLockMs: 5000 });
    assert.ok(fs.existsSync(lockPath));
    release();
    assert.equal(fs.existsSync(lockPath), false);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('handleNotificationJob skips subagents, throttles offline toasts, synthesizes via 19880, and falls back to offline cache', async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xz-notify-worker-'));
  const fakeServerDir = path.join(tmpRoot, 'fake-xiaozhi');
  fs.mkdirSync(path.join(fakeServerDir, 'secrets'), { recursive: true });
  fs.writeFileSync(path.join(fakeServerDir, 'secrets', 'pc_mcp_token.txt'), 'test-secret-tok\n', 'utf8');
  fs.writeFileSync(
    path.join(tmpRoot, 'config.json'),
    JSON.stringify({
      enabled: true,
      ignoreSubagents: true,
      xiaozhiServerDir: fakeServerDir.replace(/\\/g, '/'),
      gsvBaseUrl: 'http://127.0.0.1:19880',
      pcMcpBaseUrl: 'http://127.0.0.1:18900',
      dedupeWindowMs: 4000,
      toastCooldownMs: 60000,
      toastAppId: 'electron.app.Antigravity',
      autoPrecacheOfflineFallback: true,
    }),
    'utf8'
  );

  const wav = makeSilentWav();
  const onlineFetch = async (url, opts) => {
    if (url.endsWith('/tts')) {
      return {
        ok: true,
        status: 200,
        arrayBuffer: async () => wav.buffer.slice(wav.byteOffset, wav.byteOffset + wav.byteLength),
      };
    }
    if (url.endsWith('/audio/play')) {
      assert.equal(opts.headers.Authorization, 'Bearer test-secret-tok');
      return { ok: true, status: 200 };
    }
    throw new Error(`Unexpected URL: ${url}`);
  };
  const offlineFetch = async () => {
    throw new Error('ECONNREFUSED');
  };

  try {
    // 0. Subagent is skipped silently
    const rSub = await handleNotificationJob(
      { kind: 'done', payload: { conversationId: 'sub-worker', lastUserInput: '切片精修' } },
      {
        pluginRoot: tmpRoot,
        fetchFn: onlineFetch,
        detectSubagentFn: async () => ({ isSubagent: true, reason: 'agent=self' }),
      }
    );
    assert.equal(rSub.skipped, 'subagent');

    // 1. Offline before cache exists: sends 1 toast with registered AUMID, throttles 2nd toast
    const toasts = [];
    const rOff1 = await handleNotificationJob(
      { kind: 'done', payload: { conversationId: 'conv-off-1', lastUserInput: '整理报告' } },
      {
        pluginRoot: tmpRoot,
        fetchFn: offlineFetch,
        detectSubagentFn: async () => ({ isSubagent: false }),
        toastFn: (title, body, appId) => toasts.push({ title, body, appId }),
      }
    );
    assert.equal(rOff1.reason, 'gsv_offline_no_cache');
    assert.equal(toasts.length, 1);
    assert.equal(toasts[0].appId, 'electron.app.Antigravity');

    const rOff2 = await handleNotificationJob(
      { kind: 'done', payload: { conversationId: 'conv-off-2', lastUserInput: '整理报告' } },
      {
        pluginRoot: tmpRoot,
        fetchFn: offlineFetch,
        detectSubagentFn: async () => ({ isSubagent: false }),
        toastFn: (title, body, appId) => toasts.push({ title, body, appId }),
      }
    );
    assert.equal(rOff2.reason, 'gsv_offline_no_cache');
    assert.equal(toasts.length, 1, 'Second offline toast within cooldown should be throttled');

    // 2. Online path: synthesizes live + plays via 18900 + auto-precaches 3 offline WAVs
    const r1 = await handleNotificationJob(
      { kind: 'done', payload: { conversationId: 'conv-live', lastUserInput: '检查构建结果' } },
      {
        pluginRoot: tmpRoot,
        fetchFn: onlineFetch,
        detectSubagentFn: async () => ({ isSubagent: false }),
      }
    );
    assert.equal(r1.ok, true);
    assert.equal(r1.source, 'live_gsv_19880');
    assert.equal(r1.via, 'pc_mcp_18900');
    assert.ok(fs.existsSync(path.join(tmpRoot, 'cache', 'fallback_done.wav')));
    assert.ok(fs.existsSync(path.join(tmpRoot, 'cache', 'fallback_error.wav')));
    assert.ok(fs.existsSync(path.join(tmpRoot, 'cache', 'fallback_limit.wav')));

    // 3. Duplicate within 4s window is skipped cleanly
    const rDup = await handleNotificationJob(
      { kind: 'done', payload: { conversationId: 'conv-live', lastUserInput: '检查构建结果' } },
      {
        pluginRoot: tmpRoot,
        fetchFn: onlineFetch,
        detectSubagentFn: async () => ({ isSubagent: false }),
      }
    );
    assert.equal(rDup.skipped, 'duplicate');

    // 4. Offline 19880 + offline 18900 AFTER cache exists: plays cached WAV via local SoundPlayer
    let fallbackPlayedBytes = 0;
    const rOffline = await handleNotificationJob(
      { kind: 'done', payload: { conversationId: 'conv-offline-3', lastUserInput: '检查构建结果' } },
      {
        pluginRoot: tmpRoot,
        fetchFn: offlineFetch,
        detectSubagentFn: async () => ({ isSubagent: false }),
        playFallbackFn: async (buf) => {
          fallbackPlayedBytes = buf.length;
          return { ok: true, via: 'windows_soundplayer' };
        },
      }
    );
    assert.equal(rOffline.ok, true);
    assert.equal(rOffline.source, 'offline_voice_cache');
    assert.equal(rOffline.via, 'windows_soundplayer');
    assert.equal(fallbackPlayedBytes, wav.length);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});
