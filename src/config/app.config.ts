import { registerAs } from '@nestjs/config';

export default registerAs('app', () => ({
  port: parseInt(process.env.PORT || '3001', 10),
  env: process.env.NODE_ENV || 'development',
  corsOrigins: (process.env.CORS_ORIGINS || 'http://localhost:3000')
    .split(',')
    .map((origin) => origin.trim().replace(/\/$/, '')),

  // Google Cloud
  gcp: {
    projectId: process.env.GCP_PROJECT_ID,
    region: process.env.GCP_REGION || 'asia-south1',
    keyFile: process.env.GCP_KEY_FILE, // undefined on GCE — uses ADC
  },

  // Google Cloud Storage (replaces AWS S3)
  gcs: {
    bucketVideoCerts: process.env.GCS_BUCKET_VIDEO_CERTS || 'homegenny-video-certs-prod',
    bucketDocuments: process.env.GCS_BUCKET_DOCUMENTS || 'homegenny-documents-prod',
    signedUrlExpiry: parseInt(process.env.GCS_SIGNED_URL_EXPIRY || '3600', 10),
    // TEMPORARY: no real GCS bucket/service-account is provisioned yet. Set to
    // 'local' to store video-cert uploads on this server's own disk instead of
    // GCS — same upload/finalize/review flow, just a different storage backend.
    // Switch back to 'gcs' (or unset — that's the default) once a real bucket
    // + credentials exist; no other code change needed.
    videoStorageMode: (process.env.VIDEO_STORAGE_MODE || 'gcs') as 'gcs' | 'local',
  },

  // Firebase (Firebase Admin uses GCP ADC — same project)
  firebase: {
    projectId: process.env.GCP_PROJECT_ID,
  },

  // Cloud SQL (PostgreSQL) — same credentials, just GCP managed
  database: {
    url: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production',
    maxConnections: parseInt(process.env.DATABASE_MAX_CONNECTIONS || '20', 10),
  },

  // Redis (Memorystore for Redis on GCP)
  redis: {
    url: process.env.REDIS_URL || 'redis://localhost:6379',
    password: process.env.REDIS_PASSWORD,
  },

  // JWT
  jwt: {
    secret: process.env.JWT_SECRET,
    expiresIn: process.env.JWT_EXPIRES_IN || '15m',
    refreshSecret: process.env.JWT_REFRESH_SECRET,
    refreshExpiresIn: process.env.JWT_REFRESH_EXPIRES_IN || '7d',
  },

  // Razorpay (payments)
  razorpay: {
    keyId: process.env.RAZORPAY_KEY_ID,
    keySecret: process.env.RAZORPAY_KEY_SECRET,
    // Set in the Razorpay dashboard when creating the webhook — this is a
    // separate value from the API key secret, and the webhook handler rejects
    // every request when it is unset rather than trusting the payload.
    webhookSecret: process.env.RAZORPAY_WEBHOOK_SECRET,
    // RazorpayX is a separate product from checkout, with its own virtual
    // account number. Paying salaries needs it; collecting from clients does
    // not. Without this, disbursement records a SIMULATED result rather than
    // claiming money moved. See F-09.
    xAccountNumber: process.env.RAZORPAYX_ACCOUNT_NUMBER,
  },

  // Email
  smtp: {
    host: process.env.SMTP_HOST || 'smtp.sendgrid.net',
    port: parseInt(process.env.SMTP_PORT || '587', 10),
    user: process.env.SMTP_USER || 'apikey',
    pass: process.env.SMTP_PASS,
    from: process.env.EMAIL_FROM || 'noreply@homegenny.com',
  },

  // Government APIs (mock mode when not approved)
  // Aadhaar eKYC — via Sandbox (sandbox.co.in), a licensed KYC-API aggregator,
  // not a direct UIDAI/AUA integration (that requires a much heavier
  // registration UIDAI only grants to large regulated entities). Sandbox's
  // auth is a 2-step exchange: api_key + api_secret -> POST /authenticate ->
  // short-lived JWT, which is then sent on the actual KYC calls.
  sandboxKyc: {
    apiUrl: process.env.SANDBOX_API_URL
      || (process.env.SANDBOX_MOCK_MODE === 'false' ? 'https://api.sandbox.co.in' : 'https://test-api.sandbox.co.in'),
    apiKey: process.env.SANDBOX_API_KEY,
    apiSecret: process.env.SANDBOX_API_SECRET,
    apiVersion: process.env.SANDBOX_API_VERSION || '1.0',
    mockMode: process.env.SANDBOX_MOCK_MODE === 'true' || !process.env.SANDBOX_API_KEY || !process.env.SANDBOX_API_SECRET,
  },

  sarathi: {
    apiUrl: process.env.SARATHI_API_URL || 'https://sarathi.parivahan.gov.in/api/v1',
    apiKey: process.env.SARATHI_API_KEY,
    mockMode: process.env.SARATHI_MOCK_MODE === 'true' || !process.env.SARATHI_API_KEY,
  },

  echallan: {
    apiUrl: process.env.ECHALLAN_API_URL || 'https://echallan.parivahan.gov.in/api',
    apiKey: process.env.ECHALLAN_API_KEY,
    mockMode: process.env.ECHALLAN_MOCK_MODE === 'true' || !process.env.ECHALLAN_API_KEY,
  },

  // PAN verification (NSDL/Protean, or a licensed KYC aggregator — Sandbox/Karza/Digio) —
  // no direct-to-company Income Tax API, same "mock until a real provider is onboarded"
  // shape as uidai/sarathi above.
  panVerification: {
    apiUrl: process.env.PAN_VERIFICATION_API_URL || '',
    apiKey: process.env.PAN_VERIFICATION_API_KEY,
    mockMode: process.env.PAN_VERIFICATION_MOCK_MODE === 'true' || !process.env.PAN_VERIFICATION_API_KEY,
  },

  // Security
  bcryptRounds: parseInt(process.env.BCRYPT_ROUNDS || '12', 10),
  maxLoginAttempts: parseInt(process.env.MAX_LOGIN_ATTEMPTS || '5', 10),
  lockoutMinutes: parseInt(process.env.LOCKOUT_MINUTES || '30', 10),
  autoSeedUsers: process.env.AUTO_SEED_USERS === 'true',
  seedSecret: process.env.SEED_SECRET,

  // Video cert
  videoMinDurationSeconds: parseInt(process.env.VIDEO_MIN_DURATION_SECONDS || '270', 10),
  videoMaxSizeMb: parseInt(process.env.VIDEO_MAX_SIZE_MB || '500', 10),
  videoRetentionYears: parseInt(process.env.VIDEO_RETENTION_YEARS || '7', 10),

  // GST
  companyGstin: process.env.COMPANY_GSTIN,
  companyName: process.env.COMPANY_NAME || 'HomeGenny Staffing Pvt. Ltd.',
  companyAddress: process.env.COMPANY_ADDRESS || 'Mumbai, Maharashtra',
}));
