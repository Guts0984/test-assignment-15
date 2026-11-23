import argon2 from 'argon2';

export type PasswordCost = { readonly memoryKiB: number; readonly timeCost: number };

export const hashPassword = (plain: string, cost: PasswordCost): Promise<string> =>
  argon2.hash(plain, {
    type: argon2.argon2id,
    memoryCost: cost.memoryKiB,
    timeCost: cost.timeCost,
    parallelism: 1,
  });

/** Never throws: a malformed hash is simply a failed verification. */
export const verifyPassword = async (hash: string, plain: string): Promise<boolean> => {
  try {
    return await argon2.verify(hash, plain);
  } catch {
    return false;
  }
};
