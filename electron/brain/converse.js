import { encodeWav } from './wav.js';
import { chat as chatOpenAI, chatStream as chatOpenAIStream, transcribe as transcribeOpenAI } from './openai.js';
import { synthesize, elevenLabsBlocked } from './elevenlabs.js';
import { chatOllama, chatOllamaStream } from './ollama.js';
import { chatGroq, chatGroqStream, transcribeGroq } from './groq.js';
import { createSpeechPipeline } from './kokoro.js';
import { cleanTranscript, stripEmoji, trimSilence } from './transcript.js';
import { runAgent } from '../agent/core.js';
import { pickBridgeLine, progressForTool } from './bridge.js';
import { classifyIntent, instantReply } from './intent.js';

/** @type {{ role: string, content: string }[]} */
let history = [];

function ttfaDeadlineMs() {
  const n = Number(process.env.TTS_TTFA_MS);
  return Number.isFinite(n) && n > 0 ? n : 1200;
}

function preferElevenLabs(opts) {
  const { elevenKey, ttsProvider } = opts;
  return (
    (ttsProvider === 'elevenlabs' || (ttsProvider === 'auto' && elevenKey)) &&
    !elevenLabsBlocked() &&
    Boolean(elevenKey)
  );
}

function useKokoroStream(opts) {
  const { ttsProvider } = opts;
  if (preferElevenLabs(opts)) return false;
  if (ttsProvider === 'local') return false;
  return ttsProvider === 'kokoro' || ttsProvider === 'auto';
}

/** Speak immediately via renderer system voice (no Kokoro wait). */
async function speakLocalNow(opts, text, kind = 'answer') {
  if (kind === 'bridge' && typeof opts.onBridge === 'function') {
    await opts.onBridge({ text, audio: null, mime: null, tts: 'local' });
  } else if (typeof opts.onSpeak === 'function') {
    await opts.onSpeak({ text, audio: null, mime: null, tts: 'local' });
  }
  return { audio: null, mime: null, tts: 'local', early: true, streamed: false };
}

/**
 * ElevenLabs (or local) non-streaming speak — used when Kokoro stream is off.
 * @param {Record<string, any>} opts
 * @param {string} reply
 */
async function speakReply(opts, reply) {
  const { elevenKey, voiceId, ttsModel } = opts;
  const t0 = Date.now();

  if (preferElevenLabs(opts)) {
    try {
      const audio = await synthesize({
        apiKey: elevenKey,
        voiceId,
        modelId: ttsModel,
        text: reply,
      });
      console.log(`[tts] elevenlabs ${Date.now() - t0}ms`);
      return { audio, mime: 'audio/mpeg', tts: 'elevenlabs' };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn('[tts] ElevenLabs failed — system voice:', message);
    }
  }

  return { audio: null, mime: null, tts: 'local' };
}

async function pushSpeak(opts, reply, spoken) {
  if (!spoken?.audio || typeof opts.onSpeak !== 'function') return false;
  try {
    await opts.onSpeak({
      text: reply,
      audio: spoken.audio,
      mime: spoken.mime,
      tts: spoken.tts,
    });
    return true;
  } catch (err) {
    console.warn('[tts] early speak push failed:', err instanceof Error ? err.message : err);
    return false;
  }
}

/**
 * @param {Record<string, any>} opts
 * @param {string} text
 * @param {'bridge'|'answer'} kind
 */
