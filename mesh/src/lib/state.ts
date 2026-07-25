export function patchChanges<T extends object>(current: T, patch: Partial<T>): boolean {
  return (Object.keys(patch) as Array<keyof T>).some(
    (key) => !Object.is(current[key], patch[key]),
  )
}
