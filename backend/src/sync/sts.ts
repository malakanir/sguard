import { AssumeRoleCommand, STSClient } from '@aws-sdk/client-sts';

export interface BaseCredentials {
  accessKeyId: string;
  secretAccessKey: string;
}

export interface AssumeRoleInput {
  region: string;
  roleArn: string;
  externalId?: string;
  sessionDuration: number;
  /** Kredensial IAM milik SGuard yang diizinkan meng-assume peran. Kosong: rantai kredensial default. */
  baseCredentials?: BaseCredentials;
}

export interface TemporaryCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
}

export async function assumeRole(input: AssumeRoleInput): Promise<TemporaryCredentials> {
  const sts = new STSClient({
    region: input.region,
    ...(input.baseCredentials ? { credentials: input.baseCredentials } : {}),
  });
  const result = await sts.send(
    new AssumeRoleCommand({
      RoleArn: input.roleArn,
      RoleSessionName: `sguard-${Date.now()}`,
      ...(input.externalId ? { ExternalId: input.externalId } : {}),
      DurationSeconds: input.sessionDuration,
    }),
  );
  const credentials = result.Credentials;
  if (!credentials?.AccessKeyId || !credentials.SecretAccessKey || !credentials.SessionToken) {
    throw new Error('STS tidak mengembalikan kredensial sementara lengkap (session token).');
  }
  return {
    accessKeyId: credentials.AccessKeyId,
    secretAccessKey: credentials.SecretAccessKey,
    sessionToken: credentials.SessionToken,
  };
}
