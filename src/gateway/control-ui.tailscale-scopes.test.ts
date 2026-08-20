// Regression cover for the Control UI HTTP read surfaces over Tailscale Serve.
//
// Verified tailnet identity is ambient: every request from this host carries it,
// so it buys exactly one thing — the metadata-only bootstrap config read that
// lets a tokenless dashboard boot far enough to open its websocket (#67915). It
// confers no operator authority and mints no capability.
//
// Everything on the media route is device-bound instead. Once that websocket
// connect authenticates, the Gateway hands the browser a credential bound to the
// device that proved its keypair, and metadata, ticket minting, and bytes all
// run off that credential or a real one.
import fs from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveStateDir } from "../config/paths.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../plugins/runtime.js";
import type { ResolvedGatewayAuth } from "./auth.js";
import {
  CONTROL_UI_BOOTSTRAP_CONFIG_PATH,
  type ControlUiPluginFrameGrantAck,
} from "./control-ui-contract.js";
import { issueControlUiDeviceCredential } from "./control-ui-device-credential.js";
import {
  handleControlUiAssistantMediaRequest,
  handleControlUiAvatarRequest,
  handleControlUiHttpRequest,
} from "./control-ui.js";
import { markGatewayIngressTransport } from "./ingress-attribution.js";
import { resolveSharedGatewaySessionGeneration } from "./server/ws-shared-generation.js";
import { testTailscaleWhois } from "./test-helpers.runtime-state.js";
import { makeMockHttpResponse } from "./test-http-response.js";

vi.mock("../infra/tailscale.js", async () => {
  const actual =
    await vi.importActual<typeof import("../infra/tailscale.js")>("../infra/tailscale.js");
  return {
    ...actual,
    readTailscaleWhoisIdentity: async () => testTailscaleWhois.value,
  };
});

const TAILSCALE_AUTH: ResolvedGatewayAuth = {
  mode: "token",
  token: "shared-token",
  allowTailscale: true,
};

/**
 * A same-origin dashboard fetch arriving through managed Tailscale Serve with no
 * shared secret and no paired device token. The transport marking is what the
 * Serve listener applies; without it the forwarded headers are unattributable,
 * so `managedServe: false` models the same headers replayed off that ingress.
 */
function tailscaleServeRequest(params: {
  url: string;
  headers?: IncomingMessage["headers"];
}): IncomingMessage {
  const headers = {
    host: "gateway.local",
    "x-forwarded-for": "100.64.0.1",
    "x-forwarded-proto": "https",
    "x-forwarded-host": "ai-hub.bone-egret.ts.net",
    "tailscale-user-login": "peter@github",
    "tailscale-user-name": "Peter",
    "sec-fetch-site": "same-origin",
    ...params.headers,
  };
  const req = {
    url: params.url,
    method: "GET",
    socket: { remoteAddress: "127.0.0.1", localPort: 18_789 },
    headers,
    headersDistinct: Object.fromEntries(
      Object.entries(headers).map(([name, value]) => [name, [String(value)]]),
    ),
  } as unknown as IncomingMessage;
  markGatewayIngressTransport(req, { kind: "managed-tailscale", mode: "serve" });
  return req;
}

/**
 * A same-origin request reaching the Gateway's own port instead of the managed
 * Serve listener — where a credential lifted off the dashboard would be replayed.
 * Carries no tailnet headers, so it attributes cleanly as a direct remote client
 * and any refusal is a real auth decision.
 */
function offServeIngressRequest(params: {
  url: string;
  headers?: IncomingMessage["headers"];
}): IncomingMessage {
  return {
    url: params.url,
    method: "GET",
    socket: { remoteAddress: "192.168.1.50", localPort: 18_789 },
    headers: {
      host: "gateway.local",
      "sec-fetch-site": "same-origin",
      ...params.headers,
    },
  } as unknown as IncomingMessage;
}

/** Tailnet-shaped headers set by a client that is not behind managed Serve. */
function spoofedTailscaleHeaderRequest(url: string): IncomingMessage {
  return offServeIngressRequest({
    url,
    headers: { "tailscale-user-login": "peter@github", "tailscale-user-name": "Peter" },
  });
}

