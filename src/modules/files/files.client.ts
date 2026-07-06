import { ofetch } from "ofetch";
import type { FilesPort, StoredObject } from "./files.port.ts";

/** files 서버 object URL(순수). `{base}/api/files/{bucket}/object?key={key}`. key는 인코딩(중첩 슬래시 허용). */
export function filesObjectUrl(base: string, bucket: string, key: string): string {
  return `${base.replace(/\/+$/, "")}/api/files/${encodeURIComponent(bucket)}/object?key=${encodeURIComponent(key)}`;
}

/** files 서버 HTTP 어댑터(Bearer API-key). raw 바이너리 + Content-Type 대칭 저장/반환. */
export class FilesClient implements FilesPort {
  constructor(
    private readonly base: string,
    private readonly apiKey: string,
  ) {}
  private auth() {
    return { Authorization: `Bearer ${this.apiKey}` };
  }
  async putObject(
    bucket: string,
    key: string,
    bytes: Uint8Array,
    contentType: string,
  ): Promise<void> {
    await ofetch(filesObjectUrl(this.base, bucket, key), {
      method: "PUT",
      headers: { ...this.auth(), "Content-Type": contentType },
      body: bytes,
    });
  }
  async getObject(bucket: string, key: string): Promise<StoredObject> {
    const res = await ofetch.raw(filesObjectUrl(this.base, bucket, key), {
      method: "GET",
      headers: this.auth(),
      responseType: "arrayBuffer",
    });
    return {
      bytes: new Uint8Array(res._data as ArrayBuffer),
      contentType: res.headers.get("content-type") ?? "application/octet-stream",
    };
  }
  async deleteObject(bucket: string, key: string): Promise<void> {
    await ofetch(filesObjectUrl(this.base, bucket, key), {
      method: "DELETE",
      headers: this.auth(),
    });
  }
}
