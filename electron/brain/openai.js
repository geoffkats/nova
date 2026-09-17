import { buildNovaInstructions } from './novaMind.js';

/**
 * @param {{ apiKey: string, model: string, wav: ArrayBuffer }} opts
 * @returns {Promise<string>}
 */
export async function transcribe({ apiKey, model, wav }) {
  const form = new FormData();
  form.append('file', new Blob([wav], { type: 'audio/wav' }), 'utterance.wav');
  form.append('model', model);
  form.append('response_format', 'json');

  const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Whisper ${res.status}: ${body.slice(0, 240)}`);
  }
  const data = await res.json();
  return String(data.text ?? '').trim();
}

/**
 * @param {{ apiKey: string, model: string, userText: string, history: {role:string,content:string}[] }} opts
 * @returns {Promise<{ reply: string, history: {role:string,content:string}[] }>}
 */
export async function chat({ apiKey, model, userText, history }) {
  const messages = [
    { role: 'system', content: buildNovaInstructions() },
    ...history,
    { role: 'user', content: userText },
  ];

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      temperature: 0.8,
      max_tokens: 120,
      messages,
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Chat ${res.status}: ${body.slice(0, 240)}`);
  }
  const data = await res.json();
  const reply = String(data.choices?.[0]?.message?.content ?? '').trim();
  if (!reply) throw new Error('Chat returned an empty reply');

  const nextHistory = [...history, { role: 'user', content: userText }, { role: 'assistant', content: reply }];
  // Keep the last few turns so the IPC payload and prompt stay small.
  const trimmed = nextHistory.length > 12 ? nextHistory.slice(-12) : nextHistory;
  return { reply, history: trimmed };
}

/**
 * @param {{
 *   apiKey: string,
 *   model: string,
 *   userText: string,
 *   history: {role:string,content:string}[],
 *   onToken?: (token: string) => void,
 *   isCancelled?: () => boolean,
 * }} opts
 */
export async function chatStream({ apiKey, model, userText, history, onToken, isCancelled }) {
  const messages = [
    { role: 'system', content: buildNovaInstructions() },
    ...history,
    { role: 'user', content: userText },
  ];

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
    },
    body: JSON.stringify({
      model,
      temperature: 0.8,
      max_tokens: 120,
      stream: true,
      messages,
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Chat ${res.status}: ${body.slice(0, 240)}`);
  }
  if (!res.body) throw new Error('OpenAI chat stream returned no body');

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let carry = '';
  let reply = '';

  const consume = (payload) => {
    if (!payload || payload === '[DONE]') return;
    let json;
    try {
      json = JSON.parse(payload);
    } catch {
      return;
    }
    const piece = json.choices?.[0]?.delta?.content;
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
      consume(trimmed.slice(5).trim());
    }
  }

  if (isCancelled?.()) {
    try {
      await reader.cancel();
    } catch {
      /* ignore */
    }
  }

  reply = reply.trim();
  if (!reply) throw new Error('Chat stream returned an empty reply');
  const nextHistory = [...history, { role: 'user', content: userText }, { role: 'assistant', content: reply }];
  return { reply, history: nextHistory.length > 12 ? nextHistory.slice(-12) : nextHistory };
}
