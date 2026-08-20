import { jidNormalizedUser } from 'baileys';

import { parseChannelAddress } from './channel-address.js';

const WHATSAPP_PREFIX = 'whatsapp:';
const LEGACY_USER_SUFFIX = '@c.us';
const DIRECT_USER_SUFFIXES = [
  '@s.whatsapp.net',
  '@hosted.lid',
  '@lid',
  '@hosted',
  LEGACY_USER_SUFFIX,
] as const;

/** Whether a provider-native WhatsApp JID is a structurally direct user chat. */
export function isWhatsAppDirectProviderJid(jid: string): boolean {
  return DIRECT_USER_SUFFIXES.some((suffix) => jid.endsWith(suffix));
}

/**
 * Collapse device/agent suffixes and the legacy `@c.us` PN domain before a
 * WhatsApp conversation becomes a HappyClaw identity. The raw provider target
 * must remain available to the transport for acknowledgements and immediate
 * replies; this helper defines only the durable logical identity.
 */
export function canonicalizeWhatsAppProviderConversationJid(
  jid: string,
): string {
  if (!isWhatsAppDirectProviderJid(jid)) return jid;
  return jidNormalizedUser(jid) || jid;
}

/** Canonicalize a HappyClaw WhatsApp conversation JID while preserving scope. */
export function canonicalizeWhatsAppConversationJid(jid: string): string {
  const address = parseChannelAddress(jid);
  if (!address || address.provider !== 'whatsapp') return jid;
  const canonicalExternal = canonicalizeWhatsAppProviderConversationJid(
    address.externalChatId,
  );
  if (canonicalExternal === address.externalChatId) return jid;
  const fragmentOffset = jid.indexOf('#');
  const fragments = fragmentOffset >= 0 ? jid.slice(fragmentOffset) : '';
  return `${WHATSAPP_PREFIX}${canonicalExternal}${fragments}`;
}

/** True only for the legacy direct-chat aliases that need data reconciliation. */
export function isLegacyWhatsAppDirectConversationJid(jid: string): boolean {
  const address = parseChannelAddress(jid);
  return (
    address?.provider === 'whatsapp' &&
    address.externalChatId.endsWith(LEGACY_USER_SUFFIX)
  );
}

/**
 * Locate account-scoped legacy aliases for one canonical conversation. This is
 * intentionally exact after canonicalization: the account fragment remains in
 * the identity, so two bots talking to the same phone number never coalesce.
 */
export function findLegacyWhatsAppConversationAliases(
  canonicalJid: string,
  candidates: Iterable<string>,
): string[] {
  const canonical = canonicalizeWhatsAppConversationJid(canonicalJid);
  const aliases: string[] = [];
  for (const candidate of candidates) {
    if (!isLegacyWhatsAppDirectConversationJid(candidate)) continue;
    if (canonicalizeWhatsAppConversationJid(candidate) === canonical) {
      aliases.push(candidate);
    }
  }
  return aliases;
}
