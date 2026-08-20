import { channelConversationJid } from './channel-address.js';
import { resolveChannelConversationKind } from './channel-conversation-kind.js';
import {
  commitChannelMountUpdate,
  ensureDirectChannelSessionMount,
  resolveWorkspaceJid,
} from './channel-mount-service.js';
import {
  CURRENT_SCHEMA_VERSION,
  countRecoverableInboundMessagesFromSources,
  getAllRegisteredGroups,
  getConversationHistoryIsolationMarker,
  getJidsByFolder,
  getRegisteredGroup,
  getRouterState,
  getSession,
  getSessionChannelOwner,
  getWorkspaceRuntimeSession,
  listRecoverableInboundSourceJids,
  resetWorkspaceMainIsolationGeneration,
  runImmediateTransaction,
} from './db.js';
import type { RegisteredGroup } from './types.js';

export interface LeftoverDirectWorkspaceMount {
  channelJid: string;
  workspaceJid: string;
  workspaceFolder: string;
  channelAccountId?: string;
  mainOwnerJid?: string;
  mainOwnerIsThisChat: boolean;
  mainSessionId?: string;
  existingIsolationMarker?: string;
  recoverableInboundFromThisChat: number;
}

export interface AffectedLeftoverWorkspace {
  workspaceJid: string;
  workspaceFolder: string;
  leftoverCount: number;
  existingIsolationMarker?: string;
  mainSessionId?: string;
  mainRuntimeSessionId?: string;
  mainOwnerJid?: string;
  recoverableInboundFromLeftovers: number;
}

export interface LeftoverDirectMountDiagnosis {
  schemaVersion: string;
  leftovers: LeftoverDirectWorkspaceMount[];
  affectedWorkspaces: AffectedLeftoverWorkspace[];
}

export interface LeftoverDirectMountRepairResult extends LeftoverDirectMountDiagnosis {
  applied: boolean;
  remounted: number;
  isolationGenerationsReset: number;
  isolationMarkers: Record<string, string>;
}

function conversationAliases(jid: string): Set<string> {
  return new Set([jid, channelConversationJid(jid)]);
}

function sourceMatchesConversation(
  sourceJid: string,
  conversationJid: string,
): boolean {
  return (
    conversationAliases(conversationJid).has(sourceJid) ||
    channelConversationJid(sourceJid) ===
      channelConversationJid(conversationJid)
  );
}

function resolveMountedWorkspace(
  targetMainJid: string | undefined,
): { workspaceJid: string; workspace: RegisteredGroup } | null {
  const workspaceJid = resolveWorkspaceJid(targetMainJid, {
    getRegisteredGroup,
    getJidsByFolder,
  });
  if (!workspaceJid) return null;
  const workspace = getRegisteredGroup(workspaceJid);
  if (!workspace) return null;
  return { workspaceJid, workspace };
}

function countRecoverableInboundFromChat(
  workspaceJid: string,
  channelJid: string,
): number {
  const knownSources = listRecoverableInboundSourceJids(workspaceJid).filter(
    (sourceJid) => sourceMatchesConversation(sourceJid, channelJid),
  );
  return countRecoverableInboundMessagesFromSources(workspaceJid, [
    ...conversationAliases(channelJid),
    ...knownSources,
  ]);
}

/**
 * JID-classifiable DMs still bound to workspace main. Feishu stays unknown
 * without metadata and is never selected — that path remains auto_im.
 */
export function findLeftoverClassifiableDirectWorkspaceMounts(): LeftoverDirectWorkspaceMount[] {
  const leftovers: LeftoverDirectWorkspaceMount[] = [];

  for (const [jid, group] of Object.entries(getAllRegisteredGroups())) {
    if (resolveChannelConversationKind(jid) !== 'direct') continue;
    if (!group.target_main_jid || group.target_agent_id) continue;

    const mounted = resolveMountedWorkspace(group.target_main_jid);
    if (!mounted) continue;

    const mainOwnerJid = getSessionChannelOwner(mounted.workspace.folder, null);
    leftovers.push({
      channelJid: jid,
      workspaceJid: mounted.workspaceJid,
      workspaceFolder: mounted.workspace.folder,
      channelAccountId: group.channel_account_id,
      mainOwnerJid,
      mainOwnerIsThisChat: Boolean(
        mainOwnerJid && sourceMatchesConversation(mainOwnerJid, jid),
      ),
      mainSessionId: getSession(mounted.workspace.folder),
      existingIsolationMarker: getConversationHistoryIsolationMarker(
        mounted.workspaceJid,
      ),
      recoverableInboundFromThisChat: countRecoverableInboundFromChat(
        mounted.workspaceJid,
        jid,
      ),
    });
  }

  return leftovers;
}

