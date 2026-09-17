import { buildNovaInstructions } from './novaMind.js';

/**
 * @param {{ baseUrl: string, model: string, userText: string, history: {role:string,content:string}[] }} opts
 */
export async function chatOllama({ baseUrl, model, userText, history }) {
  const messages = [
    { role: 'system', content: buildNovaInstructions() },
    ...history,
    { role: 'user', content: userText },
  ];

  let res;
  try {
    res = await fetch(`${baseUrl.replace(/\/$/, '')}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages,
        stream: false,
        // Qwen3 otherwise spends the whole budget on a hidden scratchpad and
        // returns an empty spoken reply — fatal for a voice loop.
        think: false,
        options: {
          temperature: 0.7,
          num_predict: 100,
        },
      }),
    });
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    throw new Error(`Ollama network error (${why}). Is Ollama running on ${baseUrl}?`);
  }
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Ollama ${res.status}: ${body.slice(0, 240)}`);
  }
  const data = await res.json();
  let reply = String(data.message?.content ?? '').trim();
  // Older builds may still stash scratch text here.
  if (!reply && data.message?.thinking) {
    reply = String(data.message.thinking).trim();
  }
  reply = reply.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  // Models still sneak emoji in; strip before TTS reads the CLDR names aloud.
  reply = reply
    .replace(/\p{Extended_Pictographic}/gu, '')
    .replace(/[\uFE0F\u200D]/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
  if (!reply) throw new Error('Ollama returned an empty reply');

  const nextHistory = [...history, { role: 'user', content: userText }, { role: 'assistant', content: reply }];
  return { reply, history: nextHistory.length > 12 ? nextHistory.slice(-12) : nextHistory };
}

/**
 * @param {{
 *   baseUrl: string,
 *   model: string,
 *   userText: string,
 *   history: {role:string,content:string}[],
 *   onToken?: (token: string) => void,
 *   isCancelled?: () => boolean,
 * }} opts
 */
export async function chatOllamaStream({ baseUrl, model, userText, history, onToken, isCancelled }) {
  const messages = [
    { role: 'system', content: buildNovaInstructions() },
    ...history,
    { role: 'user', content: userText },
  ];

  let res;
  try {
    res = await fetch(`${baseUrl.replace(/\/$/, '')}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages,
        stream: true,
        think: false,
        options: {
          temperature: 0.7,
          num_predict: 100,
        },
      }),
    });
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    throw new Error(`Ollama network error (${why}). Is Ollama running on ${baseUrl}?`);
  }
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Ollama ${res.status}: ${body.slice(0, 240)}`);
  }
  if (!res.body) throw new Error('Ollama stream returned no body');

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let carry = '';
  let reply = '';

  const consume = (line) => {
    if (!line.trim()) return;
    let json;
    try {
      json = JSON.parse(line);
    } catch {
      return;
    }
    let piece = String(json.message?.content ?? '');
    piece = piece.replace(/<think>[\s\S]*?<\/think>/gi, '');
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
    for (const line of lines) consume(line);
  }

  if (isCancelled?.()) {
    try {
      await reader.cancel();
    } catch {
      /* ignore */
    }
  } else if (carry.trim()) {
    consume(carry);
  }

  reply = reply
    .replace(/\p{Extended_Pictographic}/gu, '')
    .replace(/[\uFE0F\u200D]/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
  if (!reply) throw new Error('Ollama stream returned an empty reply');

  const nextHistory = [...history, { role: 'user', content: userText }, { role: 'assistant', content: reply }];
  return { reply, history: nextHistory.length > 12 ? nextHistory.slice(-12) : nextHistory };
}

export async function ollamaReady(baseUrl) {
  try {
    const res = await fetch(`${baseUrl.replace(/\/$/, '')}/api/tags`, { method: 'GET' });
    return res.ok;
  } catch {
    return false;
  }
}
