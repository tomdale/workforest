/**
 * Keeps the most recent portion of string output without retaining the full
 * stream in memory.
 */
export class TailBuffer {
  readonly #maxChars: number;
  #value = "";

  constructor(maxChars: number) {
    this.#maxChars = maxChars;
  }

  append(chunk: string): void {
    if (chunk.length === 0 || this.#maxChars <= 0) {
      return;
    }

    this.#value = (this.#value + chunk).slice(-this.#maxChars);
  }

  toString(): string {
    return this.#value;
  }
}
