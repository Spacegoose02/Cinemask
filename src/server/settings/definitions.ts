import cron from 'node-cron';
import { z } from 'zod';

// New SSO accounts can never start as admin; admin comes only from the owner or an admin group mapping.
const newAccountRole = z.enum(['user', 'manager']);
const groupList = z.array(z.string().trim().min(1).max(200)).max(50);
const httpUrl = z.union([z.literal(''), z.url({ protocol: /^https?$/ }).max(2000)]);

/**
 * Every setting lives in one of these sections. Fields listed in `secrets` are encrypted at rest
 * with the instance key and are never sent back to the browser, only whether they are set.
 */
export const SETTINGS = {
  general: {
    schema: z.object({
      /** Public URL users reach the app on, e.g. https://media.example.com. Used for SSO redirects. */
      baseUrl: httpUrl.default(''),
    }),
    secrets: [],
  },
  auth: {
    schema: z.object({
      localLoginEnabled: z.boolean().default(true),
      sessionDays: z.number().int().min(1).max(365).default(30),
      oidc: z
        .object({
          enabled: z.boolean().default(false),
          buttonLabel: z.string().trim().max(50).default('Single sign-on'),
          issuer: httpUrl.default(''),
          clientId: z.string().trim().max(500).default(''),
          clientSecret: z.string().max(2000).default(''),
          scopes: z.string().trim().max(500).default('openid profile email groups'),
          groupsClaim: z.string().trim().max(100).default('groups'),
          adminGroups: groupList.default([]),
          managerGroups: groupList.default([]),
          /** If non-empty, only members of these (or the admin/manager groups) may sign in. */
          userGroups: groupList.default([]),
          autoCreateUsers: z.boolean().default(true),
          defaultRole: newAccountRole.default('user'),
        })
        .prefault({}),
      plex: z
        .object({
          enabled: z.boolean().default(false),
          /** Only Plex accounts with access to this server may sign in. */
          serverMachineId: z.string().trim().max(200).default(''),
          autoCreateUsers: z.boolean().default(true),
          defaultRole: newAccountRole.default('user'),
        })
        .prefault({}),
    }),
    secrets: ['oidc.clientSecret'],
  },
  backup: {
    schema: z.object({
      scheduleEnabled: z.boolean().default(true),
      cron: z.string().trim().max(100).refine((v) => cron.validate(v), 'Not a valid cron schedule').default('0 3 * * *'),
      retention: z.number().int().min(1).max(365).default(7),
      /** Optional passphrase. When set, backup archives are encrypted with it. */
      passphrase: z.string().max(500).default(''),
      remote: z
        .object({
          type: z.enum(['none', 'path', 's3']).default('none'),
          path: z.string().trim().max(1000).default(''),
          retention: z.number().int().min(1).max(365).default(14),
          s3: z
            .object({
              endpoint: httpUrl.default(''),
              region: z.string().trim().max(100).default('us-east-1'),
              bucket: z.string().trim().max(255).default(''),
              prefix: z.string().trim().max(500).default('media-manager/'),
              accessKeyId: z.string().trim().max(500).default(''),
              secretAccessKey: z.string().max(2000).default(''),
              forcePathStyle: z.boolean().default(true),
            })
            .prefault({}),
        })
        .prefault({}),
    }),
    secrets: ['passphrase', 'remote.s3.secretAccessKey'],
  },
  plex: {
    schema: z.object({
      enabled: z.boolean().default(false),
      name: z.string().trim().max(100).default(''),
      /** e.g. http://192.168.1.10:32400 */
      url: httpUrl.default(''),
      token: z.string().max(500).default(''),
      machineId: z.string().trim().max(200).default(''),
    }),
    secrets: ['token'],
  },
  jellyfin: {
    schema: z.object({
      enabled: z.boolean().default(false),
      name: z.string().trim().max(100).default(''),
      url: httpUrl.default(''),
      apiKey: z.string().max(500).default(''),
    }),
    secrets: ['apiKey'],
  },
  metadata: {
    schema: z.object({
      /** TMDB v3 API key or v4 read access token. */
      tmdbApiKey: z.string().max(1000).default(''),
      mdblistApiKey: z.string().max(500).default(''),
      language: z.string().trim().regex(/^[a-z]{2}(-[A-Z]{2})?$/, 'Use a code like en-US').default('en-US'),
      region: z.string().trim().regex(/^[A-Z]{2}$/, 'Use a country code like US').default('US'),
    }),
    secrets: ['tmdbApiKey', 'mdblistApiKey'],
  },
  library: {
    schema: z.object({
      /** Periodically scan Plex/Jellyfin to learn what is on the server. */
      syncEnabled: z.boolean().default(true),
      syncIntervalHours: z.number().int().min(1).max(24).default(6),
    }),
    secrets: [],
  },
} as const satisfies Record<string, { schema: z.ZodObject; secrets: readonly string[] }>;

export type SectionName = keyof typeof SETTINGS;
export type SectionValue<S extends SectionName> = z.output<(typeof SETTINGS)[S]['schema']>;
export const SECTION_NAMES = Object.keys(SETTINGS) as SectionName[];