/**
 * The credential the connect handshake hands a Serve dashboard once its
 * websocket authenticates. Minted through the production issuer so this proves
 * the HTTP side accepts exactly what hello-ok emits.
 */
function postConnectDeviceCredential(): string {
  const issued = issueControlUiDeviceCredential({
    deviceId: "device-tailscale-serve-dashboard",
    authGeneration: resolveSharedGatewaySessionGeneration(TAILSCALE_AUTH),
  });
  if (!issued) {
    throw new Error("expected a device-bound Control UI credential");
  }
  return issued.credential;
}

async function withAssistantMediaFile<T>(
  name: string,
  fn: (filePath: string) => Promise<T>,
): Promise<T> {
  const mediaDir = path.join(resolveStateDir(), "media", name);
  await fs.mkdir(mediaDir, { recursive: true });
  const filePath = path.join(
    mediaDir,
    `media-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`,
  );
  await fs.writeFile(filePath, "tailscale serve attachment\n", "utf8");
  try {
    return await fn(filePath);
  } finally {
    await fs.rm(mediaDir, { recursive: true, force: true });
  }
}

async function runAssistantMediaRequest(req: IncomingMessage) {
  const { res, end, setHeader } = makeMockHttpResponse();
  const handled = await handleControlUiAssistantMediaRequest(req, res, { auth: TAILSCALE_AUTH });
  return { res, end, setHeader, handled };
}

/** Register one plugin tab that only an operator.admin caller may open. */
function registerAdminOnlyPluginTab(): void {
  const registry = createEmptyPluginRegistry();
  registry.controlUiDescriptors.push({
    pluginId: "demo-plugin",
    source: "demo-plugin",
    descriptor: {
      surface: "tab",
      id: "demo",
      label: "Demo",
      path: "/secure-hook/panel",
      requiredScopes: ["operator.admin"],
    },
  });
  registry.httpRoutes.push({
    pluginId: "demo-plugin",
    source: "demo-plugin",
    path: "/secure-hook",
    auth: "gateway",
    match: "prefix",
    handler: async () => true,
  });
  setActivePluginRegistry(registry);
}

