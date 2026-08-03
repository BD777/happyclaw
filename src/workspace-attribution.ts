import type { RegisteredGroup } from './types.js';

/**
 * Dependencies for resolving where a channel chat's output belongs.
 * Injected so this module stays side-effect free and unit-testable.
 */
export interface WorkspaceAttributionDeps {
  getRegisteredGroup: (jid: string) => RegisteredGroup | null | undefined;
  getAgent: (agentId: string) => { chat_jid: string } | null | undefined;
  getJidsByFolder: (folder: string) => string[];
}

/**
 * Legacy compatibility fold: historical rows sometimes stored `target_main_jid`
 * as `web:{folder}` instead of the registered `web:{uuid}` workspace JID.
 * Mirrors `resolveWorkspaceJid` in ./channel-mount-service.ts, duplicated here
 * so pure output-routing modules do not have to import the mount service.
 */
function foldLegacyWorkspaceJid(
  workspaceJid: string,
  deps: WorkspaceAttributionDeps,
): string | null {
  if (deps.getRegisteredGroup(workspaceJid)) return workspaceJid;
  if (!workspaceJid.startsWith('web:')) return null;
  const folder = workspaceJid.slice(4);
  for (const jid of deps.getJidsByFolder(folder)) {
    if (jid.startsWith('web:') && deps.getRegisteredGroup(jid)) return jid;
  }
  return null;
}

/**
 * Resolve the logical workspace JID a channel chat is bound to.
 *
 * This is the outbound counterpart of `resolveEffectiveChatJid`: it applies the
 * same binding precedence (session binding wins over workspace binding) so a
 * reply is attributed to the workspace that actually produced it, instead of to
 * the IM row whose `folder`/`created_by` still point at the channel account
 * owner. Unlike the inbound resolver this one never creates native-context
 * mounts or thread sessions — attribution must not mutate routing state.
 *
 * Reads the legacy `target_*` columns rather than `channel_mounts` because both
 * sides are dual-written during the mount migration and the columns are present
 * on the already-loaded group row.
 *
 * Returns null when the chat has no binding, so callers keep their own fallback.
 */
export function resolveBoundWorkspaceJid(
  chatJid: string,
  deps: WorkspaceAttributionDeps,
): string | null {
  if (chatJid.startsWith('web:')) return chatJid;

  const group = deps.getRegisteredGroup(chatJid);
  if (!group) return null;

  // Session binding takes priority, matching resolveEffectiveChatJid. The
  // agent's chat_jid is its parent workspace JID; the `#agent:` suffix is
  // composed by the caller so this helper stays suffix-agnostic.
  if (group.target_agent_id) {
    const agent = deps.getAgent(group.target_agent_id);
    return agent?.chat_jid ?? null;
  }

  if (group.target_main_jid) {
    return foldLegacyWorkspaceJid(group.target_main_jid, deps);
  }

  return null;
}
