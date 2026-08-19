// Regression cover for the Control UI HTTP read surfaces over Tailscale Serve.
// Verified tailnet identity may read the metadata-only bootstrap config without
// a token (#67915) and may mint the source-scoped assistant-media ticket from a
// same-origin dashboard fetch, but it is not paired-device authentication: it
// must confer no operator authority, and it must never reach a route that
// serves local media bytes without that minted ticket or a real credential.
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
import {
  handleControlUiAssistantMediaRequest,
  handleControlUiAvatarRequest,
  handleControlUiHttpRequest,
} from "./control-ui.js";
import { markGatewayIngressTransport } from "./ingress-attribution.js";
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
 * Serve listener applies; without it the forwarded headers are unattributable.
 */
function tailscaleServeRequest(params: {
  url: string;
  headers?: IncomingMessage["headers"];
}): IncomingMessage {
  const req = {
    url: params.url,
    method: "GET",
    socket: { remoteAddress: "127.0.0.1", localPort: 18_789 },
    headers: {
      host: "gateway.local",
      "x-forwarded-for": "100.64.0.1",
      "x-forwarded-proto": "https",
      "x-forwarded-host": "ai-hub.bone-egret.ts.net",
      "tailscale-user-login": "peter@github",
      "tailscale-user-name": "Peter",
      "sec-fetch-site": "same-origin",
      ...params.headers,
    },
  } as unknown as IncomingMessage;
  markGatewayIngressTransport(req, { kind: "managed-tailscale", mode: "serve" });
  return req;
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

  it("mints a scoped assistant-media ticket for a same-origin Tailscale Serve read", async () => {
    testTailscaleWhois.value = { login: "peter@github", name: "Peter" };
    const mediaDir = path.join(resolveStateDir(), "media", "tailscale-scopes-mint");
    await fs.mkdir(mediaDir, { recursive: true });
    const filePath = path.join(
      mediaDir,
      `ticket-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`,
    );
    await fs.writeFile(filePath, "tailscale serve attachment\n", "utf8");
    try {
      const { res, end } = makeMockHttpResponse();
      const handled = await handleControlUiAssistantMediaRequest(
        tailscaleServeRequest({
          url: `/__openclaw__/assistant-media?meta=1&source=${encodeURIComponent(filePath)}`,
        }),
        res,
        { auth: TAILSCALE_AUTH },
      );

      expect(handled).toBe(true);
      expect(res.statusCode).toBe(200);
      // The mint is the recovery: the source-scoped, short-lived ticket is the
      // only way a tokenless Serve dashboard reaches the credential-bound byte
      // read, and this metadata response serves no file bytes itself.
      const body = readResponseBody(end);
      expect(body).toContain('"available":true');
      expect(body).toContain('"mediaTicket":"v1.');
    } finally {
      await fs.rm(mediaDir, { recursive: true, force: true });
    }
  });

  it("still refuses a cross-site assistant-media ticket mint over Tailscale Serve", async () => {
    testTailscaleWhois.value = { login: "peter@github", name: "Peter" };
    const { res, end } = makeMockHttpResponse();
    const handled = await handleControlUiAssistantMediaRequest(
      tailscaleServeRequest({
        url: "/__openclaw__/assistant-media?source=/etc/hosts&meta=1",
        headers: { "sec-fetch-site": "cross-site" },
      }),
      res,
      { auth: TAILSCALE_AUTH },
    );

    expect(handled).toBe(true);
    expect(res.statusCode).toBe(401);
    expect(readResponseBody(end)).not.toContain("mediaTicket");
  });

  it("refuses an assistant-media byte read for a device-less Tailscale browser", async () => {
    testTailscaleWhois.value = { login: "peter@github", name: "Peter" };
    const { res } = makeMockHttpResponse();
    const handled = await handleControlUiAssistantMediaRequest(
      tailscaleServeRequest({ url: "/__openclaw__/assistant-media?source=/etc/hosts" }),
      res,
      { auth: TAILSCALE_AUTH },
    );

    expect(handled).toBe(true);
    expect(res.statusCode).toBe(401);
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