async function speakStreaming(opts, text, kind) {
  if (preferElevenLabs(opts)) {
    const spoken = await speakReply(opts, text);
    if (kind === 'bridge' && typeof opts.onBridge === 'function') {
      await opts.onBridge({
        text,
        audio: spoken.audio,
        mime: spoken.mime,
        tts: spoken.tts,
      });
      return spoken;
    }
    if (kind === 'answer') {
      const early = await pushSpeak(opts, text, spoken);
      return { ...spoken, early };
    }
    return spoken;
  }

  // Local / no Kokoro — speak immediately in the renderer.
  if (!useKokoroStream(opts)) {
    return speakLocalNow(opts, text, kind);
  }

  const deadline = ttfaDeadlineMs();
  let gotChunk = false;
  /** @type {(v?: any) => void} */
  let resolveFirst = () => {};
  const firstChunk = new Promise((resolve) => {
    resolveFirst = resolve;
  });

  const pipe = createSpeechPipeline({
    voice: opts.kokoroVoice || 'af_nova',
    speed: opts.kokoroSpeed || 1.12,
    isCancelled: opts.isCancelled,
    onChunk: (chunk) => {
      if (opts.isCancelled?.()) return;
      if (!gotChunk) {
        gotChunk = true;
        resolveFirst('audio');
      }
      opts.onTtsChunk?.({ ...chunk, kind });
    },
  });

  try {
    await pipe.pushText(text);
    const endP = pipe.end();
    const winner = await Promise.race([
      firstChunk,
      new Promise((r) => setTimeout(() => r('timeout'), deadline)),
    ]);

    if (winner === 'timeout' && !gotChunk) {
      pipe.cancel();
      console.warn(`[TTS] TTFA deadline ${deadline}ms — falling back to system voice`);
      void endP.catch(() => {});
      return speakLocalNow(opts, text, kind);
    }

    const result = await endP;
    if (kind === 'bridge' && typeof opts.onBridge === 'function') {
      await opts.onBridge({ text, audio: null, mime: null, tts: 'kokoro' });
    }
    if (result?.chunks > 0 || gotChunk) {
      return { audio: null, mime: 'audio/pcm', tts: 'kokoro', streamed: true, early: true };
    }
    return speakLocalNow(opts, text, kind);
  } catch (err) {
    console.warn('[TTS] speakStreaming failed:', err instanceof Error ? err.message : err);
    return speakLocalNow(opts, text, kind);
  }
}

/**
 * @param {Record<string, any>} opts
 */
