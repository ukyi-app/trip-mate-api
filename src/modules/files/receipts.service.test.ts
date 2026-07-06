import { describe, it, expect } from "vitest";
import { ReceiptsService, type ReceiptRepo } from "./receipts.service.ts";
import type { FilesPort } from "./files.port.ts";
import { NotFoundError } from "../../core/errors.ts";

// expense 존재 여부를 initial로 모델: undefined=expense없음, null=영수증없음, string=기존 key
function fakeRepo(initial: string | null | undefined) {
  let key = initial;
  const repo: ReceiptRepo = {
    getReceiptKey: async () => key,
    setReceiptKey: async (_t, _e, k) => {
      if (key === undefined) return false; // expense 없음
      key = k;
      return true;
    },
    clearReceiptKey: async () => {
      key = null;
    },
  };
  return { repo, current: () => key };
}
function fakeFiles() {
  const puts: { bucket: string; key: string; ct: string }[] = [];
  const dels: string[] = [];
  const files: FilesPort = {
    putObject: async (bucket, key, _b, ct) => {
      puts.push({ bucket, key, ct });
    },
    getObject: async () => ({ bytes: new Uint8Array([9]), contentType: "image/png" }),
    deleteObject: async (_b, key) => {
      dels.push(key);
    },
  };
  return { files, puts, dels };
}

describe("ReceiptsService", () => {
  it("attach: 파일 저장 + key 설정 + objectKey 반환", async () => {
    const { files, puts } = fakeFiles();
    const { repo, current } = fakeRepo(null); // expense 존재·영수증 없음
    const svc = new ReceiptsService(files, repo, { bucket: "trip-mate", genKey: () => "uuid1" });
    const r = await svc.attach("t1", "e1", new Uint8Array([1, 2]), "image/jpeg");
    expect(r.objectKey).toBe("receipts/t1/e1/uuid1");
    expect(puts).toEqual([{ bucket: "trip-mate", key: "receipts/t1/e1/uuid1", ct: "image/jpeg" }]);
    expect(current()).toBe("receipts/t1/e1/uuid1");
  });
  it("attach: expense 없음 → NotFound + 파일 저장 안 함(orphan 방지)", async () => {
    const { files, puts } = fakeFiles();
    const { repo } = fakeRepo(undefined);
    const svc = new ReceiptsService(files, repo, { bucket: "trip-mate", genKey: () => "u" });
    await expect(svc.attach("t1", "e1", new Uint8Array([1]), "image/jpeg")).rejects.toBeInstanceOf(
      NotFoundError,
    );
    expect(puts).toHaveLength(0);
  });
  it("get: 영수증 있으면 files에서 스트림 반환", async () => {
    const { files } = fakeFiles();
    const { repo } = fakeRepo("receipts/t1/e1/x");
    const svc = new ReceiptsService(files, repo, { bucket: "trip-mate" });
    const obj = await svc.get("t1", "e1");
    expect(obj.contentType).toBe("image/png");
  });
  it("get: 영수증 없음 → NotFound", async () => {
    const { files } = fakeFiles();
    const { repo } = fakeRepo(null);
    const svc = new ReceiptsService(files, repo, { bucket: "trip-mate" });
    await expect(svc.get("t1", "e1")).rejects.toBeInstanceOf(NotFoundError);
  });
  it("remove: files 삭제 + key clear", async () => {
    const { files, dels } = fakeFiles();
    const { repo, current } = fakeRepo("receipts/t1/e1/x");
    const svc = new ReceiptsService(files, repo, { bucket: "trip-mate" });
    await svc.remove("t1", "e1");
    expect(dels).toEqual(["receipts/t1/e1/x"]);
    expect(current()).toBeNull();
  });
});
