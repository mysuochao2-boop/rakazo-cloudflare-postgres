import {
  DeleteObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";

export interface ObjectValue {
  bytes: Uint8Array;
  contentType?: string;
}

export interface ObjectStoreClient {
  delete(key: string): Promise<void>;
  get(key: string): Promise<ObjectValue | null>;
  list(prefix: string): Promise<string[]>;
  put(key: string, value: ObjectValue): Promise<void>;
}

export interface ObjectStoreConfig {
  endpoint: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  prefix: string;
}

export interface ObjectStoreSelection {
  objects: ObjectStoreClient;
  prefix: string;
}

export function objectStoreConfigFromEnv(env: NodeJS.ProcessEnv): ObjectStoreConfig | undefined {
  const endpoint = optional(env.OBJECT_STORE_ENDPOINT);
  const bucket = optional(env.OBJECT_STORE_BUCKET);
  const accessKeyId = optional(env.OBJECT_STORE_ACCESS_KEY_ID);
  const secretAccessKey = optional(env.OBJECT_STORE_SECRET_ACCESS_KEY);
  const values = [endpoint, bucket, accessKeyId, secretAccessKey];
  if (!values.some(Boolean)) return undefined;
  if (!values.every(Boolean)) {
    throw new Error(
      "OBJECT_STORE_ENDPOINT, OBJECT_STORE_BUCKET, OBJECT_STORE_ACCESS_KEY_ID and OBJECT_STORE_SECRET_ACCESS_KEY must be configured together",
    );
  }
  const url = new URL(endpoint!);
  if (url.protocol !== "https:" || url.username || url.password) {
    throw new Error("OBJECT_STORE_ENDPOINT must be an HTTPS URL without credentials");
  }
  return {
    endpoint: url.toString().replace(/\/$/, ""),
    bucket: bucket!,
    accessKeyId: accessKeyId!,
    secretAccessKey: secretAccessKey!,
    prefix: normalizePrefix(env.OBJECT_STORE_PREFIX ?? "rakazo"),
  };
}

export class S3ObjectStoreClient implements ObjectStoreClient {
  private readonly client: S3Client;

  constructor(
    private readonly bucket: string,
    config: Omit<ObjectStoreConfig, "bucket" | "prefix">,
  ) {
    this.client = new S3Client({
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
      endpoint: config.endpoint,
      forcePathStyle: true,
      region: "auto",
    });
  }

  async put(key: string, value: ObjectValue): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: value.bytes,
        ContentType: value.contentType,
      }),
    );
  }

  async get(key: string): Promise<ObjectValue | null> {
    try {
      const response = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      if (!response.Body) return null;
      return {
        bytes: await response.Body.transformToByteArray(),
        ...(response.ContentType ? { contentType: response.ContentType } : {}),
      };
    } catch (error) {
      if (isMissingObject(error)) return null;
      throw error;
    }
  }

  async delete(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }

  async list(prefix: string): Promise<string[]> {
    const keys: string[] = [];
    let continuationToken: string | undefined;
    do {
      const response = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: prefix,
          ContinuationToken: continuationToken,
        }),
      );
      for (const entry of response.Contents ?? []) {
        if (entry.Key) keys.push(entry.Key);
      }
      continuationToken = response.IsTruncated ? response.NextContinuationToken : undefined;
    } while (continuationToken);
    return keys;
  }
}

export class HttpObjectStoreClient implements ObjectStoreClient {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async put(key: string, value: ObjectValue): Promise<void> {
    const response = await this.request(key, {
      method: "PUT",
      headers: value.contentType ? { "content-type": value.contentType } : undefined,
      body: Uint8Array.from(value.bytes).buffer,
    });
    if (!response.ok) throw new Error(`Object gateway put failed (${response.status})`);
  }

  async get(key: string): Promise<ObjectValue | null> {
    const response = await this.request(key);
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`Object gateway get failed (${response.status})`);
    return {
      bytes: new Uint8Array(await response.arrayBuffer()),
      ...(response.headers.get("content-type")
        ? { contentType: response.headers.get("content-type")! }
        : {}),
    };
  }

  async delete(key: string): Promise<void> {
    const response = await this.request(key, { method: "DELETE" });
    if (!response.ok) throw new Error(`Object gateway delete failed (${response.status})`);
  }

  async list(prefix: string): Promise<string[]> {
    const keys: string[] = [];
    let cursor: string | undefined;
    do {
      const response = await this.fetchImpl(new URL("/__objects/list", this.baseUrl), {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ prefix, cursor }),
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) throw new Error(`Object gateway list failed (${response.status})`);
      const page = (await response.json()) as { keys: string[]; cursor?: string };
      keys.push(...page.keys);
      cursor = page.cursor;
    } while (cursor);
    return keys;
  }

  private request(key: string, init: RequestInit = {}): Promise<Response> {
    const url = new URL("/__objects/object", this.baseUrl);
    url.searchParams.set("key", key);
    return this.fetchImpl(url, {
      ...init,
      headers: {
        ...Object.fromEntries(new Headers(init.headers)),
        authorization: `Bearer ${this.token}`,
      },
      signal: AbortSignal.timeout(30_000),
    });
  }
}

export function createObjectStore(config: ObjectStoreConfig): ObjectStoreClient {
  return new S3ObjectStoreClient(config.bucket, config);
}

export function objectStoreFromEnv(env: NodeJS.ProcessEnv): ObjectStoreSelection | undefined {
  const gatewayUrl = optional(env.OBJECT_STORE_GATEWAY_URL);
  const gatewaySecret = optional(env.OBJECT_STORE_GATEWAY_SECRET);
  if (gatewayUrl || gatewaySecret) {
    if (!gatewayUrl || !gatewaySecret) {
      throw new Error(
        "OBJECT_STORE_GATEWAY_URL and OBJECT_STORE_GATEWAY_SECRET must be configured together",
      );
    }
    const url = new URL(gatewayUrl);
    if (url.protocol !== "https:" || url.username || url.password) {
      throw new Error("OBJECT_STORE_GATEWAY_URL must be an HTTPS URL without credentials");
    }
    return {
      objects: new HttpObjectStoreClient(url.toString(), gatewaySecret),
      prefix: normalizePrefix(env.OBJECT_STORE_PREFIX ?? "rakazo"),
    };
  }
  const config = objectStoreConfigFromEnv(env);
  return config ? { objects: createObjectStore(config), prefix: config.prefix } : undefined;
}

export function objectKey(prefix: string, ...segments: string[]): string {
  return [normalizePrefix(prefix), ...segments.map(encodeSegment)].filter(Boolean).join("/");
}

function normalizePrefix(value: string): string {
  return value.split("/").filter(Boolean).map(encodeSegment).join("/");
}

function encodeSegment(value: string): string {
  if (!value || value === "." || value === "..") throw new Error("Invalid object key segment");
  return encodeURIComponent(value);
}

function optional(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

function isMissingObject(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { name?: unknown; $metadata?: { httpStatusCode?: unknown } };
  return candidate.name === "NoSuchKey" || candidate.$metadata?.httpStatusCode === 404;
}
