import { createHash, randomBytes } from "node:crypto";
import { and, eq, gt, isNull, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { AppContext } from "../context.js";
import { refreshTokens, users, userSettings, type User } from "../db/schema.js";
import { AppError, conflict, unauthorized } from "../lib/errors.js";
import { hashPassword, verifyPassword } from "../lib/password.js";
import { createDefaultSchedule } from "./schedule.js";

const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  expiresIn: string;
}

export async function issueTokens(
  app: FastifyInstance,
  ctx: AppContext,
  userId: string,
  userAgent?: string,
): Promise<TokenPair> {
  const accessToken = app.jwt.sign({ sub: userId }, { expiresIn: ctx.config.ACCESS_TOKEN_TTL });
  const refreshToken = randomBytes(48).toString("base64url");
  await ctx.db.insert(refreshTokens).values({
    userId,
    tokenHash: hashToken(refreshToken),
    userAgent: userAgent?.slice(0, 255),
    expiresAt: new Date(ctx.now().getTime() + ctx.config.REFRESH_TOKEN_TTL_DAYS * 86_400_000),
  });
  return { accessToken, refreshToken, expiresIn: ctx.config.ACCESS_TOKEN_TTL };
}

export async function findUserByEmail(ctx: AppContext, email: string) {
  return ctx.db.query.users.findFirst({ where: eq(sql`lower(${users.email})`, email.toLowerCase()) });
}

export async function register(ctx: AppContext, input: { name: string; email: string; password: string; timezone: string }) {
  if (await findUserByEmail(ctx, input.email)) throw conflict("EMAIL_TAKEN", "An account with this email already exists");
  const passwordHash = await hashPassword(input.password);
  try {
    return await ctx.db.transaction(async (tx) => {
      const [user] = await tx
        .insert(users)
        .values({
          name: input.name.trim(),
          email: input.email.trim(),
          passwordHash,
          timezone: input.timezone,
          createdAt: ctx.now(),
          updatedAt: ctx.now(),
        })
        .returning();
      await tx.insert(userSettings).values({ userId: user!.id });
      await createDefaultSchedule(tx, user!.id, ctx.now());
      return user!;
    });
  } catch (error) {
    const code = (error as { cause?: { code?: string } }).cause?.code ?? (error as { code?: string }).code;
    if (code === "23505") throw conflict("EMAIL_TAKEN", "An account with this email already exists");
    throw error;
  }
}

export async function login(ctx: AppContext, email: string, password: string): Promise<User> {
  const user = await findUserByEmail(ctx, email);
  // Always run a hash comparison so response time does not reveal whether the email exists.
  const ok = await verifyPassword(password, user?.passwordHash ?? "scrypt$16384$8$1$AAAA$AAAA");
  if (!user || !ok) throw new AppError(401, "INVALID_CREDENTIALS", "Email or password is incorrect");
  return user;
}

/** Rotates a refresh token. Presenting an already-used token revokes every session of that user. */
export async function rotateRefreshToken(app: FastifyInstance, ctx: AppContext, token: string, userAgent?: string) {
  const now = ctx.now();
  const row = await ctx.db.query.refreshTokens.findFirst({ where: eq(refreshTokens.tokenHash, hashToken(token)) });
  if (!row) throw unauthorized("Invalid refresh token");
  if (row.revokedAt) {
    await revokeAll(ctx, row.userId);
    throw unauthorized("Refresh token was already used");
  }
  if (row.expiresAt <= now) throw unauthorized("Refresh token expired");

  const [revoked] = await ctx.db
    .update(refreshTokens)
    .set({ revokedAt: now })
    .where(and(eq(refreshTokens.id, row.id), isNull(refreshTokens.revokedAt)))
    .returning();
  if (!revoked) throw unauthorized("Refresh token was already used");
  return issueTokens(app, ctx, row.userId, userAgent);
}

export async function revokeRefreshToken(ctx: AppContext, token: string) {
  await ctx.db
    .update(refreshTokens)
    .set({ revokedAt: ctx.now() })
    .where(and(eq(refreshTokens.tokenHash, hashToken(token)), isNull(refreshTokens.revokedAt)));
}

export async function revokeAll(ctx: AppContext, userId: string) {
  await ctx.db
    .update(refreshTokens)
    .set({ revokedAt: ctx.now() })
    .where(and(eq(refreshTokens.userId, userId), isNull(refreshTokens.revokedAt), gt(refreshTokens.expiresAt, ctx.now())));
}

export async function changePassword(ctx: AppContext, user: User, current: string, next: string) {
  if (!(await verifyPassword(current, user.passwordHash))) {
    throw new AppError(401, "INVALID_CREDENTIALS", "Current password is incorrect");
  }
  await ctx.db.update(users).set({ passwordHash: await hashPassword(next) }).where(eq(users.id, user.id));
  await revokeAll(ctx, user.id);
}
