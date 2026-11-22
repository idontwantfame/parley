export const DEFAULT_AUTO_JOIN_MIN_PEOPLE = 2;

export function shouldAutoJoin({ humanCount, autoJoin, connected, minPeople = DEFAULT_AUTO_JOIN_MIN_PEOPLE }) {
  return !!autoJoin && !connected && humanCount >= minPeople;
}

export function shouldAutoLeave({ humanCount, connected, minPeople = DEFAULT_AUTO_JOIN_MIN_PEOPLE }) {
  // Leave the last participant alone, unless recording solo was enabled.
  return !!connected && humanCount <= (minPeople === 1 ? 0 : 1);
}
