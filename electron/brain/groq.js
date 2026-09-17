/**
 * Groq cloud: Whisper ears + Llama (etc.) brain.
 * Free tier key: https://console.groq.com
 *
 * Electron's Node `fetch` + FormData(File/Blob) often throws a bare "fetch failed".
 * Whisper uploads are built as a raw multipart Buffer instead, which is reliable
 * in both Node and Electron main.
 */

import { buildNovaInstructions } from './novaMind.js';

/** @type {{ fetch?: typeof fetch } | null} */
let electronNet = null;
try {
  const mod = await import('electron');
  electronNet = mod.net ?? null;
} catch {
  electronNet = null;
}

/**
 * Peel a spoken answer out of an empty-content / reasoning-only message.
 * @param {any} message
 * @param {any} data
 */
function extractReply(message, data) {
  let reply = String(message?.content ?? '').trim();
  if (!reply && message?.reasoning_content) {
    reply = String(message.reasoning_content)
      .replace(/^[\s\S]*?(?:final answer[:\s]*|answer[:\s]*)/i, '')
      .trim();
    if (!reply || reply.length > 280) {
      const lines = String(message.reasoning_content)
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean);
      reply = lines[lines.length - 1] ?? '';
    }
  }
  if (!reply) {
    const finish = data?.choices?.[0]?.finish_reason ?? '?';
    const reasoning = data?.usage?.completion_tokens_details?.reasoning_tokens;
    throw new Error(
      `Groq chat returned an empty reply (finish=${finish}` +
        (reasoning != null ? `, reasoning_tokens=${reasoning}` : '') +
        ').',
    );
  }
  return reply;
}

/**
 * Chromium network stack when available (Electron main), else Node fetch.
 * @param {string} url
 * @param {RequestInit} init
 */
async function http(url, init) {
  if (typeof electronNet?.fetch === 'function') {
    return electronNet.fetch(url, init);
  }
  return fetch(url, init);
}

/**
 * @param {Record<string, string>} fields
 * @param {ArrayBuffer | Uint8Array} fileBytes
 * @param {string} filename
 * @param {string} mime
 */
function multipartBody(fields, fileBytes, filename, mime) {
  const boundary = `----NovaBoundary${Date.now().toString(16)}`;
  const chunks = [];

  for (const [name, value] of Object.entries(fields)) {
    chunks.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
        'utf8',
      ),
    );
  }

  chunks.push(
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${mime}\r\n\r\n`,
      'utf8',
    ),
  );
  chunks.push(Buffer.from(fileBytes instanceof ArrayBuffer ? new Uint8Array(fileBytes) : fileBytes));
  chunks.push(Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8'));

  return {
    body: new Uint8Array(Buffer.concat(chunks)),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

function networkWhy(err) {
  if (!(err instanceof Error)) return String(err);
  const cause = err.cause && typeof err.cause === 'object' ? err.cause : null;
  const code = cause && 'code' in cause ? String(cause.code) : '';
  const detail = cause && 'message' in cause ? String(cause.message) : '';
  return [err.message, code, detail].filter(Boolean).join(' | ');
}

/**
 * @param {{ apiKey: string, model: string, wav: ArrayBuffer }} opts
 */
export async function transcribeGroq({ apiKey, model, wav }) {
  const { body, contentType } = multipartBody(
    {
      model,
      response_format: 'json',
      language: 'en',
      temperature: '0',
    },
    wav,
    'utterance.wav',
    'audio/wav',
  );

  let res;
  try {
    res = await http('https://api.groq.com/openai/v1/audio/transcriptions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': contentType,
        Accept: 'application/json',
      },
      body,
    });
  } catch (err) {
    throw new Error(`Groq Whisper network error (${networkWhy(err)}).`);
  }
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Groq Whisper ${res.status}: ${text.slice(0, 240)}`);
  }
  const data = await res.json();
  return String(data.text ?? '').trim();
}

/**
 * @param {{ apiKey: string, model: string, userText: string, history: {role:string,content:string}[] }} opts
 */
