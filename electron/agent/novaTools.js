/**
 * Tools Nova can actually call. Qwen and Groq share this list.
 * Workspace MCP stays hidden behind google_workspace; files / Chrome / music
 * are local catalogs, not extra MCP servers.
 */

import { isNovaLocalTool, novaLocalTools, runNovaLocalTool } from '../brain/novaMind.js';
import { getMcpHub } from './mcpHub.js';
import { extractWorkspaceArtifact, isWorkspaceTool, runKnownAction } from './workspaceActions.js';
import { extractFileArtifact, fileActionTool, isFileTool, runFileAction } from './fileActions.js';
import { isWebTool, runWebAction, webActionTool } from './webActions.js';
import { isMusicTool, musicActionTool, runMusicAction } from './musicActions.js';
import { boardActionTool, isBoardTool, runBoardAction } from './boardActions.js';

export async function listNovaTools() {
  const hub = await getMcpHub();
  return [
    ...novaLocalTools(),
    ...hub.listOpenAiTools(),
    fileActionTool(),
    webActionTool(),
    musicActionTool(),
    boardActionTool(),
  ];
}

/**
 * @param {string} name
 * @param {Record<string, unknown>} args
 * @param {{
 *   onArtifact?: (art: { kind: string, title: string, url: string, id?: string }) => void,
 *   onBoard?: (board: { cards: object[] }, opts?: { show?: boolean }) => void,
 * }} [hooks]
 */
export async function executeNovaTool(name, args = {}, hooks = {}) {
  if (isNovaLocalTool(name)) return runNovaLocalTool(name, args);

  if (isFileTool(name)) {
    const text = await runFileAction(args);
    const art = extractFileArtifact(String(args.action || ''), args, text);
    if (art) hooks.onArtifact?.(art);
    return text;
  }

  if (isWebTool(name)) return runWebAction(args);
  if (isMusicTool(name)) return runMusicAction(args);

  if (isBoardTool(name)) {
    const out = runBoardAction(args);
    hooks.onBoard?.(out.board, { show: out.show !== false });
    return out.text;
  }

  const hub = await getMcpHub();
  if (isWorkspaceTool(name)) {
    const text = await runKnownAction(hub, args);
    const art = extractWorkspaceArtifact(String(args.action || ''), args, text);
    if (art) hooks.onArtifact?.(art);
    return text;
  }

  const result = await hub.callTool(name, args);
  return result.text || JSON.stringify(result);
}
