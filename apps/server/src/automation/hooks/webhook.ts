// @effect-diagnostics nodeBuiltinImport:off - HMAC and address classification come from Node.
import * as NodeCrypto from "node:crypto";
import * as NodeNet from "node:net";

/** Seconds since the epoch at which the request was signed. */
export const WEBHOOK_TIMESTAMP_HEADER = "x-t3-timestamp";
/** Stable across retries and redeliveries: a receiver that has seen it has seen this delivery. */
export const WEBHOOK_DELIVERY_ID_HEADER = "x-t3-delivery-id";
export const WEBHOOK_DEDUP_KEY_HEADER = "x-t3-dedup-key";
export const WEBHOOK_HOOK_ID_HEADER = "x-t3-hook-id";
/** `v1=` followed by the hex HMAC-SHA256 of `<timestamp>.<delivery id>.<body>`. */
export const WEBHOOK_SIGNATURE_HEADER = "x-t3-signature";

/** Name the secret store holds a hook's signing secret under. */
export const webhookSecretName = (secretRef: string) => `hook-secret-${secretRef}`;

export const signWebhook = (input: {
  readonly secret: Uint8Array;
  readonly timestamp: string;
  readonly deliveryId: string;
  readonly body: string;
}) =>
  `v1=${NodeCrypto.createHmac("sha256", input.secret)
    .update(`${input.timestamp}.${input.deliveryId}.${input.body}`)
    .digest("hex")}`;

const nonPublic = new NodeNet.BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["224.0.0.0", 3],
] as const) {
  nonPublic.addSubnet(address, prefix, "ipv4");
}
for (const [address, prefix] of [
  ["::", 127],
  ["64:ff9b::", 96],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
] as const) {
  nonPublic.addSubnet(address, prefix, "ipv6");
}

const IPV4_MAPPED_PREFIX = "::ffff:";

/** Whether an address is routable on the public internet: not loopback, link-local or private. */
export const isPublicAddress = (address: string): boolean => {
  const mapped = address.toLowerCase().startsWith(IPV4_MAPPED_PREFIX)
    ? address.slice(IPV4_MAPPED_PREFIX.length)
    : address;
  const family = NodeNet.isIP(mapped);
  if (family === 0) return false;
  return !nonPublic.check(mapped, family === 4 ? "ipv4" : "ipv6");
};

/** The host as an address when the URL names one directly, without the brackets IPv6 uses. */
export const literalAddress = (url: URL): string | null => {
  const host = url.hostname.replace(/^\[|\]$/g, "");
  return NodeNet.isIP(host) === 0 ? null : host;
};
