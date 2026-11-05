/** Serializes writes and permanently closes the writer during this background's cleanup. */
export class LocalData {
  constructor(storage) { this.storage = storage; this.closed = false; this.tail = Promise.resolve(); }

  write(operation) {
    if (this.closed) return Promise.reject(new Error("Local data is being erased. Reopen the extension to use it again."));
    const result = this.tail.then(() => {
      if (this.closed) throw new Error("Local data is being erased.");
      return operation(this.storage);
    });
    this.tail = result.catch(() => {});
    return result;
  }

  stop() { this.closed = true; }

  async clear() {
    this.stop();
    await this.tail; // Existing writes finish before the final clear; queued writes are rejected.
    await this.storage.clear();
    if (Object.keys(await this.storage.get(null)).length) throw new Error("Could not verify that Safari extension storage is empty. Retry cleanup.");
  }
}
