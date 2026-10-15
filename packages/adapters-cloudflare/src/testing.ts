import type { ObjectStoreClient, ObjectValue } from "./object-store.js";

export class MemoryObjectStoreClient implements ObjectStoreClient {
  readonly values = new Map<string, ObjectValue>();

  async put(key: string, value: ObjectValue): Promise<void> {
    this.values.set(key, {
      bytes: value.bytes.slice(),
      ...(value.contentType ? { contentType: value.contentType } : {}),
    });
  }

  async get(key: string): Promise<ObjectValue | null> {
    const value = this.values.get(key);
    return value
      ? {
          bytes: value.bytes.slice(),
          ...(value.contentType ? { contentType: value.contentType } : {}),
        }
      : null;
  }

  async delete(key: string): Promise<void> {
    this.values.delete(key);
  }

  async list(prefix: string): Promise<string[]> {
    return [...this.values.keys()].filter((key) => key.startsWith(prefix)).sort();
  }
}
