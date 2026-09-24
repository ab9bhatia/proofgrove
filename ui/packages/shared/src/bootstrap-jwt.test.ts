import { describe, expect, it } from "vitest";
import { SignJWT } from "jose";
import {
  BOOTSTRAP_UI_APP,
  bootstrapTokenMatchesTenant,
  checkBootstrapTokenTenant,
  parseAppHost,
} from "./bootstrap-jwt";

const ROUTING_DOMAIN = "evalai.ai";
const SECRET = new TextEncoder().encode("test-secret");

async function makeBootstrapToken(
  tenant: string,
  scope = "bootstrap",
): Promise<string> {
  return new SignJWT({ tenant, scope })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject("admin@example.com")
    .sign(SECRET);
}

describe("parseAppHost", () => {
  it("extracts app and tenant from a standard host", () => {
    expect(
      parseAppHost(`evalai-tenant-ui.alpine.${ROUTING_DOMAIN}`, ROUTING_DOMAIN),
    ).toEqual({ app: BOOTSTRAP_UI_APP, tenant: "alpine" });
  });

  it("strips numeric port and normalises case", () => {
    expect(
      parseAppHost(
        `EvalAI-Tenant-UI.Alpine.${ROUTING_DOMAIN}:8443`,
        ROUTING_DOMAIN,
      ),
    ).toEqual({ app: "evalai-tenant-ui", tenant: "alpine" });
  });

  it("rejects non-numeric port suffixes", () => {
    expect(
      parseAppHost(
        `evalai-tenant-ui.alpine.${ROUTING_DOMAIN}:notaport`,
        ROUTING_DOMAIN,
      ),
    ).toBeNull();
  });

  it("returns null for unrecognised hosts", () => {
    expect(parseAppHost("unknown.example.com", ROUTING_DOMAIN)).toBeNull();
  });

  it("returns null when prefix has more than two segments", () => {
    expect(
      parseAppHost(
        `evalai-tenant-ui.alpine.extra.${ROUTING_DOMAIN}`,
        ROUTING_DOMAIN,
      ),
    ).toBeNull();
  });
});

describe("checkBootstrapTokenTenant", () => {
  it("returns match when the tenant claim equals the expected tenant ID", async () => {
    const token = await makeBootstrapToken("iso-a");
    expect(checkBootstrapTokenTenant(token, "iso-a")).toBe("match");
    expect(bootstrapTokenMatchesTenant(token, "iso-a")).toBe(true);
  });

  it("returns mismatch for a well-formed bootstrap JWT with a different tenant", async () => {
    const token = await makeBootstrapToken("iso-a");
    expect(checkBootstrapTokenTenant(token, "iso-b")).toBe("mismatch");
    expect(bootstrapTokenMatchesTenant(token, "iso-b")).toBe(false);
  });

  it("returns invalid for malformed tokens (not mismatch)", () => {
    expect(checkBootstrapTokenTenant("not-a-jwt", "iso-a")).toBe("invalid");
    expect(bootstrapTokenMatchesTenant("not-a-jwt", "iso-a")).toBe(false);
  });

  it("returns invalid for wrong scope or missing tenant claim", async () => {
    const wrongScope = await makeBootstrapToken("iso-a", "openid");
    expect(checkBootstrapTokenTenant(wrongScope, "iso-a")).toBe("invalid");

    const noTenant = await new SignJWT({ scope: "bootstrap" })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject("admin@example.com")
      .sign(SECRET);
    expect(checkBootstrapTokenTenant(noTenant, "iso-a")).toBe("invalid");
  });

  it("returns match when expected tenant ID is unset (local / no gateway)", async () => {
    const token = await makeBootstrapToken("iso-a");
    expect(checkBootstrapTokenTenant(token, undefined)).toBe("match");
    expect(checkBootstrapTokenTenant(token, "")).toBe("match");
    expect(bootstrapTokenMatchesTenant(token, undefined)).toBe(true);
    expect(bootstrapTokenMatchesTenant(token, "")).toBe(true);
  });
});
