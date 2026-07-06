import { NotFoundError } from "../../core/errors.ts";
import type { FilesPort, StoredObject } from "./files.port.ts";

/** 영수증 ↔ expense 매핑 저장소. undefined=expense 없음, null=영수증 없음, string=object key. */
export interface ReceiptRepo {
  getReceiptKey(tripId: string, expenseId: string): Promise<string | null | undefined>;
  setReceiptKey(tripId: string, expenseId: string, key: string): Promise<boolean>; // false=expense 없음
  clearReceiptKey(tripId: string, expenseId: string): Promise<void>;
}

interface Opts {
  bucket: string;
  genKey?: () => string;
}

/** 컨트롤러가 의존하는 영수증 서비스 표면(테스트 fake 주입용). */
export interface ReceiptsPort {
  attach(
    tripId: string,
    expenseId: string,
    bytes: Uint8Array,
    contentType: string,
  ): Promise<{ objectKey: string }>;
  get(tripId: string, expenseId: string): Promise<StoredObject>;
  remove(tripId: string, expenseId: string): Promise<void>;
}

/** 영수증 프록시 서비스 — files 서버 저장 + expense.receipt_object_key 매핑. FilesPort/ReceiptRepo 주입(테스트 fake). */
export class ReceiptsService implements ReceiptsPort {
  private readonly genKey: () => string;
  constructor(
    private readonly files: FilesPort,
    private readonly repo: ReceiptRepo,
    private readonly opts: Opts,
  ) {
    this.genKey = opts.genKey ?? (() => crypto.randomUUID());
  }

  /** 업로드 — expense 존재 확인 후 files put + key 설정. 존재 확인 선행으로 orphan 업로드 방지. */
  async attach(
    tripId: string,
    expenseId: string,
    bytes: Uint8Array,
    contentType: string,
  ): Promise<{ objectKey: string }> {
    if ((await this.repo.getReceiptKey(tripId, expenseId)) === undefined)
      throw new NotFoundError("expense not found", { tripId, expenseId });
    const key = `receipts/${tripId}/${expenseId}/${this.genKey()}`;
    await this.files.putObject(this.opts.bucket, key, bytes, contentType);
    if (!(await this.repo.setReceiptKey(tripId, expenseId, key)))
      throw new NotFoundError("expense not found", { tripId, expenseId }); // 동시 삭제 경쟁
    return { objectKey: key };
  }

  async get(tripId: string, expenseId: string): Promise<StoredObject> {
    const key = await this.repo.getReceiptKey(tripId, expenseId);
    if (key === undefined) throw new NotFoundError("expense not found", { tripId, expenseId });
    if (key === null) throw new NotFoundError("no receipt", { tripId, expenseId });
    return this.files.getObject(this.opts.bucket, key);
  }

  async remove(tripId: string, expenseId: string): Promise<void> {
    const key = await this.repo.getReceiptKey(tripId, expenseId);
    if (key) {
      await this.files.deleteObject(this.opts.bucket, key);
      await this.repo.clearReceiptKey(tripId, expenseId);
    }
  }
}
