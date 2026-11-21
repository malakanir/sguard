import { describe, expect, it, vi } from 'vitest';

const { assumeRole, ec2Options } = vi.hoisted(() => ({
  assumeRole: vi.fn(),
  ec2Options: [] as unknown[],
}));
vi.mock('./sts.js', () => ({ assumeRole }));
vi.mock('./cloud-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./cloud-client')>();
  return {
    ...actual,
    // Tipe saja di runtime; disediakan agar metadata decorator tidak memicu error mock.
    CloudClient: undefined,
    Ec2CloudClient: class {
      constructor(options: unknown) {
        ec2Options.push(options);
      }
    },
  };
});

import { CloudClientResolver } from './cloud-client-resolver.js';

function resolverWith(account: Record<string, unknown>) {
  return new CloudClientResolver(
    { get: () => undefined } as never,
    { isConfigured: () => true, decrypt: (v: string) => v } as never,
    { awsAccount: { findUnique: async () => account } } as never,
    {} as never,
  );
}

describe('CloudClientResolver', () => {
  it('passes temporary STS credentials including the session token', async () => {
    assumeRole.mockResolvedValueOnce({ accessKeyId: 'TEMP', secretAccessKey: 'secret', sessionToken: 'token' });
    const resolver = resolverWith({
      region: 'ap-southeast-1',
      roleArn: 'arn:aws:iam::123456789012:role/r',
      externalIdEnc: null,
      sessionDuration: 3600,
      accessKeyIdEnc: 'BASE',
      secretAccessKeyEnc: 'BASE_SECRET',
    });
    await resolver.forAccount('account-id');
    expect(assumeRole).toHaveBeenCalledWith({
      region: 'ap-southeast-1',
      roleArn: 'arn:aws:iam::123456789012:role/r',
      sessionDuration: 3600,
      baseCredentials: { accessKeyId: 'BASE', secretAccessKey: 'BASE_SECRET' },
    });
    expect(ec2Options.at(-1)).toMatchObject({ sessionToken: 'token', accessKeyId: 'TEMP' });
  });

  it('uses static keys and no STS call when no role is set', async () => {
    assumeRole.mockClear();
    const resolver = resolverWith({
      region: 'us-east-1',
      roleArn: null,
      accessKeyIdEnc: 'STATIC',
      secretAccessKeyEnc: 'STATIC_SECRET',
    });
    await resolver.forAccount('account-id');
    expect(assumeRole).not.toHaveBeenCalled();
    expect(ec2Options.at(-1)).toMatchObject({ accessKeyId: 'STATIC', secretAccessKey: 'STATIC_SECRET' });
    expect(ec2Options.at(-1)).not.toHaveProperty('sessionToken');
  });
});
