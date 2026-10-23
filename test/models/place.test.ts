import { canManagePlace } from '../../src/models/place';
import { UserRole } from '../../src/models/user';

describe('canManagePlace', () => {
  const place = { ownerBy: ['u1', 'u2'] };

  it('allows an owner listed in ownerBy', () => {
    expect(canManagePlace({ id: 'u2', role: UserRole.OWNER }, place)).toBe(true);
  });

  it('denies an owner not listed in ownerBy', () => {
    expect(canManagePlace({ id: 'u3', role: UserRole.OWNER }, place)).toBe(false);
  });

  it('denies a customer even when listed in ownerBy', () => {
    expect(canManagePlace({ id: 'u1', role: UserRole.CUSTOMER }, place)).toBe(false);
  });

  it('allows an admin regardless of ownerBy', () => {
    expect(canManagePlace({ id: 'a1', role: UserRole.ADMIN }, place)).toBe(true);
  });

  it('treats a place without ownerBy (created before ownership) as admin-only', () => {
    const legacy = {} as { ownerBy: string[] };
    expect(canManagePlace({ id: 'u1', role: UserRole.OWNER }, legacy)).toBe(false);
    expect(canManagePlace({ id: 'a1', role: UserRole.ADMIN }, legacy)).toBe(true);
  });
});
