/**
 * Act as a person (gateway only): the shared "act as" context a host gives a
 * call, so a server can make the call's changes in the person's own name in
 * the upstream system, instead of the key's own user.
 *
 * The host has verified the person (signed in, email confirmed) and passes
 * `actAs: { email, name? }` in the call context. The server finds the
 * person's user in the system by that email and puts it on the request (a
 * header such as Zammad's `From`, or a user or employee field), as the
 * vendor documents it. The rules every server keeps:
 *
 * - **No fallback for a change.** When the host gave `actAs` and the person
 *   has no user in the system (or more than one, or the key may not act for
 *   others), the change is not sent: the handler throws ActAsRefusedError and
 *   the gateway answers with `actAsRefused` and a fixed text. A change is
 *   never made as the key's own user instead.
 * - **Reads are the server's choice, written down per system.** A read may go
 *   as the key's own user when that is harmless; the server's README says
 *   which.
 * - **The server adds the email nowhere.** It is only sent upstream to find
 *   the user. The server never writes it to its audit (the audit has the
 *   host's `caller`, which the host chooses) and never puts it in a text or
 *   field of its own. Data the system returns is passed on as it is, so a
 *   result can hold the address when the system's own data does (for example
 *   the person's own user record).
 * - **A malformed `actAs` refuses the call.** It is never dropped silently,
 *   since that would make the call as the key's own user. Only an absent
 *   (`undefined`) `actAs` means "no person"; `null` is refused too.
 *
 * Without `actAs` a call runs as it always has: as the key's own user.
 */

/** The person a call is made for, as the host verified them. */
export interface ActAs {
  /** The person's verified email, compared case-insensitively. */
  readonly email: string;
  /** The person's name, when the system needs it to match or create a user. */
  readonly name?: string;
}

/** Why a call was not made as the person. */
export type ActAsRefusal = 'invalid' | 'no_user' | 'not_permitted';

export const ACT_AS_REFUSALS: readonly ActAsRefusal[] = Object.freeze(['invalid', 'no_user', 'not_permitted']);

/** Our own fixed texts for a refusal; never the email, never the vendor's text. */
export const ACT_AS_TEXTS: Readonly<Record<ActAsRefusal, string>> = Object.freeze({
  invalid: 'Refused: the person to act as is not a valid email address; nothing was sent.',
  no_user: 'Refused: the person has no single active user in the system with that email; nothing was changed.',
  not_permitted: 'Refused: the key may not act as another user in the system; nothing was changed.',
});

/** Thrown by a handler (or the client) when a call cannot be made as the person. */
export class ActAsRefusedError extends Error {
  readonly refusal: ActAsRefusal;

  constructor(refusal: ActAsRefusal) {
    super(ACT_AS_TEXTS[refusal]);
    this.name = 'ActAsRefusedError';
    this.refusal = refusal;
  }
}

const EMAIL = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

/**
 * The host's `actAs`, checked: undefined when the host gave none (undefined, not null), a frozen
 * `{ email, name? }` (email trimmed and lowercased, at most 254 characters;
 * name trimmed, 1-200 characters, no control characters) when it is usable,
 * and ActAsRefusedError('invalid') otherwise.
 */
export function normaliseActAs(value: unknown): Readonly<ActAs> | undefined {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new ActAsRefusedError('invalid');
  const { email, name } = value as Record<string, unknown>;
  if (typeof email !== 'string') throw new ActAsRefusedError('invalid');
  const address = email.trim().toLowerCase();
  if (address.length > 254 || !EMAIL.test(address)) throw new ActAsRefusedError('invalid');
  if (name === undefined) return Object.freeze({ email: address });
  if (typeof name !== 'string') throw new ActAsRefusedError('invalid');
  const shown = name.trim();
  if (shown.length < 1 || shown.length > 200 || /[\u0000-\u001f\u007f]/.test(shown)) throw new ActAsRefusedError('invalid');
  return Object.freeze({ email: address, name: shown });
}

/** The refusal on a result, as it must be after redaction: one of ACT_AS_REFUSALS, or nothing. */
export function actAsRefusalInForm(value: unknown): ActAsRefusal | undefined {
  return typeof value === 'string' && (ACT_AS_REFUSALS as readonly string[]).includes(value) ? (value as ActAsRefusal) : undefined;
}
