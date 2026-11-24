import { randomUUID } from "node:crypto";
import { OAuth2Client } from "google-auth-library";
import jwt from "jsonwebtoken";
import { HttpError } from "../../lib/http.js";
import { roles } from "./user.model.js";

const issuer = "QueueTix";
const audience = "queuetix-api";
const sessionSeconds = 3600;
const idPattern = /^[a-f\d]{24}$/i;

function publicUser(user) {
  return {
    id: String(user._id),
    name: user.name,
    role: user.role,
    isGuest: user.isGuest,
    ...(!user.isGuest && { email: user.email }),
  };
}

export function createAuthService({
  User,
  clock,
  jwtSecret,
  googleClientId,
  verifyGoogle,
}) {
  const googleClient = googleClientId ? new OAuth2Client(googleClientId) : null;
  const verify =
    verifyGoogle ??
    (async (idToken) => {
      const ticket = await googleClient.verifyIdToken({
        idToken,
        audience: googleClientId,
      });
      return ticket.getPayload();
    });

  const epoch = () => Math.floor(clock.now().getTime() / 1000);

  function issue(user) {
    const account = publicUser(user);
    const issuedAt = epoch();
    return {
      user: account,
      token: jwt.sign(
        { role: account.role, iat: issuedAt, exp: issuedAt + sessionSeconds },
        jwtSecret,
        {
          algorithm: "HS256",
          issuer,
          audience,
          subject: account.id,
        },
      ),
      expiresAt: new Date((issuedAt + sessionSeconds) * 1000).toISOString(),
    };
  }

  async function authenticate(
    header,
    lookup = (id) => User.findById(id).lean(),
  ) {
    const token = /^Bearer ([\w.-]+)$/i.exec(header ?? "")?.[1];
    if (!token)
      throw new HttpError(401, "AUTH_REQUIRED", "Sign in to continue.");
    let claims;
    try {
      claims = jwt.verify(token, jwtSecret, {
        algorithms: ["HS256"],
        issuer,
        audience,
        clockTimestamp: epoch(),
      });
    } catch (error) {
      if (error.name === "TokenExpiredError") {
        throw new HttpError(
          401,
          "SESSION_EXPIRED",
          "Your session expired. Sign in again.",
        );
      }
      throw new HttpError(
        401,
        "INVALID_SESSION",
        "Your session is invalid. Sign in again.",
      );
    }
    if (
      typeof claims.sub !== "string" ||
      !idPattern.test(claims.sub) ||
      !Number.isInteger(claims.exp)
    ) {
      throw new HttpError(
        401,
        "INVALID_SESSION",
        "Your session is invalid. Sign in again.",
      );
    }
    const account = await lookup(claims.sub);
    if (
      !account ||
      !roles.includes(account.role) ||
      (account.isGuest && account.role !== "attendee")
    ) {
      throw new HttpError(
        401,
        "INVALID_SESSION",
        "Your session is invalid. Sign in again.",
      );
    }
    return account;
  }

  async function signInGoogle(credential) {
    if (!googleClientId)
      throw new HttpError(
        503,
        "GOOGLE_UNAVAILABLE",
        "Google sign-in is unavailable.",
      );
    let profile;
    try {
      profile = await verify(credential);
    } catch (error) {
      if (
        error.response?.status >= 500 ||
        ["ENOTFOUND", "ECONNRESET", "ETIMEDOUT"].includes(error.code)
      ) {
        throw new HttpError(
          503,
          "GOOGLE_UNAVAILABLE",
          "Google sign-in is temporarily unavailable.",
        );
      }
      throw new HttpError(
        401,
        "GOOGLE_TOKEN_INVALID",
        "Google could not verify this sign-in.",
      );
    }
    if (
      !profile?.sub ||
      typeof profile.email !== "string" ||
      profile.email_verified !== true
    ) {
      throw new HttpError(
        401,
        "GOOGLE_TOKEN_INVALID",
        "Google did not provide a verified email address.",
      );
    }
    const email = profile.email.toLowerCase();
    const name =
      typeof profile.name === "string" ? profile.name.trim().slice(0, 120) : "";
    const identity = { googleId: profile.sub };
    try {
      const user = await User.findOneAndUpdate(
        identity,
        {
          $setOnInsert: {
            email,
            name: name || email,
            role: "attendee",
            isGuest: false,
          },
        },
        { upsert: true, new: true, runValidators: true },
      );
      return issue(user);
    } catch (error) {
      if (error.code !== 11000) throw error;
      const existing = await User.findOne(identity).lean();
      if (existing) return issue(existing);
      throw new HttpError(
        409,
        "ACCOUNT_CONFLICT",
        "This email is already associated with a different account.",
      );
    }
  }

  async function signInDemo(header) {
    if (header) {
      const current = await authenticate(header);
      if (!current.isGuest)
        throw new HttpError(
          409,
          "SESSION_ACTIVE",
          "Sign out before starting a demo session.",
        );
      return issue(current);
    }
    return issue(
      await User.create({
        email: `guest-${randomUUID()}@demo.queuetix.invalid`,
        name: "Demo guest",
        role: "attendee",
        isGuest: true,
      }),
    );
  }

  return { authenticate, signInDemo, signInGoogle, publicUser };
}
