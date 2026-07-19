import type { PushResult } from "./fcm";

export interface ApnsConfig {
  /** APNs Auth Key (.p8) contents, PEM. Newlines may be literal or escaped (\n). */
  keyP8: string;
  /** The 10-char Key ID of the .p8. */
  keyId: string;
  /** The 10-char Apple Team ID. */
  teamId: string;
  /** The app bundle id, sent as `apns-topic`. */
  topic: string;
  /** false → api.push.apple.com (production); true → api.sandbox.push.apple.com. */
  sandbox?: boolean;
}

export interface ApnsMessage {
  /** Hex APNs device token (the ce_fcn row's token when platform === "apns"). */
  token: string;
  title: string;
  body: string;
  /** Custom keys placed alongside `aps` — the app reads these on tap for deep-linking. */
  data: Record<string, string>;
}

/** The APNs-related worker secrets (set via `wrangler secret put`, so not in the generated env type). */
export interface ApnsEnv {
  APNS_KEY_P8?: string;
  APNS_KEY_ID?: string;
  APNS_TEAM_ID?: string;
  APNS_TOPIC?: string;
  APNS_SANDBOX?: string;
}

export function parseApnsConfig(env: ApnsEnv): ApnsConfig {
  if (!env.APNS_KEY_P8 || !env.APNS_KEY_ID || !env.APNS_TEAM_ID || !env.APNS_TOPIC) {
    throw new Error("APNS_KEY_P8 / APNS_KEY_ID / APNS_TEAM_ID / APNS_TOPIC must all be set");
  }
  return {
    keyP8: env.APNS_KEY_P8,
    keyId: env.APNS_KEY_ID,
    teamId: env.APNS_TEAM_ID,
    topic: env.APNS_TOPIC,
    sandbox: env.APNS_SANDBOX === "true",
  };
}

function base64UrlEncode(data: ArrayBuffer | string): string {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : new Uint8Array(data);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function pemToPkcs8(pem: string): ArrayBuffer {
  const body = pem
    .replace("-----BEGIN PRIVATE KEY-----", "")
    .replace("-----END PRIVATE KEY-----", "")
    .replaceAll("\\n", "")
    .replaceAll("\n", "")
    .trim();
  const binary = atob(body);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

// APNs provider tokens are valid up to 60 min; refresh well before that.
let cachedToken: { token: string; expiresAt: number; keyId: string } | null = null;

/** A signed ES256 provider token (`iss`=teamId, `kid`=keyId), cached ~50 min. */
export async function getProviderToken(config: ApnsConfig): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  if (cachedToken && cachedToken.keyId === config.keyId && cachedToken.expiresAt > now + 300) {
    return cachedToken.token;
  }

  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemToPkcs8(config.keyP8),
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );

  const header = base64UrlEncode(JSON.stringify({ alg: "ES256", kid: config.keyId }));
  const claims = base64UrlEncode(JSON.stringify({ iss: config.teamId, iat: now }));
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    new TextEncoder().encode(`${header}.${claims}`),
  );
  // WebCrypto returns the raw r||s signature APNs' JWT wants (JOSE ES256) — no DER unwrap needed.
  const token = `${header}.${claims}.${base64UrlEncode(signature)}`;
  cachedToken = { token, expiresAt: now + 3000, keyId: config.keyId };
  return token;
}

/**
 * Send one alert push over native APNs (HTTP/2). Returns "unregistered" on 410 (dead token → the
 * caller prunes the ce_fcn row, same contract as the FCM path's UNREGISTERED).
 */
export async function sendApnsPush(config: ApnsConfig, message: ApnsMessage): Promise<PushResult> {
  const providerToken = await getProviderToken(config);
  const host = config.sandbox ? "api.sandbox.push.apple.com" : "api.push.apple.com";

  const response = await fetch(`https://${host}/3/device/${message.token}`, {
    method: "POST",
    headers: {
      authorization: `bearer ${providerToken}`,
      "apns-topic": config.topic,
      "apns-push-type": "alert",
      "apns-priority": "10",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      aps: { alert: { title: message.title, body: message.body }, sound: "default" },
      ...message.data,
    }),
  });

  if (response.ok) return "ok";
  const text = await response.text();
  // 410 Gone = the token is no longer valid; 400 with BadDeviceToken likewise.
  if (response.status === 410 || text.includes("BadDeviceToken") || text.includes("Unregistered")) {
    return "unregistered";
  }
  console.error(`APNs send failed (${response.status}): ${text}`);
  return "error";
}
