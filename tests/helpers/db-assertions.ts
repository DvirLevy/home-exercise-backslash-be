/**
 * Asserts that a promise rejects because PostgreSQL enforced the named constraint.
 * The constraint name appears in the Prisma error message or in its `meta`.
 */
export async function expectConstraintViolation(promise: Promise<unknown>, constraintName: string): Promise<void> {
  let caught: unknown;
  try {
    await promise;
  } catch (err) {
    caught = err;
  }
  if (caught === undefined) {
    throw new Error(`Expected constraint "${constraintName}" to be violated, but the statement succeeded`);
  }
  const error = caught as { message?: string; meta?: unknown };
  const evidence = `${error.message ?? ''} ${JSON.stringify(error.meta ?? {})}`;
  if (!evidence.includes(constraintName)) {
    throw new Error(`Expected a violation of "${constraintName}" but got: ${evidence.slice(0, 600)}`);
  }
}