export async function converse(opts) {
  const {
    pcm,
    sampleRate,
    userText: providedText,
    openaiKey,
    groqKey,
    chatModel,
    sttModel,
    brainProvider,
    sttProvider,
    ollamaUrl,
    ollamaModel,
    groqSttModel,
    groqChatModel,
    groqFastModel,
  } = opts;

  let userText = String(providedText ?? '').trim();

  if (!userText) {
    if (!pcm || !pcm.length) {
      return {
        ok: false,
        reason: 'empty-audio',
        error: 'No mic audio reached the brain.',
        userText: '',
        reply: '',
        audio: null,
        skipSpeak: true,
      };
    }
    const raw = pcm instanceof Float32Array ? pcm : new Float32Array(pcm);
    const trimmed = trimSilence(raw);
    const rate = sampleRate || 16000;
    const durationSec = trimmed.length / rate;
    if (durationSec < 0.35) {
      return {
        ok: false,
        reason: 'too-short',
        error: `Utterance too short (${durationSec.toFixed(2)}s) — kept listening.`,
        userText: '',
        reply: '',
        audio: null,
        skipSpeak: true,
      };
    }

    const wav = encodeWav(trimmed, rate);

    if (sttProvider === 'groq' || (!sttProvider && groqKey)) {
      if (!groqKey) throw new Error('Missing GROQ_API_KEY in .env');
      userText = await transcribeGroq({ apiKey: groqKey, model: groqSttModel, wav });
    } else if (sttProvider === 'openai' || openaiKey) {
      if (!openaiKey) throw new Error('Missing OPENAI_API_KEY in .env');
      userText = await transcribeOpenAI({ apiKey: openaiKey, model: sttModel, wav });
    } else {
      return {
        ok: false,
        reason: 'no-stt',
        error: 'No STT configured.',
        userText: '',
        reply: '',
        audio: null,
      };
    }
  }

  const cleaned = cleanTranscript(userText);
  if (!cleaned.ok) {
    return {
      ok: false,
      reason: cleaned.reason,
      error:
        cleaned.reason === 'whisper-hallucination'
          ? `Ignored junk transcript: "${userText}"`
          : `Did not catch real speech (${cleaned.reason}).`,
      userText: userText || '',
      reply: '',
      audio: null,
      skipSpeak: true,
    };
  }
  userText = cleaned.text;

  const intent = classifyIntent(userText);
  console.log('[intent]', intent, JSON.stringify(userText));
  opts.onProgress?.({ phase: intent, text: intent === 'tools' ? 'on it…' : intent === 'instant' ? '…' : 'thinking…' });

  const bridgeLine = intent === 'tools' ? pickBridgeLine(userText) : null;
  /** @type {Promise<any> | null} */
  let bridgePromise = null;
  if (bridgeLine && typeof opts.onBridge === 'function') {
    bridgePromise = (async () => {
      try {
        opts.onProgress?.({ phase: 'bridging', text: bridgeLine });
        await speakStreaming(opts, bridgeLine, 'bridge');
      } catch (err) {
        console.warn('[bridge] skipped:', err instanceof Error ? err.message : err);
      }
    })();
  }

  let reply;
  /** @type {number|undefined} */
  let toolCalls;
  const model = groqChatModel || 'openai/gpt-oss-20b';
  const fastModel = groqFastModel || 'openai/gpt-oss-20b';
  /** @type {{ audio: any, mime: any, tts: string, streamed?: boolean, early?: boolean, ttsNote?: string } | null} */
  let spoken = null;
  let streamedSpeak = false;

  const cancelled = () => Boolean(opts.isCancelled?.());

  /**
   * Stream LLM tokens into Kokoro as sentences complete.
   * Returns the speech pipeline so the caller can log the reply then drain TTS.
   * @param {(onToken: (t: string) => void) => Promise<{ reply: string, history: any[] }>} run
   */
  async function chatAndSpeak(run) {
    if (preferElevenLabs(opts) || !useKokoroStream(opts)) {
      const out = await run(() => {});
      reply = stripEmoji(out.reply);
      history = out.history;
      return null;
    }

    const deadline = ttfaDeadlineMs();
    let gotChunk = false;
    /** @type {(v?: any) => void} */
    let resolveFirst = () => {};
    const firstChunk = new Promise((resolve) => {
      resolveFirst = resolve;
    });

    const pipe = createSpeechPipeline({
      voice: opts.kokoroVoice || 'af_nova',
      speed: opts.kokoroSpeed || 1.12,
      isCancelled: opts.isCancelled,
      onChunk: (chunk) => {
        if (opts.isCancelled?.()) return;
        if (!gotChunk) {
          gotChunk = true;
          resolveFirst('audio');
        }
        opts.onTtsChunk?.({ ...chunk, kind: 'answer' });
      },
    });

    let acc = '';
    try {
      const out = await run((token) => {
        if (cancelled()) return;
        const clean = stripEmoji(token);
        if (!clean) return;
        acc += clean;
        if (acc.trim().length > 2) {
          opts.onProgress?.({ phase: 'answering', text: acc.trim() });
        }
        void pipe.push(clean);
      });
      reply = stripEmoji(out.reply);
      history = out.history;
      if (!acc && reply) {
        await pipe.pushText(reply).catch((err) => {
          console.warn('[TTS] push failed:', err instanceof Error ? err.message : err);
        });
      }

      const endP = pipe.end();
      // Don't block the conversation for slow CPU Kokoro — fall back fast.
      const winner = await Promise.race([
        firstChunk,
        new Promise((r) => setTimeout(() => r('timeout'), deadline)),
        endP.then((r) => (r?.chunks > 0 ? 'audio' : 'empty')),
      ]);

      if ((winner === 'timeout' || winner === 'empty') && !gotChunk) {
        pipe.cancel();
        console.warn(`[TTS] TTFA deadline ${deadline}ms during chat — system voice`);
        void endP.catch(() => {});
        return null; // caller will speakLocalNow
      }

      const result = await endP;
      if (result?.chunks > 0 || gotChunk) {
        streamedSpeak = true;
        spoken = { audio: null, mime: 'audio/pcm', tts: 'kokoro', streamed: true, early: true };
      }
      return null;
    } catch (err) {
      pipe.cancel();
      throw err;
    }
  }

  if (brainProvider === 'groq') {
    if (!groqKey) throw new Error('Missing GROQ_API_KEY in .env');

    if (intent === 'instant') {
      reply = instantReply(userText) || 'Hey.';
      history = [
        ...history,
        { role: 'user', content: userText },
        { role: 'assistant', content: reply },
      ];
      if (history.length > 12) history = history.slice(-12);
      console.log('[reply] instant', JSON.stringify(reply));
    } else if (intent === 'chat') {
      // Local TTS does not need token streaming — non-stream chat is more reliable.
      if (!useKokoroStream(opts) && !preferElevenLabs(opts)) {
        try {
          const out = await chatGroq({
            apiKey: groqKey,
            model: fastModel,
            userText,
            history,
          });
          reply = stripEmoji(out.reply);
          history = out.history;
        } catch (err) {
          console.warn('[chat] fast model failed, trying main:', err instanceof Error ? err.message : err);
          try {
            const out = await chatGroq({ apiKey: groqKey, model, userText, history });
            reply = stripEmoji(out.reply);
            history = out.history;
          } catch (err2) {
            console.error('[chat] both models failed:', err2 instanceof Error ? err2.message : err2);
            reply = 'I am having trouble thinking right now. Try again in a moment.';
          }
        }
        console.log('[reply] chat', JSON.stringify(reply));
      } else {
      try {
        await chatAndSpeak((onToken) =>
          chatGroqStream({
            apiKey: groqKey,
            model: fastModel,
            userText,
            history,
            onToken,
            isCancelled: opts.isCancelled,
          }),
        );
        console.log('[reply] chat', JSON.stringify(reply));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (/kokoro|tts|warm timed out/i.test(message)) {
          console.warn('[TTS] did not fail the chat reply:', message);
        } else {
          console.warn('[chat] fast stream failed, trying main model:', message);
          try {
            await chatAndSpeak((onToken) =>
              chatGroqStream({
                apiKey: groqKey,
                model,
                userText,
                history,
                onToken,
                isCancelled: opts.isCancelled,
              }),
            );
            console.log('[reply] chat', JSON.stringify(reply));
          } catch (err2) {
            console.error('[chat] both models failed:', err2 instanceof Error ? err2.message : err2);
            try {
              const out = await chatGroq({ apiKey: groqKey, model: fastModel, userText, history });
              reply = stripEmoji(out.reply);
              history = out.history;
            } catch {
              reply = 'I am having trouble thinking right now. Try again in a moment.';
            }
            console.log('[reply] chat', JSON.stringify(reply));
          }
        }
      }
      }
    } else {
      try {
        const agent = await runAgent({
          apiKey: groqKey,
          model,
          userText,
          history,
          onTool: ({ name }) => {
            opts.onProgress?.({ phase: 'tool', text: progressForTool(name), tool: name });
          },
          onArtifact: opts.onArtifact,
        });
        if (agent.reply) {
          reply = stripEmoji(agent.reply);
          history = agent.history;
          toolCalls = agent.toolCalls;
        } else {
          const out = await chatGroq({ apiKey: groqKey, model: fastModel, userText, history });
          reply = stripEmoji(out.reply);
          history = out.history;
        }
      } catch (err) {
        console.warn('[agent] falling back to plain chat:', err instanceof Error ? err.message : err);
        const out = await chatGroq({ apiKey: groqKey, model: fastModel, userText, history });
        reply = stripEmoji(out.reply);
        history = out.history;
      }
    }
  } else if (brainProvider === 'openai') {
    if (!openaiKey) throw new Error('Missing OPENAI_API_KEY in .env');
    if (intent === 'instant') {
      reply = instantReply(userText) || 'Hey.';
      console.log('[reply] instant', JSON.stringify(reply));
    } else if (intent === 'chat') {
      try {
        await chatAndSpeak((onToken) =>
          chatOpenAIStream({
            apiKey: openaiKey,
            model: chatModel,
            userText,
            history,
            onToken,
            isCancelled: opts.isCancelled,
          }),
        );
      } catch (err) {
        console.warn('[chat] openai stream failed:', err instanceof Error ? err.message : err);
        const out = await chatOpenAI({ apiKey: openaiKey, model: chatModel, userText, history });
        reply = stripEmoji(out.reply);
        history = out.history;
      }
    }
  } else {
    if (intent === 'instant') {
      reply = instantReply(userText) || 'Hey.';
      console.log('[reply] instant', JSON.stringify(reply));
    } else if (intent === 'chat') {
      try {
        await chatAndSpeak((onToken) =>
          chatOllamaStream({
            baseUrl: ollamaUrl,
            model: ollamaModel,
            userText,
            history,
            onToken,
            isCancelled: opts.isCancelled,
          }),
        );
      } catch (err) {
        console.warn('[chat] ollama stream failed:', err instanceof Error ? err.message : err);
        const out = await chatOllama({
          baseUrl: ollamaUrl,
          model: ollamaModel,
          userText,
          history,
        });
        reply = stripEmoji(out.reply);
        history = out.history;
      }
    }
  }

  if (cancelled()) {
    opts.onTtsEnd?.();
    return {
      ok: true,
      userText,
      reply: reply || '',
      intent,
      audio: null,
      mime: null,
      tts: 'kokoro',
      skipSpeak: true,
      spokeEarly: true,
      streamed: true,
      toolCalls,
    };
  }

  if (bridgePromise) {
    opts.onProgress?.({ phase: 'answering', text: reply });
    await bridgePromise.catch(() => {});
    if (cancelled()) {
      opts.onTtsEnd?.();
      return {
        ok: true,
        userText,
        reply,
        intent,
        bridge: bridgeLine || undefined,
        audio: null,
        skipSpeak: true,
        toolCalls,
      };
    }
    if (!streamedSpeak) {
      try {
        spoken = await speakStreaming(opts, reply, 'answer');
      } catch (err) {
        console.warn('[TTS] final speak failed:', err instanceof Error ? err.message : err);
        spoken = { audio: null, mime: null, tts: 'local', ttsNote: 'Kokoro failed — system voice' };
      }
    }
    opts.onTtsEnd?.();
    return {
      ok: true,
      userText,
      reply,
      intent,
      bridge: bridgeLine || undefined,
      audio: spoken?.early || spoken?.streamed ? null : spoken?.audio ?? null,
      mime: spoken?.early || spoken?.streamed ? null : spoken?.mime ?? null,
      tts: spoken?.tts,
      ttsNote: spoken?.ttsNote,
      spokeEarly: Boolean(spoken?.early || spoken?.streamed),
      streamed: Boolean(spoken?.streamed),
      toolCalls,
    };
  }

  opts.onProgress?.({ phase: 'answering', text: reply });
  if (!streamedSpeak) {
    try {
      spoken = await speakStreaming(opts, reply, 'answer');
    } catch (err) {
      console.warn('[TTS] final speak failed:', err instanceof Error ? err.message : err);
      spoken = { audio: null, mime: null, tts: 'local', ttsNote: 'Kokoro failed — system voice' };
    }
  }
  opts.onTtsEnd?.();

  return {
    ok: true,
    userText,
    reply,
    intent,
    bridge: bridgeLine || undefined,
    audio: spoken?.early || spoken?.streamed ? null : spoken?.audio ?? null,
    mime: spoken?.early || spoken?.streamed ? null : spoken?.mime ?? null,
    tts: spoken?.tts || (streamedSpeak ? 'kokoro' : undefined),
    ttsNote: spoken?.ttsNote,
    spokeEarly: Boolean(spoken?.early || spoken?.streamed || streamedSpeak),
    streamed: Boolean(spoken?.streamed || streamedSpeak),
    toolCalls,
  };
}

export function resetConversation() {
  history = [];
}
