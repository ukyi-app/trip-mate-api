/** files 서버 저장 객체(다운로드 결과). */
export interface StoredObject {
  bytes: Uint8Array;
  contentType: string;
}

/** files 서버 접근 포트(어댑터: FilesClient / 테스트 fake). 프록시 업로드/다운로드/삭제. */
export interface FilesPort {
  putObject(bucket: string, key: string, bytes: Uint8Array, contentType: string): Promise<void>;
  getObject(bucket: string, key: string): Promise<StoredObject>;
  deleteObject(bucket: string, key: string): Promise<void>;
}
