/**
 * Nova Agent Core — Groq + MCP tool router for the Kokoro/chat fallback.
 *
 * Qwen realtime uses the same tools from main.js. This path is for typed /
 * Groq converse when Qwen is not handling the turn.
 */

import { chatGroqWithTools } from '../brain/groq.js';
import { buildNovaInstructions } from '../brain/novaMind.js';
import { executeNovaTool, listNovaTools } from './novaTools.js';

/**
 * @param {{
 *   apiKey: string,
 *   model: string,
 *   userText: string,
 *   history: { role: string, content: string }[],
 *   onTool?: (info: { name: string }) => void,
 *   onArtifact?: (art: { kind: string, title: string, url: string, id?: string }) => void,
 *   onBoard?: (board: { cards: object[] }, opts?: { show?: boolean }) => void,
 * }} opts
 */
export async function runAgent({ apiKey, model, userText, history, onTool, onArtifact, onBoard }) {
  const tools = await listNovaTools();

  if (!tools.length) {
    return { usedTools: false, reply: '', history, toolCalls: 0 };
  }

  const out = await chatGroqWithTools({
    apiKey,
    model,
    system: buildNovaInstructions(),
    userText,
    history,
    tools,
    callTool: async (name, args) => {
      onTool?.({ name });
      return executeNovaTool(name, args, { onArtifact, onBoard });
    },
  });

  return {
    usedTools: out.toolCalls > 0,
    reply: out.reply,
    history: out.history,
    toolCalls: out.toolCalls,
  };
}
