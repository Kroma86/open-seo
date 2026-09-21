// A Cloudflare Access service token is a machine credential: Access has
// already verified it, and there is no browser behind it to complete an OAuth
// login. It therefore resolves to its own user row rather than borrowing a
// person's, so the audit trail names the machine that called.
//
// Kept free of database imports on purpose: the modules that resolve workspace
// context cannot be loaded outside a Workers runtime, and this must stay
// independently testable.

// The id keeps common_name EXACTLY. It is a text primary key, so it needs no
// cleaning, and an exact copy is injective by construction: two different
// tokens can never produce one id. This is also the field an operator reads
// when asking which machine called.
function serviceTokenUserId(commonName: string) {
  return `cf-service-token:${commonName}`;
}

// The address cannot carry common_name verbatim — addresses restrict both
// characters and length — and any lossy clean-up (lower-casing, replacing
// disallowed characters with a dash) maps distinct names onto one address:
// `ci-bot`, `CI-BOT`, `ci bot`, `ci/bot` and `ci@bot` all flatten to `ci-bot`.
// The user table's email column is UNIQUE, so that would either merge two
// machines into one row or fail the second one's insert forever.
//
// A digest is NOT injective and this comment will not pretend otherwise: it is
// SHA-256 truncated to 160 bits, and TextEncoder folds unpaired surrogates to
// U+FFFD, so inputs exist that share an address. common_name is the token name
// an operator typed, a free-form string over an alphabet far wider than 160
// bits can enumerate, so colliding names certainly exist -- nothing here rules
// them out. The difference from a character map is reachability, not absence:
// a map collided on ordinary names an operator would actually pick (ci-bot /
// CI-BOT / ci bot), while 160 bits against a handful of service tokens is
// collision resistance. That is a probability argument, not a proof, and the
// id above is the field that is exact.
//
// `.invalid` is reserved by RFC 2606 and can never resolve, so a machine row
// cannot be mistaken for a real mailbox or receive mail. 160 bits is far past
// what a handful of service tokens needs and leaves the local part well inside
// the 64-octet limit in RFC 5321.
async function serviceTokenUserEmail(commonName: string) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(commonName),
  );
  const hex = Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return `${hex.slice(0, 40)}@service-token.invalid`;
}

export async function serviceTokenIdentity(commonName: string) {
  return {
    userId: serviceTokenUserId(commonName),
    userEmail: await serviceTokenUserEmail(commonName),
  };
}
