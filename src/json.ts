/**
 * Lossless JSON for the node's uint64 fields.
 *
 * `timestamp` (~1.8e18 nanoseconds), `balance`, `amount` and `pow_nonce` all
 * exceed Number.MAX_SAFE_INTEGER. JSON.parse turns them into Numbers and
 * rounds, silently. Parsed values come back as `bigint`, not strings, so a
 * caller reading a raw response object gets the same type the typed accessors
 * hand them — a rounded timestamp produces a block the network rejects,
 * and a rounded balance is simply wrong. So numeric literals for those keys are
 * rewritten to strings before parsing, and revived as bigint.
 *
 * The node's own web wallet does the same thing for the same reason.
 */
const U64_KEYS = [
  // The API is not consistent about casing: block JSON is snake_case, but
  // pending entries come back as Go's exported field names. Cover both.
  'Amount',
  'timestamp',
  'balance',
  'amount',
  'pow_nonce',
  'cost',
  'stake',
  'duration',
  'vcpus',
  'memory_mb',
  'disk_gb',
  'start_time',
  'total',
  'available',
  'pending',
] as const

const U64_PATTERN = new RegExp(`"(${U64_KEYS.join('|')})"\\s*:\\s*(-?\\d+)(?![\\d.eE])`, 'g')

/**
 * Marker for a number this module quoted on the way in, so the reviver can
 * turn it back into a bigint and not mistake it for a string the node sent.
 * Only ever written here, and only in front of digits.
 */
const MARK = '\u0000xe-u64:'

/**
 * The same marker as it must appear INSIDE the JSON text. A raw NUL is not
 * legal in a JSON string literal, so it is written as its escape — which also
 * means a value the node sent could only collide by escaping a NUL itself.
 */
const MARK_JSON = '\\u0000xe-u64:'

/**
 * Digits at which a JSON integer may exceed Number.MAX_SAFE_INTEGER
 * (9007199254740991 — sixteen digits). Anything this long is quoted on sight.
 */
const UNSAFE_DIGITS = 16

/**
 * Quote every integer literal long enough to be unsafe, wherever it appears.
 *
 * The key list above cannot reach values under keys we do not control — the
 * balance map is keyed by ASSET NAME (`{"balances":{"XE":…}}`), so a balance
 * beyond 2^53 would still round. Rather than chase key names, scan the text.
 *
 * This is a scanner rather than a regex because a regex cannot tell a number
 * in the document from digits inside a string, and quoting the contents of a
 * memo would corrupt real user data.
 */
function quoteLongIntegers(text: string): string {
  let out = ''
  let i = 0
  let inString = false
  while (i < text.length) {
    const ch = text[i]!
    if (inString) {
      out += ch
      if (ch === '\\') {
        out += text[i + 1] ?? ''
        i += 2
        continue
      }
      if (ch === '"') inString = false
      i++
      continue
    }
    if (ch === '"') {
      inString = true
      out += ch
      i++
      continue
    }
    if (ch === '-' || (ch >= '0' && ch <= '9')) {
      let j = i
      if (text[j] === '-') j++
      const digitStart = j
      while (j < text.length && text[j]! >= '0' && text[j]! <= '9') j++
      const digits = j - digitStart
      // Consume the whole token: a fraction or exponent left behind would be
      // rescanned as a fresh integer and quoted mid-number.
      let isInteger = true
      if (text[j] === '.') {
        isInteger = false
        j++
        while (j < text.length && text[j]! >= '0' && text[j]! <= '9') j++
      }
      if (text[j] === 'e' || text[j] === 'E') {
        isInteger = false
        j++
        if (text[j] === '+' || text[j] === '-') j++
        while (j < text.length && text[j]! >= '0' && text[j]! <= '9') j++
      }
      const token = text.slice(i, j)
      out += isInteger && digits >= UNSAFE_DIGITS ? `"${MARK_JSON}${token}"` : token
      i = j
      continue
    }
    out += ch
    i++
  }
  return out
}

export function parseLossless(text: string): unknown {
  // Known uint64 keys first, so those are bigint-shaped even when small and
  // callers get one consistent type. Then the magnitude sweep, which catches
  // everything else — including values under keys we do not control, such as
  // the asset-keyed balance map. Already-quoted values are inside strings by
  // then, so the scanner steps over them.
  const marked = quoteLongIntegers(text.replace(U64_PATTERN, `"$1":"${MARK_JSON}$2"`))
  return JSON.parse(marked, (_key, value: unknown) =>
    typeof value === 'string' && value.startsWith(MARK) ? BigInt(value.slice(MARK.length)) : value,
  )
}

/** Read a uint64-bearing field that parseLossless left as a decimal string. */
export function asBigInt(value: unknown, field: string): bigint {
  if (typeof value === 'bigint') return value
  if (typeof value === 'string' && /^-?\d+$/.test(value)) return BigInt(value)
  if (typeof value === 'number' && Number.isSafeInteger(value)) return BigInt(value)
  throw new Error(`${field}: expected an integer, got ${JSON.stringify(value)}`)
}

/**
 * Serialise a block for the wire. bigint has no JSON representation, and the
 * node expects these fields as JSON numbers, so they are emitted unquoted
 * without ever passing through a Number.
 */
export function stringifyWithBigInts(value: unknown): string {
  const marked = JSON.stringify(value, (_key, v: unknown) =>
    typeof v === 'bigint' ? `__bigint__${v.toString()}` : v,
  )
  return marked.replace(/"__bigint__(-?\d+)"/g, '$1')
}
