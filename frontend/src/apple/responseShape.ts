export type ResponseDictionary = Record<string, unknown>;

export function isResponseDictionary(value: unknown): value is ResponseDictionary {
  return (
    !!value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    !(value instanceof Uint8Array) &&
    !(value instanceof Date)
  );
}

export function hasResponseField(dict: ResponseDictionary, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(dict, key);
}

export function validFailureType(value: unknown): boolean {
  return value === undefined || typeof value === 'string' || (typeof value === 'number' && Number.isSafeInteger(value));
}

export function responseFailureCode(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  return typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : '';
}