export async function chatGroq({ apiKey, model, userText, history }) {
  const messages = [
    { role: 'system', content: buildNovaInstructions() },
    ...history,
    { role: 'user', content: userText },
  ];

  // gpt-oss models "think" inside the completion budget. A small max_tokens
  // gets eaten by reasoning and returns content:"" with finish_reason:length.
  const isReasoningModel = /gpt-oss|o1|o3|reason/i.test(model);
  const body = {
    model,
    temperature: 0.7,
    messages,
    ...(isReasoningModel
      ? {
          max_completion_tokens: 768,
          reasoning_effort: 'low',
        }
      : {
          max_tokens: 120,
        }),
  };

  let res;
  try {
    res = await http('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    throw new Error(`Groq chat network error (${networkWhy(err)}).`);
  }
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Groq chat ${res.status} (${model}): ${text.slice(0, 240)}`);
  }
  const data = await res.json();
  const message = data.choices?.[0]?.message ?? {};
  const reply = extractReply(message, data);

  const next = [...history, { role: 'user', content: userText }, { role: 'assistant', content: reply }];
  return { reply, history: next.length > 12 ? next.slice(-12) : next };
}

/**
 * Stream Groq chat tokens as they arrive. `onToken` receives spoken content only
 * (reasoning deltas are ignored).
 *
 * @param {{
 *   apiKey: string,
 *   model: string,
 *   userText: string,
 *   history: {role:string,content:string}[],
 *   onToken?: (token: string) => void,
 *   isCancelled?: () => boolean,
 * }} opts
 */
export async function chatGroqStream({ apiKey, model, userText, history, onToken, isCancelled }) {
  const messages = [
    { role: 'system', content: buildNovaInstructions() },
    ...history,
    { role: 'user', content: userText },
  ];

  const isReasoningModel = /gpt-oss|o1|o3|reason/i.test(model);
  const body = {
    model,
    temperature: 0.7,
    stream: true,
    messages,
    ...(isReasoningModel
      ? {
          max_completion_tokens: 768,
          reasoning_effort: 'low',
        }
      : {
          max_tokens: 120,
        }),
  };

  let res;
  try {
    // Node fetch streams SSE more reliably than Electron's net.fetch.
    res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    throw new Error(`Groq chat network error (${networkWhy(err)}).`);
  }
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Groq chat ${res.status} (${model}): ${text.slice(0, 240)}`);
  }
  if (!res.body) {
    throw new Error('Groq chat stream returned no body');
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let carry = '';
  let reply = '';

  const consumeData = (payload) => {
    if (!payload || payload === '[DONE]') return;
    let json;
    try {
      json = JSON.parse(payload);
    } catch {
      return;
    }
    const delta = json.choices?.[0]?.delta ?? {};
    const piece = typeof delta.content === 'string' ? delta.content : '';
    if (!piece) return;
    reply += piece;
    onToken?.(piece);
  };

  while (!isCancelled?.()) {
    const { value, done } = await reader.read();
    if (done) break;
    carry += decoder.decode(value, { stream: true });
    const lines = carry.split('\n');
    carry = lines.pop() ?? '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      consumeData(trimmed.slice(5).trim());
    }
  }

  if (isCancelled?.()) {
    try {
      await reader.cancel();
    } catch {
      /* ignore */
    }
  } else if (carry.trim().startsWith('data:')) {
    consumeData(carry.trim().slice(5).trim());
  }

  reply = reply.trim();
  if (!reply) {
    throw new Error('Groq chat stream returned an empty reply.');
  }

  const next = [...history, { role: 'user', content: userText }, { role: 'assistant', content: reply }];
  return { reply, history: next.length > 12 ? next.slice(-12) : next };
}

/**
 * Groq chat with OpenAI-style tool calling (MCP tools mapped upstream).
 * @param {{
 *   apiKey: string,
 *   model: string,
 *   system?: string,
 *   userText: string,
 *   history: {role:string,content:string}[],
 *   tools: any[],
 *   maxRounds?: number,
 *   callTool: (name: string, args: Record<string, unknown>) => Promise<string>,
 * }} opts
 */
export async function chatGroqWithTools({
  apiKey,
  model,
  system = buildNovaInstructions(),
  userText,
  history,
  tools,
  maxRounds = 4,
  callTool,
}) {
  const isReasoningModel = /gpt-oss|o1|o3|reason/i.test(model);
  /** @type {any[]} */
  const messages = [
    { role: 'system', content: system },
    ...history,
    { role: 'user', content: userText },
  ];

  let toolCalls = 0;

  for (let round = 0; round < maxRounds; round++) {
    const body = {
      model,
      temperature: 0.5,
      messages,
      tools,
      tool_choice: 'auto',
      ...(isReasoningModel
        ? { max_completion_tokens: 1024, reasoning_effort: 'low' }
        : { max_tokens: 400 }),
    };

    let res;
    try {
      res = await http('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify(body),
      });
    } catch (err) {
      throw new Error(`Groq tool-chat network error (${networkWhy(err)}).`);
    }
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Groq tool-chat ${res.status} (${model}): ${text.slice(0, 240)}`);
    }

    const data = await res.json();
    const message = data.choices?.[0]?.message ?? {};
    const calls = message.tool_calls;

    if (Array.isArray(calls) && calls.length > 0) {
      messages.push({
        role: 'assistant',
        content: message.content ?? null,
        tool_calls: calls,
      });

      for (const call of calls) {
        const name = call.function?.name ?? '';
        let args = {};
        try {
          args = JSON.parse(call.function?.arguments || '{}');
        } catch {
          args = {};
        }
        toolCalls += 1;
        let resultText;
        try {
          resultText = await callTool(name, args);
        } catch (err) {
          resultText = JSON.stringify({
            error: err instanceof Error ? err.message : String(err),
          });
        }
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: resultText,
        });
      }
      continue;
    }

    const reply = extractReply(message, data);
    const next = [
      ...history,
      { role: 'user', content: userText },
      { role: 'assistant', content: reply },
    ];
    return {
      reply,
      history: next.length > 12 ? next.slice(-12) : next,
      toolCalls,
    };
  }

  throw new Error(`Groq tool-chat exceeded ${maxRounds} tool rounds.`);
}
