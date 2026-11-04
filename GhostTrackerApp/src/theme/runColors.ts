/**
 * One colour for solo runs and one for runs with a friend (connected or
 * racing), used everywhere: history badges, map routes, race cards.
 */
export const SOLO_COLOR = '#00FF87';
export const PEER_COLOR = '#BF5AF2';

export const runColor = (withPeer: boolean): string => (withPeer ? PEER_COLOR : SOLO_COLOR);
