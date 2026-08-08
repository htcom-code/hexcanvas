/** Storage contract. Implementations may be backed by memory, pages, or IPC. */
export interface BinaryBuffer {
  readonly length: number;
  read(offset: number, length: number): Uint8Array;
  write(offset: number, bytes: Uint8Array): void;
}

/** An editable buffer for browser demos and unit tests. */
export class MemoryBinaryBuffer implements BinaryBuffer {
  private readonly data: Uint8Array;

  constructor(data: Uint8Array | ArrayBuffer) {
    this.data = data instanceof Uint8Array ? new Uint8Array(data) : new Uint8Array(data.slice(0));
  }

  get length(): number {
    return this.data.length;
  }

  read(offset: number, length: number): Uint8Array {
    this.assertRange(offset, length);
    return this.data.slice(offset, offset + length);
  }

  write(offset: number, bytes: Uint8Array): void {
    this.assertRange(offset, bytes.length);
    this.data.set(bytes, offset);
  }

  toUint8Array(): Uint8Array {
    return this.data.slice();
  }

  private assertRange(offset: number, length: number): void {
    if (!Number.isInteger(offset) || !Number.isInteger(length) || offset < 0 || length < 0 || offset + length > this.length) {
      throw new RangeError(`Byte range ${offset}..${offset + length} is outside buffer length ${this.length}.`);
    }
  }
}
