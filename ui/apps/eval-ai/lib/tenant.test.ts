import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  namespaceForTenant,
  resolveTenant,
  TenantContextError,
} from "./tenant";

describe("namespaceForTenant", () => {
  it("prefixes a valid tenant slug", () => {
    expect(namespaceForTenant("classroom-qa")).toBe("tenant-classroom-qa");
  });

  it("preserves a valid tenant namespace", () => {
    expect(namespaceForTenant("tenant-classroom")).toBe("tenant-classroom");
  });

  it.each(["", "../other", "Tenant-A", "kube-system", "tenant-kube-system"])(
    "rejects invalid or system tenant context %j",
    (tenant) => {
      expect(() => namespaceForTenant(tenant)).toThrow(TenantContextError);
    },
  );
});

describe("resolveTenant", () => {
  it("uses the pod namespace as the authority", () => {
    expect(resolveTenant({ POD_NAMESPACE: "tenant-classroom" })).toBe(
      "tenant-classroom",
    );
  });

  it.each([undefined, "", "classroom", "kube-system", "tenant-"])(
    "fails closed when POD_NAMESPACE is %j",
    (namespace) => {
      expect(() => resolveTenant({ POD_NAMESPACE: namespace })).toThrow(
        TenantContextError,
      );
    },
  );
});
