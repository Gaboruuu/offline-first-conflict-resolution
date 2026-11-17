/**
 * Min-priority queue of timed events. Events with the same time come out in insertion order, so the
 * simulation never depends on how the heap happens to break ties.
 */
export class EventQueue<E> {
  private heap: { t: number; seq: number; event: E }[] = [];
  private counter = 0;

  get size(): number {
    return this.heap.length;
  }

  push(t: number, event: E): void {
    if (!Number.isFinite(t)) throw new RangeError(`event time must be finite, got ${t}`);
    this.heap.push({ t, seq: this.counter++, event });
    this.up(this.heap.length - 1);
  }

  /** Time of the next event, or undefined when the queue is empty. */
  peekTime(): number | undefined {
    return this.heap[0]?.t;
  }

  pop(): { t: number; event: E } | undefined {
    const top = this.heap[0];
    if (!top) return undefined;
    const last = this.heap.pop()!;
    if (this.heap.length > 0) {
      this.heap[0] = last;
      this.down(0);
    }
    return { t: top.t, event: top.event };
  }

  private less(i: number, j: number): boolean {
    const a = this.heap[i]!;
    const b = this.heap[j]!;
    return a.t < b.t || (a.t === b.t && a.seq < b.seq);
  }

  private swap(i: number, j: number): void {
    const tmp = this.heap[i]!;
    this.heap[i] = this.heap[j]!;
    this.heap[j] = tmp;
  }

  private up(i: number): void {
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (!this.less(i, parent)) return;
      this.swap(i, parent);
      i = parent;
    }
  }

  private down(i: number): void {
    for (;;) {
      const l = 2 * i + 1;
      const r = l + 1;
      let m = i;
      if (l < this.heap.length && this.less(l, m)) m = l;
      if (r < this.heap.length && this.less(r, m)) m = r;
      if (m === i) return;
      this.swap(i, m);
      i = m;
    }
  }
}
