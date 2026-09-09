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

  clientOrigin: process.env.CLIENT_ORIGIN ?? 'http://localhost:5179',
  aiServiceUrl: process.env.AI_SERVICE_URL ?? '',

  /** A support message is not a file upload. */
  bodyLimit: '64kb',
};
