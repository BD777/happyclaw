export interface HappyClawBootstrapTurn {
  turnId?: string;
  isHome: boolean;
  isDefaultProfile: boolean;
  isScheduledTask?: boolean;
}

/**
 * Restrict the one-shot first-wake ritual to a real interactive turn of the
 * built-in HappyClaw in Home. Process warmups have no turnId; scheduled runs,
 * custom Agents, and non-Home workspaces are always excluded.
 */
export function isHappyClawBootstrapTurn(
  input: HappyClawBootstrapTurn,
): boolean {
  return Boolean(
    input.turnId &&
    input.isHome &&
    input.isDefaultProfile &&
    !input.isScheduledTask,
  );
}
