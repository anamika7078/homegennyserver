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
  uidai: {
    apiUrl: process.env.UIDAI_API_URL || 'https://resident.uidai.gov.in',
    auaCode: process.env.UIDAI_AUA_CODE,
    licenseKey: process.env.UIDAI_LICENSE_KEY,
    mockMode: process.env.UIDAI_MOCK_MODE === 'true' || !process.env.UIDAI_AUA_CODE,
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

  // Security
  bcryptRounds: parseInt(process.env.BCRYPT_ROUNDS || '12', 10),
  maxLoginAttempts: parseInt(process.env.MAX_LOGIN_ATTEMPTS || '5', 10),
  lockoutMinutes: parseInt(process.env.LOCKOUT_MINUTES || '30', 10),

  // Video cert
  videoMinDurationSeconds: parseInt(process.env.VIDEO_MIN_DURATION_SECONDS || '270', 10),
  videoMaxSizeMb: parseInt(process.env.VIDEO_MAX_SIZE_MB || '500', 10),
  videoRetentionYears: parseInt(process.env.VIDEO_RETENTION_YEARS || '7', 10),

  // GST
  companyGstin: process.env.COMPANY_GSTIN,
  companyName: process.env.COMPANY_NAME || 'HomeGenny Staffing Pvt. Ltd.',
  companyAddress: process.env.COMPANY_ADDRESS || 'Mumbai, Maharashtra',
}));