async function withControlUiRoot<T>(fn: (tmp: string) => Promise<T>): Promise<T> {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-ui-ts-scopes-"));
  try {
    await fs.writeFile(path.join(tmp, "index.html"), "<html></html>\n");
    return await fn(tmp);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
}

async function runBootstrapConfigRequest(params: { rootPath: string; req: IncomingMessage }) {
  const { res, end, setHeader } = makeMockHttpResponse();
  const handled = await handleControlUiHttpRequest(params.req, res, {
    auth: TAILSCALE_AUTH,
    root: { kind: "resolved", path: params.rootPath },
  });
  return { res, end, setHeader, handled };
}

function readResponseBody(end: ReturnType<typeof makeMockHttpResponse>["end"]): string {
  return end.mock.calls.map((call) => String(call[0] ?? "")).join("");
}

function readPluginFrameGrants(
  end: ReturnType<typeof makeMockHttpResponse>["end"],
): ControlUiPluginFrameGrantAck[] | undefined {
  return (
    JSON.parse(readResponseBody(end)) as { pluginFrameGrants?: ControlUiPluginFrameGrantAck[] }
  ).pluginFrameGrants;
}

function pluginAuthCookieCalls(setHeader: ReturnType<typeof vi.fn>): unknown[] {
  return setHeader.mock.calls.filter((call) => String(call[0]).toLowerCase() === "set-cookie");
}

describe("control ui HTTP reads over Tailscale", () => {
  afterEach(() => {
    testTailscaleWhois.value = null;
    resetPluginRuntimeStateForTest();
    vi.restoreAllMocks();
  });

  it("serves the bootstrap config for a device-less Tailscale browser (#67915)", async () => {
    testTailscaleWhois.value = { login: "peter@github", name: "Peter" };
    await withControlUiRoot(async (tmp) => {
      const { res, handled } = await runBootstrapConfigRequest({
        rootPath: tmp,
        req: tailscaleServeRequest({ url: CONTROL_UI_BOOTSTRAP_CONFIG_PATH }),
      });
      expect(handled).toBe(true);
      expect(res.statusCode).toBe(200);
    });
  });

  it("grants no plugin frames and mints no plugin cookie for a device-less Tailscale browser", async () => {
    testTailscaleWhois.value = { login: "peter@github", name: "Peter" };
    registerAdminOnlyPluginTab();
    await withControlUiRoot(async (tmp) => {
      const { res, end, setHeader } = await runBootstrapConfigRequest({
        rootPath: tmp,
        req: tailscaleServeRequest({ url: CONTROL_UI_BOOTSTRAP_CONFIG_PATH }),
      });
      expect(res.statusCode).toBe(200);
      // An admin-gated tab would only project if the request had been resolved
      // with CLI_DEFAULT_OPERATOR_SCOPES, which is exactly the amplification
      // this surface must not perform.
      expect(readPluginFrameGrants(end)).toEqual([]);
      expect(pluginAuthCookieCalls(setHeader)).toEqual([]);
    });
  });

  it("ignores a self-asserted x-openclaw-scopes header on the Tailscale read path", async () => {
    testTailscaleWhois.value = { login: "peter@github", name: "Peter" };
    registerAdminOnlyPluginTab();
    await withControlUiRoot(async (tmp) => {
      const { res, end, setHeader } = await runBootstrapConfigRequest({
        rootPath: tmp,
        req: tailscaleServeRequest({
          url: CONTROL_UI_BOOTSTRAP_CONFIG_PATH,
          headers: { "x-openclaw-scopes": "operator.admin,operator.write,operator.pairing" },
        }),
      });
      expect(res.statusCode).toBe(200);
      expect(readPluginFrameGrants(end)).toEqual([]);
      expect(pluginAuthCookieCalls(setHeader)).toEqual([]);
    });
  });

  it("still issues plugin frame grants for shared-secret bootstrap", async () => {
    registerAdminOnlyPluginTab();
    await withControlUiRoot(async (tmp) => {
      const { res, end } = await runBootstrapConfigRequest({
        rootPath: tmp,
        req: {
          url: CONTROL_UI_BOOTSTRAP_CONFIG_PATH,
          method: "GET",
          headers: { host: "gateway.local", authorization: "Bearer shared-token" },
          socket: { remoteAddress: "127.0.0.1" },
        } as IncomingMessage,
      });
      expect(res.statusCode).toBe(200);
      // Proves the grant assertions above are not vacuous: the same registry and
      // the same route do issue grants when the caller proves operator authority.
      expect(readPluginFrameGrants(end)).toEqual([
        { pluginId: "demo-plugin", path: "/secure-hook", match: "prefix" },
      ]);
    });
  });

  it("refuses an ambient assistant-media ticket mint over Tailscale Serve", async () => {
    testTailscaleWhois.value = { login: "peter@github", name: "Peter" };
    await withAssistantMediaFile("tailscale-scopes-ambient-mint", async (filePath) => {
      const { res, end, handled } = await runAssistantMediaRequest(
        tailscaleServeRequest({
          url: `/__openclaw__/assistant-media?meta=1&source=${encodeURIComponent(filePath)}`,
        }),
      );

      expect(handled).toBe(true);
      // Ambient tailnet identity reaches neither half of this route. The metadata
      // read is a capability mint, so allowing it here would hand any same-origin
      // page on the tailnet a byte-read ticket with no credential at all.
      expect(res.statusCode).toBe(401);
      const body = readResponseBody(end);
      expect(body).not.toContain("mediaTicket");
      expect(body).not.toContain('"available"');
    });
  });

  it("completes metadata to ticket to bytes for a post-connect device credential", async () => {
    testTailscaleWhois.value = { login: "peter@github", name: "Peter" };
    await withAssistantMediaFile("tailscale-scopes-device-bound", async (filePath) => {
      const source = encodeURIComponent(filePath);
      const meta = await runAssistantMediaRequest(
        tailscaleServeRequest({
          url: `/__openclaw__/assistant-media?meta=1&source=${source}`,
          headers: { authorization: `Bearer ${postConnectDeviceCredential()}` },
        }),
      );

      expect(meta.handled).toBe(true);
      expect(meta.res.statusCode).toBe(200);
      const availability = JSON.parse(readResponseBody(meta.end)) as {
        available?: boolean;
        mediaTicket?: string;
      };
      expect(availability.available).toBe(true);
      expect(availability.mediaTicket ?? "").toMatch(/^v1\./);

      // The ticket the credential bought is what unlocks the bytes, so the whole
      // recovered path is bound to a websocket connect that authenticated.
      const bytes = await runAssistantMediaRequest(
        tailscaleServeRequest({
          url: `/__openclaw__/assistant-media?source=${source}&mediaTicket=${encodeURIComponent(
            availability.mediaTicket ?? "",
          )}`,
        }),
      );
      expect(bytes.handled).toBe(true);
      expect(bytes.res.statusCode).toBe(200);
    });
  });

  it("refuses a device credential replayed off the managed Serve ingress", async () => {
    testTailscaleWhois.value = { login: "peter@github", name: "Peter" };
    await withAssistantMediaFile("tailscale-scopes-off-ingress", async (filePath) => {
      const { res, end, handled } = await runAssistantMediaRequest(
        offServeIngressRequest({
          url: `/__openclaw__/assistant-media?meta=1&source=${encodeURIComponent(filePath)}`,
          headers: { authorization: `Bearer ${postConnectDeviceCredential()}` },
        }),
      );

      expect(handled).toBe(true);
      // The credential is pinned to the ingress it was issued on: a copy lifted
      // off that browser is worthless anywhere the tailnet does not reach.
      expect(res.statusCode).toBe(401);
      expect(readResponseBody(end)).not.toContain("mediaTicket");
    });
  });

  it("still refuses a cross-site assistant-media ticket mint over Tailscale Serve", async () => {
    testTailscaleWhois.value = { login: "peter@github", name: "Peter" };
    const { res, end, handled } = await runAssistantMediaRequest(
      tailscaleServeRequest({
        url: "/__openclaw__/assistant-media?source=/etc/hosts&meta=1",
        headers: { "sec-fetch-site": "cross-site" },
      }),
    );

    expect(handled).toBe(true);
    expect(res.statusCode).toBe(401);
    expect(readResponseBody(end)).not.toContain("mediaTicket");
  });

  it("refuses an assistant-media byte read for a device-less Tailscale browser", async () => {
    testTailscaleWhois.value = { login: "peter@github", name: "Peter" };
    const { res, handled } = await runAssistantMediaRequest(
      tailscaleServeRequest({ url: "/__openclaw__/assistant-media?source=/etc/hosts" }),
    );

    expect(handled).toBe(true);
    expect(res.statusCode).toBe(401);
  });

  it("keeps the ambient bootstrap read scoped to managed Tailscale Serve ingress", async () => {
    testTailscaleWhois.value = { login: "peter@github", name: "Peter" };
    await withControlUiRoot(async (tmp) => {
      const { res, end } = await runBootstrapConfigRequest({
        rootPath: tmp,
        req: spoofedTailscaleHeaderRequest(CONTROL_UI_BOOTSTRAP_CONFIG_PATH),
      });
      // Tailnet-shaped headers are attacker-supplied on any other ingress, so the
      // request fails closed on attribution before identity is ever consulted:
      // only the managed Serve listener's own marking makes those headers evidence.
      expect(res.statusCode).toBe(403);
      expect(readResponseBody(end)).toContain("proxy_attribution_required");
    });
  });

  it("refuses an avatar read for a device-less Tailscale browser", async () => {
    testTailscaleWhois.value = { login: "peter@github", name: "Peter" };
    const { res } = makeMockHttpResponse();
    const handled = await handleControlUiAvatarRequest(
      tailscaleServeRequest({ url: "/avatar/default" }),
      res,
      { auth: TAILSCALE_AUTH, config: {} },
    );

    expect(handled).toBe(true);
    expect(res.statusCode).toBe(401);
  });
});
