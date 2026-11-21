import { AssumeRoleCommand } from '@aws-sdk/client-sts';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { send, STSClientCtor } = vi.hoisted(() => ({ send: vi.fn(), STSClientCtor: vi.fn() }));
vi.mock('@aws-sdk/client-sts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-sts')>();
  return {
    ...actual,
    STSClient: class {
      constructor(options: unknown) {
        STSClientCtor(options);
      }
      send = send;
    },
  };
});

import { assumeRole } from './sts.js';

describe('assumeRole', () => {
  beforeEach(() => {
    send.mockReset();
    STSClientCtor.mockReset();
  });

  it('passes role, external id and duration and returns temporary credentials', async () => {
    send.mockResolvedValueOnce({
      Credentials: { AccessKeyId: 'AKIA_TEMP', SecretAccessKey: 'secret', SessionToken: 'token' },
    });
    const result = await assumeRole({
      region: 'ap-southeast-1',
      roleArn: 'arn:aws:iam::123456789012:role/sguard',
      externalId: 'external-1',
      sessionDuration: 900,
    });
    expect(result).toEqual({ accessKeyId: 'AKIA_TEMP', secretAccessKey: 'secret', sessionToken: 'token' });
    const command = send.mock.calls[0][0] as InstanceType<typeof AssumeRoleCommand>;
    expect(command.input).toMatchObject({
      RoleArn: 'arn:aws:iam::123456789012:role/sguard',
      ExternalId: 'external-1',
      DurationSeconds: 900,
    });
  });

  it('uses the base credentials when provided', async () => {
    send.mockResolvedValueOnce({
      Credentials: { AccessKeyId: 'a', SecretAccessKey: 'b', SessionToken: 'c' },
    });
    await assumeRole({
      region: 'us-east-1',
      roleArn: 'arn:aws:iam::1:role/r',
      sessionDuration: 3600,
      baseCredentials: { accessKeyId: 'BASE', secretAccessKey: 'BASE_SECRET' },
    });
    expect(STSClientCtor).toHaveBeenCalledWith({
      region: 'us-east-1',
      credentials: { accessKeyId: 'BASE', secretAccessKey: 'BASE_SECRET' },
    });
  });

  it('throws when STS omits a session token', async () => {
    send.mockResolvedValueOnce({ Credentials: { AccessKeyId: 'a', SecretAccessKey: 'b' } });
    await expect(
      assumeRole({ region: 'us-east-1', roleArn: 'arn:aws:iam::1:role/r', sessionDuration: 3600 }),
    ).rejects.toThrow(/session token/i);
  });
});
