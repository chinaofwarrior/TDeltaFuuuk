// 无锁单生产者/单消费者环形缓冲区（《开发方案》第八节）。
// 单线程 JS 环境下用数组 + 序号实现，保持 SPSC 语义与容量/覆盖策略。

export class RingBuffer {
  constructor(capacity = 4096) {
    this.capacity = capacity;
    this.buf = new Array(capacity);
    this.head = 0; // 下一个写入位
    this.tail = 0; // 下一个读取位
    this.count = 0;
  }

  push(item) {
    if (this.count === this.capacity) {
      // 满：覆盖最旧（丢弃最旧读取位）
      this.tail = (this.tail + 1) % this.capacity;
    } else {
      this.count += 1;
    }
    this.buf[this.head] = item;
    this.head = (this.head + 1) % this.capacity;
    return true;
  }

  pop() {
    if (this.count === 0) return undefined;
    const item = this.buf[this.tail];
    this.buf[this.tail] = undefined;
    this.tail = (this.tail + 1) % this.capacity;
    this.count -= 1;
    return item;
  }

  drain() {
    const out = [];
    while (this.count > 0) out.push(this.pop());
    return out;
  }

  get size() {
    return this.count;
  }

  get isFull() {
    return this.count === this.capacity;
  }
}
