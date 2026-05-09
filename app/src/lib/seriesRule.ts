// Channel-aware lookup for "is this airing covered by a series rule?".
// Series rules carry a `channels` list; an empty list means wildcard
// ("any channel that airs this TVDB id"). When the list is non-empty,
// only programs on one of those channels count as covered. This used to
// be a flat Set<number> of tvdb ids, which over-matched — a rule
// created from MBS would visually claim the BS11 broadcast too even
// though the server-side predicate now refuses to reserve it.

export function seriesRuleCovers(
  map: Map<number, string[]> | undefined,
  tvdbId: number,
  ch: string,
): boolean {
  if (!map) return false;
  const list = map.get(tvdbId);
  if (!list) return false;
  if (list.length === 0) return true;
  return list.includes(ch);
}

// "Same TVDB id has a rule, but the rule does not cover this channel."
// Drives the "他のチャンネルで登録済み" hint in the modal so the user
// understands why the airing isn't auto-reserved without losing the
// option to record this airing on its own.
export function seriesRuleOnOtherChannel(
  map: Map<number, string[]> | undefined,
  tvdbId: number,
  ch: string,
): boolean {
  if (!map) return false;
  const list = map.get(tvdbId);
  if (!list) return false;
  if (list.length === 0) return false; // wildcard already covers `ch`
  return !list.includes(ch);
}

// Channel ids the rule for `tvdbId` is registered on. Empty list when
// no rule exists or the rule is wildcard — caller decides how to
// distinguish via seriesRuleCovers / seriesRuleOnOtherChannel.
export function seriesRuleChannels(
  map: Map<number, string[]> | undefined,
  tvdbId: number,
): string[] {
  return map?.get(tvdbId) ?? [];
}
