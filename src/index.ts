import { Hono } from "hono";
import { configureAppServer } from "@shopware-ag/app-server-sdk/integration/hono";
import {
  CloudflareShopRepository,
  CloudflareHttpClientTokenCache,
} from "@shopware-ag/app-server-sdk/integration/cloudflare-kv";
import { EntityRepository } from "@shopware-ag/app-server-sdk/helper/admin-api";
import { Criteria } from "@shopware-ag/app-server-sdk/helper/criteria";
import { HttpClient } from "@shopware-ag/app-server-sdk";
import type { Context, ShopInterface } from "@shopware-ag/app-server-sdk";
import { parseServiceAccount, sendPush } from "./fcm";
import { parseApnsConfig, sendApnsPush, type ApnsEnv } from "./apns";

type Env = CloudflareBindings;

interface FcnEntry {
  id: string;
  token: string;
  /** "apns" → deliver natively via APNs; anything else (incl. null, legacy rows) → FCM. */
  platform?: string | null;
  deviceName?: string | null;
}

interface TokenCache {
  syncedAt: number;
  devices: FcnEntry[];
}

const TOKEN_CACHE_TTL_MS = 5 * 60 * 1000;

interface OrderPlacedPayload {
  data: {
    event: string;
    payload: {
      order?: {
        id?: string;
        orderNumber?: string;
        amountTotal?: number;
        orderCustomer?: { firstName?: string; lastName?: string } | null;
        currency?: { isoCode?: string } | null;
      };
    };
  };
  source: { url: string; shopId: string };
}

const app = new Hono<{ Bindings: Env }>();

configureAppServer(app as unknown as Hono, {
  appName: (c) => c.env.SHOPWARE_APP_NAME,
  appSecret: (c) => c.env.SHOPWARE_APP_SECRET,
  shopRepository: (c) => new CloudflareShopRepository(c.env.SHOP_STORAGE),
  httpClientTokenCache: (c) => new CloudflareHttpClientTokenCache(c.env.SHOP_STORAGE),
});

app.post("/app/webhook/order-placed", async (c) => {
  const ctx = c.get("context") as Context<ShopInterface, OrderPlacedPayload>;
  const order = ctx.payload.data?.payload?.order;
  if (!order) {
    console.warn(`order-placed webhook from shop ${ctx.shop.getShopId()} carried no order payload`);
    return c.body(null, 204);
  }

  c.executionCtx.waitUntil(
    notifyDevices(c.env, ctx.httpClient, ctx.shop.getShopId(), ctx.payload.source.url, order),
  );
  return c.body(null, 204);
});

function cacheKey(shopId: string): string {
  return `fcn_tokens_${shopId}`;
}

async function syncTokenCache(env: Env, httpClient: HttpClient, shopId: string): Promise<FcnEntry[]> {
  const repository = new EntityRepository<FcnEntry>(httpClient, "ce_fcn");
  const devices: FcnEntry[] = [];

  for (let page = 1; page <= 10; page++) {
    const criteria = new Criteria<FcnEntry>();
    criteria.setLimit(100);
    criteria.setPage(page);
    const result = await repository.search(criteria);
    devices.push(
      ...result.data.map((d) => ({
        id: d.id,
        token: d.token,
        platform: d.platform,
        deviceName: d.deviceName,
      })),
    );
    if (result.data.length < 100) {
      break;
    }
  }
  await putTokenCache(env, shopId, devices);
  console.log(`synced ${devices.length} device tokens for shop ${shopId}`);
  return devices;
}

async function putTokenCache(env: Env, shopId: string, devices: FcnEntry[]): Promise<void> {
  const cache: TokenCache = { syncedAt: Date.now(), devices };
  await env.SHOP_STORAGE.put(cacheKey(shopId), JSON.stringify(cache));
}

async function getDevices(env: Env, httpClient: HttpClient, shopId: string): Promise<FcnEntry[]> {
  const cached = await env.SHOP_STORAGE.get<TokenCache>(cacheKey(shopId), "json");
  if (cached && Date.now() - cached.syncedAt < TOKEN_CACHE_TTL_MS) {
    return cached.devices;
  }
  return syncTokenCache(env, httpClient, shopId);
}

async function notifyDevices(
  env: Env,
  httpClient: HttpClient,
  shopId: string,
  shopUrl: string,
  order: NonNullable<OrderPlacedPayload["data"]["payload"]["order"]>,
): Promise<void> {
  const devices = await getDevices(env, httpClient, shopId);
  console.log(`order ${order.orderNumber ?? order.id}: ${devices.length} registered devices for shop ${shopId}`);
  if (devices.length === 0) {
    return;
  }

  const customer = [order.orderCustomer?.firstName, order.orderCustomer?.lastName]
    .filter(Boolean)
    .join(" ");
  const amount =
    order.amountTotal != null && order.currency?.isoCode
      ? new Intl.NumberFormat("en", { style: "currency", currency: order.currency.isoCode }).format(
          order.amountTotal,
        )
      : null;

  const title = order.orderNumber ? `New order #${order.orderNumber}` : "New order";
  const body = [customer, amount].filter(Boolean).join(" • ") || "An order was just placed.";
  const data = {
    event: "order.placed",
    shopId,
    shopUrl,
    orderId: order.id ?? "",
    orderNumber: order.orderNumber ?? "",
  };

  // Parse each provider config lazily — a shop with only APNs devices needs no FCM creds, and vice
  // versa. Errors here (missing secret) are logged per-device rather than failing the whole batch.
  const account = env.FCM_SERVICE_ACCOUNT ? parseServiceAccount(env.FCM_SERVICE_ACCOUNT) : null;
  let apns: ReturnType<typeof parseApnsConfig> | null = null;
  try {
    // APNS_* are worker secrets, not committed vars, so they aren't in the generated env type.
    apns = parseApnsConfig(env as unknown as ApnsEnv);
  } catch {
    apns = null;
  }

  const staleIds: string[] = [];
  const results = await Promise.allSettled(
    devices.map(async (device) => {
      let result: "ok" | "unregistered" | "error";
      if (device.platform === "apns") {
        if (!apns) throw new Error(`device ${device.id} is apns but APNS_* secrets are unset`);
        result = await sendApnsPush(apns, { token: device.token, title, body, data });
      } else {
        if (!account) throw new Error(`device ${device.id} is fcm but FCM_SERVICE_ACCOUNT is unset`);
        result = await sendPush(account, { token: device.token, notification: { title, body }, data });
      }
      if (result === "unregistered") {
        staleIds.push(device.id);
      }
      return result;
    }),
  );

  const sent = results.filter((r) => r.status === "fulfilled" && r.value === "ok").length;
  console.log(
    `order ${order.orderNumber ?? order.id}: pushed to ${sent}/${devices.length} devices of shop ${shopId}`,
  );
  for (const failure of results.filter((r) => r.status === "rejected")) {
    console.error(`push failed: ${(failure as PromiseRejectedResult).reason}`);
  }

  if (staleIds.length > 0) {
    const repository = new EntityRepository<FcnEntry>(httpClient, "ce_fcn");
    await repository.delete(staleIds.map((id) => ({ id })));
    await putTokenCache(env, shopId, devices.filter((d) => !staleIds.includes(d.id)));
    console.log(`removed ${staleIds.length} unregistered device tokens for shop ${shopId}`);
  }
}

export default app;
