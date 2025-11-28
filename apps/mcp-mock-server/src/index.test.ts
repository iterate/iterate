import { verifyBearerAuth, verifyBearerHeaderPresent } from "./auth.ts";

describe("bearer auth for /bearer", () => {
  test("returns 401 when expected token provided and Authorization missing", async () => {
    const req = new Request("http://localhost/bearer");
    const res = verifyBearerAuth(req, "secret")!;
    expect(res.status).toBe(401);
    expect(res.headers.get("WWW-Authenticate")).toContain("Bearer");
  });

  test("returns 401 when expected token provided and Authorization invalid", async () => {
    const req = new Request("http://localhost/bearer", {
      headers: { Authorization: "Bearer wrong" },
    });
    const res = verifyBearerAuth(req, "secret")!;
    expect(res.status).toBe(401);
    expect(res.headers.get("WWW-Authenticate")).toContain("invalid_token");
  });
});

describe("bearer presence checker", () => {
  test("returns 401 when Authorization header is missing", async () => {
    const req = new Request("http://localhost/bearer");
    const res = verifyBearerHeaderPresent(req)!;
    expect(res.status).toBe(401);
  });
  test("passes when Authorization header has Bearer token", async () => {
    const req = new Request("http://localhost/bearer", {
      headers: { Authorization: "Bearer anything" },
    });
    const res = verifyBearerHeaderPresent(req);
    expect(res).toBeNull();
  });
});
