import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { deliverChannelOutboxItem } from './channel-outbox-delivery.js';
import {
  semanticChannelOutboxIdentity,
  stableChannelOutboxOrdinal,
  syntheticChannelProviderAck,
} from './channel-outbox-runtime-scope.js';
import {
  getUncertainChannelOutboxForTurn,
  type ChannelRouteSnapshot,
} from './channel-reliability-store.js';
import { ChannelTurnRuntime } from './channel-turn-runtime.js';
import { logger } from './logger.js';

export type UnscopedTaskMediaKind = 'image' | 'file';

export interface SendUnscopedTaskMediaInput {
  route: ChannelRouteSnapshot | null;
  kind: UnscopedTaskMediaKind;
  payload: unknown;
  send: () => Promise<void>;
}

export interface TaskMediaSendDeps {
  isChannelAvailable: (targetJid: string) => boolean;
  sendImage: (
    targetJid: string,
    imageBuffer: Buffer,
    mimeType: string,
    caption?: string,
    fileName?: string,
  ) => Promise<void>;
  sendFile: (
    targetJid: string,
    filePath: string,
    fileName: string,
  ) => Promise<void>;
  resolveRoute: (targetJid: string) => ChannelRouteSnapshot | null;
  deliverScoped?: (
    targetJid: string,
    outbox: any,
    input: {
      kind: UnscopedTaskMediaKind;
      payload: unknown;
      send: () => Promise<void>;
    },
  ) => Promise<boolean | null>;
}

export type RetryTaskNotificationKind =
  | 'im_image'
  | 'im_file'
  | 'im_channel_image'
  | 'im_channel_file';

export interface RetryTaskNotificationPayload {
  kind: RetryTaskNotificationKind;
  targetJid: string;
  workspaceFolder: string;
  filePath: string;
  mimeType?: string;
  caption?: string;
  fileName?: string;
}

export interface RetryTaskNotificationDeps extends TaskMediaSendDeps {
  groupsDir: string;
  isRealpathInside: (resolvedPath: string, workspaceRoot: string) => boolean;
}

export interface RetryTaskNoticeMediaInput {
  kind: UnscopedTaskMediaKind;
  targetJid: string;
  filePath: string;
  mimeType?: string;
  caption?: string;
  fileName: string;
  sendImage: (
    targetJid: string,
    imageBuffer: Buffer,
    mimeType: string,
    caption?: string,
    fileName?: string,
  ) => Promise<void>;
  sendFile: (
    targetJid: string,
    filePath: string,
    fileName: string,
  ) => Promise<void>;
  isChannelAvailable: (targetJid: string) => boolean;
  resolveRoute: (targetJid: string) => ChannelRouteSnapshot | null;
}

function payloadContentHash(payload: unknown): string {
  if (
    payload &&
    typeof payload === 'object' &&
    'contentHash' in payload &&
    typeof (payload as { contentHash?: unknown }).contentHash === 'string' &&
    (payload as { contentHash: string }).contentHash
  ) {
    return (payload as { contentHash: string }).contentHash;
  }
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(payload ?? null))
    .digest('hex');
}

function stableTaskMediaExternalId(
  route: ChannelRouteSnapshot,
  kind: UnscopedTaskMediaKind,
  payload: unknown,
): string {
  return [
    'unscoped-task-media',
    kind,
    route.sourceJid,
    payloadContentHash(payload),
  ].join(':');
}

export async function sendUnscopedTaskMedia(
  input: SendUnscopedTaskMediaInput,
): Promise<boolean> {
  if (!input.route) {
    try {
      await input.send();
      return true;
    } catch {
      return false;
    }
  }

  const route = input.route;
  const runtime = ChannelTurnRuntime.start({
    ...route,
    externalMessageId: stableTaskMediaExternalId(
      route,
      input.kind,
      input.payload,
    ),
  });

  try {
    if (runtime.executionDisposition !== 'execute') {
      return false;
    }

    const uncertainSibling = getUncertainChannelOutboxForTurn(runtime.runId);
    if (uncertainSibling) {
      runtime.interrupt(
        'Unscoped task media delivery is uncertain; manual reconciliation required',
      );
      return false;
    }

    const semanticIdentity = semanticChannelOutboxIdentity({
      route,
      kind: input.kind,
      payload: input.payload,
    });
    const ordinal = stableChannelOutboxOrdinal(semanticIdentity);
    const result = await deliverChannelOutboxItem({
      provider: route.provider,
      accountId: route.accountId,
      sourceJid: route.sourceJid,
      chatId: route.chatId,
      rootId: route.rootId,
      threadId: route.threadId,
      turnRunId: runtime.runId,
      ordinal,
      kind: input.kind,
      payload: input.payload,
      idempotencyKey: `${runtime.runId}:${semanticIdentity}`,
      owner: `happyclaw-outbox:${process.pid}:${runtime.runId}`,
      delivery: {
        mode: 'single',
        send: async ({ item }) => {
          await input.send();
          return {
            providerMessageId: syntheticChannelProviderAck({
              turnRunId: runtime.runId,
              ordinal,
              payloadHash: item.payloadHash,
            }),
          };
        },
      },
    });

    if (result.status === 'delivered') {
      runtime.markFinalizing();
      runtime.complete();
      return true;
    }

    if (result.status === 'uncertain') {
      runtime.interrupt(
        'Unscoped task media delivery is uncertain; manual reconciliation required',
      );
      logger.warn(
        {
          sourceJid: route.sourceJid,
          turnRunId: runtime.runId,
          outboxItemId: result.itemId,
          error: result.error,
        },
        'Channel delivery outcome is uncertain; automatic replay blocked',
      );
      return false;
    }

    logger.warn(
      {
        sourceJid: route.sourceJid,
        turnRunId: runtime.runId,
        outboxItemId: result.itemId,
        outboxStatus: result.status,
        error: result.error,
      },
      'Durable channel delivery did not complete',
    );
    return false;
  } finally {
    runtime.dispose();
  }
}

