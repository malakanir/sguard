import { NotFoundException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { GroupsService } from './groups.service.js';

function setup(accountFound: unknown) {
  const update = vi.fn(async (args: { data: Record<string, unknown> }) => ({ id: 'g1', ...args.data }));
  const ensureGroup = vi.fn(async () => undefined);
  const findOne = vi.fn(async () => ({ id: 'g1' }));
  const service = new GroupsService(
    {
      securityGroup: { update, findUniqueOrThrow: vi.fn() },
      awsAccount: { findFirst: vi.fn(async () => accountFound) },
    } as never,
    { require: vi.fn(async () => 'OWNER') } as never,
    { ensureGroup } as never,
  );
  service.findOne = findOne as never;
  return { service, update, ensureGroup };
}

describe('GroupsService.update', () => {
  it('resets cloud state and resyncs when the AWS account changes', async () => {
    const { service, update, ensureGroup } = setup({ id: 'account-2' });
    await service.update('u1', 'g1', { awsAccountId: 'account-2' });
    expect(update.mock.calls[0][0].data).toMatchObject({
      awsAccountId: 'account-2',
      flociGroupId: null,
      syncStatus: 'PENDING',
      syncError: null,
    });
    expect(ensureGroup).toHaveBeenCalledWith('g1');
  });

  it('allows unassigning the account with null', async () => {
    const { service, update } = setup(null);
    await service.update('u1', 'g1', { awsAccountId: null });
    expect(update.mock.calls[0][0].data).toMatchObject({ awsAccountId: null, flociGroupId: null });
  });

  it('rejects an account the user does not own', async () => {
    const { service, update, ensureGroup } = setup(null);
    await expect(service.update('u1', 'g1', { awsAccountId: 'foreign' })).rejects.toBeInstanceOf(NotFoundException);
    expect(update).not.toHaveBeenCalled();
    expect(ensureGroup).not.toHaveBeenCalled();
  });
});
