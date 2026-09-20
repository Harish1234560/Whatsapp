import 'dotenv/config';

export interface Env {
  nodeEnv: 'development' | 'test' | 'production';
  port: number;
  /** Empty means: run on an embedded dev database (PGlite) with fake store data. */
  databaseUrl: string;
  pgliteDir: string;
  schemaMappingFile: string;
  sessionSecret: string;
  allowStoreAdminLogin: boolean;
  /** existing_table: coupons are copied into the store's own coupon table. api: checkout calls our validate/redeem endpoints. */
  couponMode: 'existing_table' | 'api';
  integrationApiKey: string;
  whatsappProvider: 'mock' | 'cloud';
  whatsappToken: string;
  whatsappPhoneNumberId: string;
  whatsappWabaId: string;
  whatsappAppSecret: string;
  whatsappVerifyToken: string;
  whatsappApiVersion: string;
  /** Empty means: in-process queue. Set to use BullMQ. */
  redisUrl: string;
  sendRatePerSecond: number;
  enableScheduler: boolean;
}

function bool(v: string | undefined, dflt: boolean): boolean {
  if (v === undefined || v === '') return dflt;
  return ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());
}

export function loadEnv(overrides: Partial<Env> = {}, source: NodeJS.ProcessEnv = process.env): Env {
  const nodeEnvRaw = source.NODE_ENV ?? 'development';
  const nodeEnv = (['development', 'test', 'production'].includes(nodeEnvRaw) ? nodeEnvRaw : 'development') as Env['nodeEnv'];

  const env: Env = {
    nodeEnv,
    port: Number(source.PORT ?? 4100),
    databaseUrl: source.DATABASE_URL ?? '',
    pgliteDir: source.PGLITE_DIR ?? '',
    schemaMappingFile: source.SCHEMA_MAPPING_FILE ?? 'schema-mapping.json',
    sessionSecret: source.SESSION_SECRET ?? '',
    allowStoreAdminLogin: bool(source.ALLOW_STORE_ADMIN_LOGIN, true),
    couponMode: source.COUPON_MODE === 'api' ? 'api' : 'existing_table',
    integrationApiKey: source.INTEGRATION_API_KEY ?? '',
    whatsappProvider: source.WHATSAPP_PROVIDER === 'cloud' ? 'cloud' : 'mock',
    whatsappToken: source.WHATSAPP_TOKEN ?? '',
    whatsappPhoneNumberId: source.WHATSAPP_PHONE_NUMBER_ID ?? '',
    whatsappWabaId: source.WHATSAPP_WABA_ID ?? '',
    whatsappAppSecret: source.WHATSAPP_APP_SECRET ?? '',
    whatsappVerifyToken: source.WHATSAPP_VERIFY_TOKEN ?? '',
    whatsappApiVersion: source.WHATSAPP_API_VERSION ?? 'v21.0',
    redisUrl: source.REDIS_URL ?? '',
    sendRatePerSecond: Number(source.SEND_RATE_PER_SECOND ?? 20),
    enableScheduler: bool(source.ENABLE_SCHEDULER, true),
    ...overrides,
  };

  validateEnv(env);
  return env;
}

/** Guards from the plan addendum: the mock can never run in production, the real provider never in tests. */
export function validateEnv(env: Env): void {
  const problems: string[] = [];

  if (env.nodeEnv === 'production') {
    if (env.whatsappProvider === 'mock') problems.push('WHATSAPP_PROVIDER=mock is not allowed in production.');
    if (!env.databaseUrl) problems.push('DATABASE_URL is required in production. The embedded dev database is not the store.');
    if (env.sessionSecret.length < 32) problems.push('SESSION_SECRET must be at least 32 characters in production.');
  }
  if (env.nodeEnv === 'test' && env.whatsappProvider === 'cloud') {
    problems.push('WHATSAPP_PROVIDER=cloud is not allowed when NODE_ENV=test.');
  }
  if (env.whatsappProvider === 'cloud') {
    if (!env.whatsappToken) problems.push('WHATSAPP_TOKEN is required for the cloud provider.');
    if (!env.whatsappPhoneNumberId) problems.push('WHATSAPP_PHONE_NUMBER_ID is required for the cloud provider.');
    if (!env.whatsappAppSecret) problems.push('WHATSAPP_APP_SECRET is required to verify webhook signatures.');
    if (!env.whatsappVerifyToken) problems.push('WHATSAPP_VERIFY_TOKEN is required for webhook verification.');
  }
  if (!Number.isFinite(env.sendRatePerSecond) || env.sendRatePerSecond <= 0) {
    problems.push('SEND_RATE_PER_SECOND must be a positive number.');
  }

  if (problems.length) {
    throw new Error('Invalid configuration:\n- ' + problems.join('\n- '));
  }

  if (!env.sessionSecret) {
    // Dev and test only (production is rejected above). Sessions reset on restart.
    env.sessionSecret = 'dev-only-secret-' + Math.random().toString(36).slice(2) + Date.now().toString(36);
  }
}
