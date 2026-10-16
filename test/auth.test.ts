import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestEnv, registerUser, type TestEnv } from "./helpers.js";

let env: TestEnv;
beforeAll(async () => {
  env = await createTestEnv("2026-11-02T15:12:00Z");
});
afterAll(() => env.close());

describe("auth & profile", () => {
  it("registers, returns initials and a disabled default schedule", async () => {
    const user = await registerUser(env.app);
    const me = await env.app.inject({ method: "GET", url: "/api/v1/me", headers: user.headers });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toMatchObject({ initials: "AZ", firstName: "Alisher", timezone: "Asia/Almaty" });

    const schedule = await env.app.inject({ method: "GET", url: "/api/v1/schedule", headers: user.headers });
    expect(schedule.json()).toMatchObject({
      startTime: "22:30",
      endTime: "07:00",
      repeatLabel: "Weeknights",
      penaltyCents: 500,
      appIds: ["tiktok", "instagram", "youtube"],
      isEnabled: false,
      nextWindow: null,
    });
  });

  it("rejects duplicate emails (case-insensitive) and bad passwords", async () => {
    const payload = { name: "A B", email: "Dup@Example.com", password: "password-123", timezone: "UTC" };
    expect((await env.app.inject({ method: "POST", url: "/api/v1/auth/register", payload })).statusCode).toBe(201);
    const dup = await env.app.inject({
      method: "POST",
      url: "/api/v1/auth/register",
      payload: { ...payload, email: "dup@example.com" },
    });
    expect(dup.statusCode).toBe(409);
    expect(dup.json().error.code).toBe("EMAIL_TAKEN");

    const bad = await env.app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: "dup@example.com", password: "wrong-password" },
    });
    expect(bad.statusCode).toBe(401);
    const good = await env.app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: "DUP@example.com", password: "password-123" },
    });
    expect(good.statusCode).toBe(200);
  });

  it("validates input", async () => {
    const response = await env.app.inject({
      method: "POST",
      url: "/api/v1/auth/register",
      payload: { name: "", email: "nope", password: "short", timezone: "Mars/Olympus" },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("VALIDATION_ERROR");
  });

  it("rotates refresh tokens and revokes everything on reuse", async () => {
    const user = await registerUser(env.app);
    const first = await env.app.inject({
      method: "POST",
      url: "/api/v1/auth/refresh",
      payload: { refreshToken: user.refreshToken },
    });
    expect(first.statusCode).toBe(200);
    const rotated = first.json().tokens.refreshToken;

    const reuse = await env.app.inject({ method: "POST", url: "/api/v1/auth/refresh", payload: { refreshToken: user.refreshToken } });
    expect(reuse.statusCode).toBe(401);
    // The reuse revoked the rotated token too.
    const after = await env.app.inject({ method: "POST", url: "/api/v1/auth/refresh", payload: { refreshToken: rotated } });
    expect(after.statusCode).toBe(401);
  });

  it("requires a token", async () => {
    const response = await env.app.inject({ method: "GET", url: "/api/v1/home" });
    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe("UNAUTHORIZED");
  });

  it("deletes the account with password confirmation", async () => {
    const user = await registerUser(env.app);
    const wrong = await env.app.inject({ method: "DELETE", url: "/api/v1/me", headers: user.headers, payload: { password: "x" } });
    expect(wrong.statusCode).toBe(401);
    const ok = await env.app.inject({
      method: "DELETE",
      url: "/api/v1/me",
      headers: user.headers,
      payload: { password: "correct-horse-battery" },
    });
    expect(ok.statusCode).toBe(204);
    expect((await env.app.inject({ method: "GET", url: "/api/v1/me", headers: user.headers })).statusCode).toBe(401);
  });
});
