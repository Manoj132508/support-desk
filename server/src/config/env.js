/**
 * Configuration, read once.
 *
 * No `dotenv` dependency: Node 22 loads a .env file natively with
 * `node --env-file=.env`, which the dev script uses. One fewer dependency in
 * the process that owns every consequential action.
 *
 * Nothing here has a secret default. A missing JWT_SECRET must fail loudly in
 * Phase 8, never fall back to a development value that could reach production.
 */
export const config = {
  port: Number(process.env.PORT ?? 4400),
  nodeEnv: process.env.NODE_ENV ?? 'development',
  isProduction: process.env.NODE_ENV === 'production',

  mongodbUri: process.env.MONGODB_URI ?? '',
  jwtSecret: process.env.JWT_SECRET ?? '',

  /**
   * Short by design. A JWT cannot be revoked before it expires, so the
   * lifetime IS the revocation window -- the shorter it is, the less a stolen
   * token is worth. Twelve hours covers a working day without a re-login.
   */
  jwtExpiresIn: process.env.JWT_EXPIRES_IN ?? '12h',
  jwtExpiresMs: 12 * 60 * 60 * 1000,

  /** bcrypt cost. 12 is the common recommendation; OWASP's floor is 10. */
  bcryptRounds: Number(process.env.BCRYPT_ROUNDS ?? 12),

  clientOrigin: process.env.CLIENT_ORIGIN ?? 'http://localhost:5179',
  aiServiceUrl: process.env.AI_SERVICE_URL ?? '',
  /** Shared secret so the advisory tier declines calls that did not come from
   *  here. Defence in depth -- the real protection is that it is not publicly
   *  routable (ADR 0001), but "not routable" is a deployment property and
   *  deployment properties get changed by someone in a hurry. */
  aiServiceToken: process.env.AI_SERVICE_TOKEN ?? '',

  /** A support message is not a file upload. */
  bodyLimit: '64kb',
};
