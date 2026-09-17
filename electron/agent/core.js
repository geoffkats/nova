/**
 * Nova Agent Core — Groq + MCP tool router for the Kokoro/chat fallback.
 *
 * Qwen realtime uses the same tools from main.js. This path is for typed /
 * Groq converse when Qwen is not handling the turn.
 */

import { chatGroqWithTools } from '../brain/groq.js';
import {
  buildNovaInstructions,
  isNovaLocalTool,
  novaLocalTools,
  runNovaLocalTool,
} from '../brain/novaMind.js';
import { getMcpHub } from './mcpHub.js';
import { isWorkspaceTool, runKnownAction, extractWorkspaceArtifact } from './workspaceActions.js';

/**
 * @param {{
 *   apiKey: string,
 *   model: string,
 *   userText: string,
 *   history: { role: string, content: string }[],
 *   onTool?: (info: { name: string }) => void,
 *   onArtifact?: (art: { kind: string, title: string, url: string, id?: string }) => void,
 * }} opts
 */
export async function runAgent({ apiKey, model, userText, history, onTool, onArtifact }) {
  const hub = await getMcpHub();
  const tools = [...novaLocalTools(), ...hub.listOpenAiTools()];

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
      if (isNovaLocalTool(name)) return runNovaLocalTool(name, args);
      if (isWorkspaceTool(name)) {
        const text = await runKnownAction(hub, args);
        const art = extractWorkspaceArtifact(String(args.action || ''), args, text);
        if (art) onArtifact?.(art);
        return text;
      }
      const result = await hub.callTool(name, args);
      return result.text || JSON.stringify(result);
    },
  });

  return {
    usedTools: out.toolCalls > 0,
    reply: out.reply,
    history: out.history,
    toolCalls: out.toolCalls,
  };
}
