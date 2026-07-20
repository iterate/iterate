export function assertPushTokenSecretRevision(actual: number, expected: number): void {
  if (actual !== expected) {
    throw new Error("secret changed before the guarded fetch began");
  }
}

export async function appendAfterPushTokenSecretUpdate<T>(input: {
  append: () => Promise<T>;
  clearUpdatedSecret: () => Promise<boolean>;
}): Promise<T> {
  try {
    return await input.append();
  } catch (appendError) {
    try {
      await input.clearUpdatedSecret();
    } catch (cleanupError) {
      throw new AggregateError(
        [appendError, cleanupError],
        "device enrollment failed and its new push token could not be cleared",
      );
    }
    throw appendError;
  }
}
