import { describe, expect, it } from "vitest";
import { GATEWAY_SUBJECT_HEADER, resolveUser } from "./user";
import { SignJWT } from "jose";

const SECRET = new TextEncoder().encode("test-secret");

async function makeRequest(claims: Record<string, unknown>): Promise<Request> {
  const token = await new SignJWT(claims)
    .setProtectedHeader({ alg: "HS256" })
    .sign(SECRET);
  return new Request("http://localhost/api/user", {
    headers: { authorization: `Bearer ${token}` },
  });
}

function makeRequestNoAuth(headers: Record<string, string> = {}): Request {
  return new Request("http://localhost/api/user", { headers });
}

describe("resolveUser", () => {
  it("returns first and last name from given_name/family_name claims", async () => {
    const req = await makeRequest({ given_name: "Jordan", family_name: "Doe" });
    expect(resolveUser(req)).toEqual({
      firstName: "Jordan",
      lastName: "Doe",
      email: "",
    });
  });

  it("splits full name claim on last space when given_name/family_name absent", async () => {
    const req = await makeRequest({ name: "Jordan Doe" });
    expect(resolveUser(req)).toEqual({
      firstName: "Jordan",
      lastName: "Doe",
      email: "",
    });
  });

  it("handles multi-word first name by splitting on last space", async () => {
    const req = await makeRequest({ name: "Mary Jane Watson" });
    expect(resolveUser(req)).toEqual({
      firstName: "Mary Jane",
      lastName: "Watson",
      email: "",
    });
  });

  it("returns full name as firstName with empty lastName when no space", async () => {
    const req = await makeRequest({ name: "Cher" });
    expect(resolveUser(req)).toEqual({
      firstName: "Cher",
      lastName: "",
      email: "",
    });
  });

  it("returns empty strings when no Authorization header", () => {
    const req = makeRequestNoAuth();
    expect(resolveUser(req)).toEqual({
      firstName: "",
      lastName: "",
      email: "",
    });
  });

  it("trims given_name and family_name", async () => {
    const req = await makeRequest({ given_name: "  Jordan  ", family_name: "  Doe  " });
    expect(resolveUser(req)).toEqual({
      firstName: "Jordan",
      lastName: "Doe",
      email: "",
    });
  });

  it("strips trailing parenthetical from name claim (e.g. external/contractor tag)", async () => {
    const req = await makeRequest({ name: "Diana John (E)" });
    expect(resolveUser(req)).toEqual({
      firstName: "Diana",
      lastName: "John",
      email: "",
    });
  });

  it("strips inline parenthetical from name claim", async () => {
    const req = await makeRequest({ name: "Diana John(E)" });
    expect(resolveUser(req)).toEqual({
      firstName: "Diana",
      lastName: "John",
      email: "",
    });
  });

  it("strips parenthetical from given_name and family_name claims", async () => {
    const req = await makeRequest({ given_name: "Diana", family_name: "John (E)" });
    expect(resolveUser(req)).toEqual({
      firstName: "Diana",
      lastName: "John",
      email: "",
    });
  });

  it("handles compound names with parenthetical annotation", async () => {
    const req = await makeRequest({ name: "Jose Luis Perez Gonzalez (C)" });
    expect(resolveUser(req)).toEqual({
      firstName: "Jose Luis Perez",
      lastName: "Gonzalez",
      email: "",
    });
  });

  it("returns the email claim alongside the name", async () => {
    const req = await makeRequest({ name: "Jordan Doe", email: "jordan@corp.example" });
    expect(resolveUser(req)).toEqual({
      firstName: "Jordan",
      lastName: "Doe",
      email: "jordan@corp.example",
    });
  });

  // Issue #2742: after a platform admin resets SSO the tenant drops to
  // bootstrap mode, so Envoy forwards no access token — but ext_authz still
  // names the caller. Without this the UI degrades to an anonymous "User".
  it("falls back to the gateway-asserted subject when no token is forwarded", () => {
    const req = makeRequestNoAuth({ [GATEWAY_SUBJECT_HEADER]: "admin@corp.example" });
    expect(resolveUser(req)).toEqual({
      firstName: "",
      lastName: "",
      email: "admin@corp.example",
    });
  });

  it("ignores a non-address gateway subject (opaque OIDC sub)", () => {
    const req = makeRequestNoAuth({ [GATEWAY_SUBJECT_HEADER]: "e3f1c0aa-1234" });
    expect(resolveUser(req)).toEqual({ firstName: "", lastName: "", email: "" });
  });

  it("prefers token claims over the gateway-asserted subject", async () => {
    const token = await new SignJWT({ name: "Jordan Doe", upn: "jordan@corp.example" })
      .setProtectedHeader({ alg: "HS256" })
      .sign(SECRET);
    const req = new Request("http://localhost/api/user", {
      headers: {
        authorization: `Bearer ${token}`,
        [GATEWAY_SUBJECT_HEADER]: "someone-else@corp.example",
      },
    });
    expect(resolveUser(req)).toEqual({
      firstName: "Jordan",
      lastName: "Doe",
      email: "jordan@corp.example",
    });
  });
});
