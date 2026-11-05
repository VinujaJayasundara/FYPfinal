/**
 * One colour for solo runs and one for runs with a friend (connected or
 * racing), used everywhere: history badges, map routes, race cards.
 * Values come from the design tokens.
 */
import { colors } from './tokens';

export const SOLO_COLOR = colors.accent;
export const PEER_COLOR = colors.peer;

export const runColor = (withPeer: boolean): string => (withPeer ? PEER_COLOR : SOLO_COLOR);
