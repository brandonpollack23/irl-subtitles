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

/** A saved short name always wins over the full name; the full name stays for the People screens. */
export function displayName(person: Pick<Person, "fullName" | "shortName">, maxBytes?: number): string {
  const name = person.shortName || person.fullName;
  return maxBytes === undefined ? name : truncateUtf8(name, maxBytes);
}

/** The words around speaker names, in the UI language. English is the default (exports, prompts, logs). */
export interface SpeakerWords {
  /** "Speaker 2", or "Speaker" without an ordinal. */
  speaker(ordinal?: number): string;
  /** "Possibly Alice": a below-threshold candidate on the phone. */
  possibly(name: string): string;
  /** "Alice?": the same candidate on the glasses. */
  maybe(name: string): string;
}

export const ENGLISH_SPEAKER_WORDS: SpeakerWords = {
  speaker: (ordinal) => (ordinal ? `Speaker ${ordinal}` : "Speaker"),
  possibly: (name) => `Possibly ${name}`,
  maybe: (name) => `${name}?`,
};

export interface SpeakerLabel {
  clusterId: ClusterId;
  text: string;
  ordinal?: number;
  personId: PersonId | null;
  /** "confirmed" = manual attribution; "auto" = accepted match; "possible" = below threshold candidate. */
  kind: "confirmed" | "auto" | "possible" | "anonymous";
}

export function speakerLabel(
  clusterId: ClusterId,
  clusters: ReadonlyMap<ClusterId, SpeakerCluster>,
  attributions: ReadonlyMap<ClusterId, SpeakerAttribution>,
  people: ReadonlyMap<PersonId, Person>,
  opts: { maxBytes?: number; candidate?: { personId: PersonId } | null; words?: SpeakerWords } = {},
): SpeakerLabel {
  const words = opts.words ?? ENGLISH_SPEAKER_WORDS;
  const attr = attributions.get(clusterId);
  const person = attr?.personId ? people.get(attr.personId) : undefined;
  const ordinal = clusters.get(clusterId)?.ordinal;
  const at = ordinal ? { ordinal } : {};
  if (person && attr) {
    return { clusterId, ...at, personId: person.id, text: displayName(person, opts.maxBytes), kind: attr.source === "manual" ? "confirmed" : "auto" };
  }
  const cand = !attr && opts.candidate ? people.get(opts.candidate.personId) : undefined;
  if (cand) return { clusterId, ...at, personId: null, text: words.possibly(displayName(cand, opts.maxBytes ? opts.maxBytes - utf8ByteLength(words.possibly("")) : undefined)), kind: "possible" };
  return { clusterId, ...at, personId: null, text: words.speaker(ordinal), kind: "anonymous" };
}

/**
 * The speaker name on the G2 caption line: the attributed name, else a live candidate as "Name?" (the phone's
 * "Possibly Name", in the glasses' tighter budget), else "Speaker N".
 */
export function glassesSpeakerName(
  clusterId: ClusterId,
  clusters: ReadonlyMap<ClusterId, SpeakerCluster>,
  attributions: ReadonlyMap<ClusterId, SpeakerAttribution>,
  people: ReadonlyMap<PersonId, Person>,
  words: SpeakerWords = ENGLISH_SPEAKER_WORDS,
): string {
  const label = speakerLabel(clusterId, clusters, attributions, people, { maxBytes: G2_SPEAKER_NAME_MAX_BYTES, words });
  const candidateId = clusters.get(clusterId)?.candidatePersonId;
  const candidate = label.kind === "anonymous" && !attributions.has(clusterId) && candidateId ? people.get(candidateId) : undefined;
  return candidate ? words.maybe(displayName(candidate, G2_SPEAKER_NAME_MAX_BYTES - utf8ByteLength(words.maybe("")))) : label.text;
}
