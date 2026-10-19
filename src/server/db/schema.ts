import { sqliteTable, text, integer, index } from 'drizzle-orm/sqlite-core';

export const ROLES = ['user', 'manager', 'admin'] as const;
export type Role = (typeof ROLES)[number];

export const users = sqliteTable('users', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  username: text('username').notNull().unique(),
  displayName: text('display_name'),
  email: text('email'),
  passwordHash: text('password_hash'),
  role: text('role', { enum: ROLES }).notNull().default('user'),
  isOwner: integer('is_owner', { mode: 'boolean' }).notNull().default(false),
  disabled: integer('disabled', { mode: 'boolean' }).notNull().default(false),
  oidcSubject: text('oidc_subject').unique(),
  plexId: text('plex_id').unique(),
  failedLogins: integer('failed_logins').notNull().default(0),
  lockedUntil: integer('locked_until'),
  createdAt: integer('created_at').notNull(),
  lastLoginAt: integer('last_login_at'),
});

export const sessions = sqliteTable(
  'sessions',
  {
    id: text('id').primaryKey(), // sha256 of the cookie token; the raw token is never stored
    userId: integer('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    csrfToken: text('csrf_token').notNull(),
    createdAt: integer('created_at').notNull(),
    lastSeenAt: integer('last_seen_at').notNull(),
    expiresAt: integer('expires_at').notNull(),
    ip: text('ip'),
    userAgent: text('user_agent'),
  },
  (t) => [index('sessions_user_idx').on(t.userId)],
);

export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(), // JSON; secret leaves are encrypted strings
  updatedAt: integer('updated_at').notNull(),
});

export const authStates = sqliteTable('auth_states', {
  state: text('state').primaryKey(),
  kind: text('kind').notNull(), // 'oidc' | 'plex'
  data: text('data').notNull(), // JSON
  expiresAt: integer('expires_at').notNull(),
});

export const auditLog = sqliteTable(
  'audit_log',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    userId: integer('user_id'),
    username: text('username'),
    action: text('action').notNull(),
    target: text('target'),
    details: text('details'),
    ip: text('ip'),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [index('audit_created_idx').on(t.createdAt)],
);