export function diagnoseLeftoverClassifiableDirectWorkspaceMounts(): LeftoverDirectMountDiagnosis {
  const leftovers = findLeftoverClassifiableDirectWorkspaceMounts();
  const byWorkspace = new Map<string, LeftoverDirectWorkspaceMount[]>();
  for (const leftover of leftovers) {
    const bucket = byWorkspace.get(leftover.workspaceJid) ?? [];
    bucket.push(leftover);
    byWorkspace.set(leftover.workspaceJid, bucket);
  }

  const affectedWorkspaces: AffectedLeftoverWorkspace[] = [];
  for (const [workspaceJid, mounts] of byWorkspace) {
    const folder = mounts[0]!.workspaceFolder;
    affectedWorkspaces.push({
      workspaceJid,
      workspaceFolder: folder,
      leftoverCount: mounts.length,
      existingIsolationMarker:
        getConversationHistoryIsolationMarker(workspaceJid),
      mainSessionId: getSession(folder),
      mainRuntimeSessionId: getWorkspaceRuntimeSession(folder)?.sdk_session_id,
      mainOwnerJid: getSessionChannelOwner(folder, null),
      recoverableInboundFromLeftovers: mounts.reduce(
        (sum, mount) => sum + mount.recoverableInboundFromThisChat,
        0,
      ),
    });
  }

  return {
    schemaVersion:
      getRouterState('schema_version') ?? String(CURRENT_SCHEMA_VERSION),
    leftovers,
    affectedWorkspaces,
  };
}

function remountLeftoverDirect(leftover: LeftoverDirectWorkspaceMount): void {
  const group = getRegisteredGroup(leftover.channelJid);
  const workspace = getRegisteredGroup(leftover.workspaceJid);
  if (!group || !workspace) {
    throw new Error(
      `Leftover direct mount disappeared during repair: ${leftover.channelJid}`,
    );
  }

  const mounted = ensureDirectChannelSessionMount({
    sourceJid: leftover.channelJid,
    group,
    workspaceJid: leftover.workspaceJid,
    userId: group.created_by ?? workspace.created_by ?? '',
    force: true,
    mountOptions: { replyPolicy: 'source_only' },
  });
  if (!mounted.target_agent_id || mounted.target_main_jid) {
    throw new Error(
      `Failed to remount leftover DM onto channel_direct: ${leftover.channelJid}`,
    );
  }
  commitChannelMountUpdate(leftover.channelJid, mounted, {
    clearMatchingMainOwnerFolder: leftover.workspaceFolder,
  });
}

/**
 * Remount leftover JID-classifiable DMs onto `channel_direct` and reset every
 * affected workspace's recovery/isolation state with a new generation.
 *
 * Dry-run is the default. This is not a schema migration and must not bump
 * CURRENT_SCHEMA_VERSION. A previous isolation marker is not treated as
 * success: leaked post-marker main rows and a contaminated main session stay
 * recoverable unless a new generation fences them together.
 */
export function repairLeftoverClassifiableDirectWorkspaceMounts(
  options: { apply?: boolean; isolationStartedAt?: string } = {},
): LeftoverDirectMountRepairResult {
  const diagnosis = diagnoseLeftoverClassifiableDirectWorkspaceMounts();
  if (!options.apply || diagnosis.leftovers.length === 0) {
    return {
      ...diagnosis,
      applied: false,
      remounted: 0,
      isolationGenerationsReset: 0,
      isolationMarkers: {},
    };
  }

  const isolationStartedAt =
    options.isolationStartedAt ?? new Date().toISOString();
  return runImmediateTransaction(() => {
    for (const leftover of diagnosis.leftovers) {
      remountLeftoverDirect(leftover);
    }

    const isolationMarkers: Record<string, string> = {};
    for (const workspace of diagnosis.affectedWorkspaces) {
      isolationMarkers[workspace.workspaceJid] =
        resetWorkspaceMainIsolationGeneration(
          workspace.workspaceJid,
          workspace.workspaceFolder,
          isolationStartedAt,
        );
    }

    const after = diagnoseLeftoverClassifiableDirectWorkspaceMounts();
    if (after.leftovers.length > 0) {
      throw new Error(
        `Leftover direct mounts remain after repair: ${after.leftovers
          .map((item) => item.channelJid)
          .join(', ')}`,
      );
    }

    return {
      ...diagnosis,
      schemaVersion: after.schemaVersion,
      leftovers: [],
      affectedWorkspaces: diagnosis.affectedWorkspaces.map((workspace) => ({
        ...workspace,
        existingIsolationMarker: isolationMarkers[workspace.workspaceJid],
        mainSessionId: undefined,
        mainRuntimeSessionId: undefined,
        mainOwnerJid: undefined,
        recoverableInboundFromLeftovers: 0,
      })),
      applied: true,
      remounted: diagnosis.leftovers.length,
      isolationGenerationsReset: diagnosis.affectedWorkspaces.length,
      isolationMarkers,
    };
  });
}
