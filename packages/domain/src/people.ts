import type { ClusterId, PersonId } from "./audio";
import type { SpeakerAttribution, SpeakerCluster } from "./transcript";
import { truncateUtf8, utf8ByteLength } from "./util";

export interface Person {
  id: PersonId;
  fullName: string;
  shortName?: string;
  createdAt: string;
  updatedAt: string;
  /** Reserved for phone-contact linking (post-MVP, plan.md §15); never populated in the MVP. */
  externalLink?: { provider: "phone_contacts"; opaqueId: string };
}

/** G2 contextual-menu labels are limited to 32 UTF-8 bytes. */
export const G2_MENU_LABEL_MAX_BYTES = 32;
/** Budget for a speaker name on the G2 caption line. */
export const G2_SPEAKER_NAME_MAX_BYTES = 24;

export function displayName(person: Pick<Person, "fullName" | "shortName">, maxBytes?: number): string {
  if (maxBytes === undefined || utf8ByteLength(person.fullName) <= maxBytes) return person.fullName;
  if (person.shortName && utf8ByteLength(person.shortName) <= maxBytes) return person.shortName;
  return truncateUtf8(person.shortName ?? person.fullName, maxBytes);
}

export interface SpeakerLabel {
  clusterId: ClusterId;
  text: string;
  personId: PersonId | null;
  /** "confirmed" = manual attribution; "auto" = accepted match; "possible" = below threshold candidate. */
  kind: "confirmed" | "auto" | "possible" | "anonymous";
}

export function speakerLabel(
  clusterId: ClusterId,
  clusters: ReadonlyMap<ClusterId, SpeakerCluster>,
  attributions: ReadonlyMap<ClusterId, SpeakerAttribution>,
  people: ReadonlyMap<PersonId, Person>,
  opts: { maxBytes?: number; candidate?: { personId: PersonId } | null } = {},
): SpeakerLabel {
  const attr = attributions.get(clusterId);
  const person = attr?.personId ? people.get(attr.personId) : undefined;
  if (person && attr) {
    return { clusterId, personId: person.id, text: displayName(person, opts.maxBytes), kind: attr.source === "manual" ? "confirmed" : "auto" };
  }
  const ordinal = clusters.get(clusterId)?.ordinal;
  const anon = ordinal ? `Speaker ${ordinal}` : "Speaker";
  const cand = !attr && opts.candidate ? people.get(opts.candidate.personId) : undefined;
  if (cand) return { clusterId, personId: null, text: `Possibly ${displayName(cand, opts.maxBytes ? opts.maxBytes - 9 : undefined)}`, kind: "possible" };
  return { clusterId, personId: null, text: anon, kind: "anonymous" };
}