export async function sendTaskImageWithRetry(
  targetJid: string,
  imageBuffer: Buffer,
  mimeType: string,
  caption: string | undefined,
  fileName: string | undefined,
  outbox: unknown,
  deps: TaskMediaSendDeps,
): Promise<boolean> {
  if (!deps.isChannelAvailable(targetJid)) return false;

  const payload = {
    mimeType,
    caption: caption ?? null,
    fileName: fileName ?? null,
    contentHash: crypto.createHash('sha256').update(imageBuffer).digest('hex'),
  };
  const send = () =>
    deps.sendImage(targetJid, imageBuffer, mimeType, caption, fileName);

  if (outbox != null && deps.deliverScoped) {
    const scoped = await deps.deliverScoped(targetJid, outbox, {
      kind: 'image',
      payload,
      send,
    });
    if (scoped !== null) return scoped;
  }

  return sendUnscopedTaskMedia({
    route: deps.resolveRoute(targetJid),
    kind: 'image',
    payload,
    send,
  });
}

export async function sendTaskFileWithRetry(
  targetJid: string,
  filePath: string,
  fileName: string,
  outbox: unknown,
  deps: TaskMediaSendDeps,
): Promise<boolean> {
  if (!deps.isChannelAvailable(targetJid)) return false;

  const payload = {
    fileName,
    contentHash: crypto
      .createHash('sha256')
      .update(fs.readFileSync(filePath))
      .digest('hex'),
  };
  const send = () => deps.sendFile(targetJid, filePath, fileName);

  if (outbox != null && deps.deliverScoped) {
    const scoped = await deps.deliverScoped(targetJid, outbox, {
      kind: 'file',
      payload,
      send,
    });
    if (scoped !== null) return scoped;
  }

  return sendUnscopedTaskMedia({
    route: deps.resolveRoute(targetJid),
    kind: 'file',
    payload,
    send,
  });
}

export async function retryTaskNotification(
  payload: RetryTaskNotificationPayload,
  deps: RetryTaskNotificationDeps,
): Promise<boolean> {
  const workspaceRoot = path.resolve(deps.groupsDir, payload.workspaceFolder);
  const resolvedPath = path.resolve(workspaceRoot, payload.filePath);
  if (
    resolvedPath !== workspaceRoot &&
    !resolvedPath.startsWith(`${workspaceRoot}${path.sep}`)
  ) {
    throw new Error('Persisted notification path left its workspace');
  }
  if (!deps.isRealpathInside(resolvedPath, workspaceRoot)) {
    throw new Error('Persisted notification file is unavailable');
  }

  if (payload.kind === 'im_image' || payload.kind === 'im_channel_image') {
    const imageBuffer = fs.readFileSync(resolvedPath);
    const mimeType = payload.mimeType ?? 'image/png';
    return sendTaskImageWithRetry(
      payload.targetJid,
      imageBuffer,
      mimeType,
      payload.caption,
      payload.fileName,
      undefined,
      deps,
    );
  }

  return sendTaskFileWithRetry(
    payload.targetJid,
    resolvedPath,
    payload.fileName ?? path.basename(resolvedPath),
    undefined,
    deps,
  );
}

/** @deprecated Use sendTaskImageWithRetry / sendTaskFileWithRetry / retryTaskNotification */
export async function retryTaskNoticeMedia(
  input: RetryTaskNoticeMediaInput,
): Promise<boolean> {
  if (input.kind === 'image') {
    const imageBuffer = fs.readFileSync(input.filePath);
    const mimeType = input.mimeType ?? 'image/png';
    return sendTaskImageWithRetry(
      input.targetJid,
      imageBuffer,
      mimeType,
      input.caption,
      input.fileName,
      undefined,
      input,
    );
  }
  return sendTaskFileWithRetry(
    input.targetJid,
    input.filePath,
    input.fileName,
    undefined,
    input,
  );
}
