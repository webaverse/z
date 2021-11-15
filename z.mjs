import {
  zbencode,
  zbdecode,
} from './encoding.mjs';
import {align4} from './util.mjs';

const MESSAGES = (() => {
  let iota = 0;
  return {
    STATE_RESET: ++iota,
    TRANSACTION: ++iota,
  };
})();

/* const _parseKey = s => {
  const match = s.match(/^([\s\S]*?)(?::[\s\S])?$/);
  const key = match[1] ?? '';
  const type = match[2] ?? '';
  return {
    key,
    type,
  };
}; */
const _makeDataView = uint8Array => new DataView(uint8Array.buffer, uint8Array.byteOffset, uint8Array.byteLength);
const _parseBoundEvent = (doc, encodedEventData) => {
  const dataView = _makeDataView(encodedEventData);
  
  let index = 0;
  const method = dataView.getUint32(index, true);
  const Cons = ZEVENT_CONSTRUCTORS[method];
  return Cons.deserializeUpdate(doc, encodedEventData);
};

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();
const observersMap = new WeakMap();
const bindingsMap = new WeakMap(); // XXX populate this

class ZEventEmitter {
  constructor() {
    this.listeners = {};
  }
  on(k, fn) {
    let ls = this.listeners[k];
    if (!ls) {
      ls = [];
      this.listeners[k] = ls;
    }
    ls.push(fn);
  }
  once(k, fn) {
    this.on(k, fn);
    
    const fn2 = () => {
      this.off(k, fn);
      this.off(k, fn2);
    };
    this.on(k, fn2);
  }
  off(k, fn) {
    const ls = this.listeners[k];
    if (ls) {
      for (;;) {
        const index = ls.indexOf(fn);
        if (index !== -1) {
          ls.splice(index, 1);
        } else {
          break;
        }
      }
    }
  }
  dispatchEvent(k, a, b, c, d) {
    const listeners = this.listeners[k];
    if (listeners) {
      for (const fn of listeners) {
        fn(a, b, c, d);
      }
    }
  }
}

class TransactionCache {
  constructor(doc, origin) {
    this.doc = doc;
    this.origin = origin;
    this.events = [];
  }
  pushEvent(event) {
    this.events.push(event);
  }
  triggerEvents() {
    for (const event of this.events) {
      event.triggerObservers();
    }
  }
  serializeUpdate() {
    let totalSize = 0;
    totalSize += Uint32Array.BYTES_PER_ELEMENT; // method
    totalSize += Uint32Array.BYTES_PER_ELEMENT; // clock
    totalSize += Uint32Array.BYTES_PER_ELEMENT; // num events
    const updateByteLengths = this.events.map(event => {
      totalSize += Uint32Array.BYTES_PER_ELEMENT; // length
      const updateByteLength = event.computeUpdateByteLength();
      totalSize += updateByteLength;
      return updateByteLength;
    });
    
    const ab = new ArrayBuffer(totalSize);
    const uint8Array = new Uint8Array(ab);
    const dataView = new DataView(ab);
    let index = 0;
    dataView.setUint32(index, MESSAGES.TRANSACTION, true);
    index += Uint32Array.BYTES_PER_ELEMENT;
    dataView.setUint32(index, this.doc.clock, true);
    index += Uint32Array.BYTES_PER_ELEMENT;
    dataView.setUint32(index, this.events.length, true);
    index += Uint32Array.BYTES_PER_ELEMENT;
    for (let i = 0; i < this.events.length; i++) {
      const event = this.events[i];
      const updateByteLength = updateByteLengths[i];
      
      dataView.setUint32(index, updateByteLength, true);
      totalSize += Uint32Array.BYTES_PER_ELEMENT; // length
      
      event.serializeUpdate(new Uint8Array(uint8Array.buffer, uint8Array.byteOffset + index, updateByteLength));
      totalSize += updateByteLength;
    }
    return uint8Array;
  }
}

let zEventsIota = 0;
class ZEvent {
  constructor(impl, keyPath) {
    this.impl = impl;
    this.keyPath = keyPath;
    
    this.keyPathBuffer = null;
  }
  triggerObservers() {
    const observers = observersMap.get(this.impl);
    if (observers) {
      for (const fn of observers) {
        fn(this);
      }
    }
  }
  getKeyPathBuffer() {
    if (this.keyPathBuffer === null) {
      this.keyPathBuffer = textEncoder.encode(JSON.stringify(this.keyPathJson));
    }
    return this.keyPathBuffer;
  }
  computeUpdateByteLength() {
    throw new Error('not implemented');
  }
  serializeUpdate(uint8Array) {
    throw new Error('not implemented');
  }
  deserializeUpdate(doc, encodedEventData) {
    throw new Error('not implemented');
  }
}
class ZMapEvent extends ZEvent {
  constructor(impl, keyPath) {
    super(impl, keyPath);
  }
}
class ZArrayEvent extends ZEvent {
  constructor(impl, keyPath) {
    super(impl, keyPath);
  }
}
class ZMapSetEvent extends ZMapEvent {
  constructor(impl, keyPath, key, value) {
    super(impl, keyPath);
    
    this.key = key;
    this.value = value;

    this.keyBuffer = null;
    this.valueBuffer = null;
  }
  static METHOD = ++zEventsIota;
  apply() {
    this.impl.binding[this.key] = this.value;
  }
  getKeyBuffer() {
    if (this.keyBuffer === null) {
      this.keyBuffer = textEncoder.encode(this.key);
    }
  }
  getValueBuffer() {
    if (this.valueBuffer === null) {
      this.valueBuffer = zbencode(this.value);
    }
  }
  computeUpdateByteLength() {
    let totalSize = 0;
    totalSize += Uint32Array.BYTES_PER_ELEMENT; // method
    
    totalSize += Uint32Array.BYTES_PER_ELEMENT; // key path length
    totalSize += this.getKeyPathBuffer().byteLength; // key path data
    totalSize = align4(totalSize);
    
    totalSize += Uint32Array.BYTES_PER_ELEMENT; // key length
    totalSize += this.getValueBuffer().byteLength; // key data
    totalSize = align4(totalSize);
    
    totalSize += Uint32Array.BYTES_PER_ELEMENT; // value length
    totalSize += this.getValueBuffer().byteLength; // value data
    totalSize = align4(totalSize);
    
    return totalSize;
  }
  serializeUpdate(uint8Array) {
    const dataView = _makeDataView(uint8Array);
    
    let index = 0;
    dataView.setUint32(index, this.constructor.METHOD, true);
    index += Uint32Array.BYTES_PER_ELEMENT;
    
    const kpjb = this.getKeyPathBuffer();
    dataView.setUint32(index, kpjb.byteLength, true);
    index += Uint32Array.BYTES_PER_ELEMENT;
    uint8Array.set(kpjb, index);
    index += kpjb.byteLength;
    index = align4(index);
    
    const kb = this.getKeyBuffer();
    dataView.setUint32(index, kb.byteLength, true);
    index += Uint32Array.BYTES_PER_ELEMENT;
    uint8Array.set(vb, index);
    index += vb.byteLength;
    index = align4(index);
    
    const vb = this.getValueBuffer();
    dataView.setUint32(index, vb.byteLength, true);
    index += Uint32Array.BYTES_PER_ELEMENT;
    uint8Array.set(vb, index);
    index += vb.byteLength;
    index = align4(index);
  }
  static deserializeUpdate(doc, encodedEventData) {
    let index = 0;
    // skip method
    index += Uint32Array.BYTES_PER_ELEMENT;
    
    const kpjbLength = dataView.getUint32(index, true);
    index += Uint32Array.BYTES_PER_ELEMENT;
    const kpjb = new Uint8Array(uint8Array.buffer, uint8Array.byteOffset + index, kpjbLength);
    const keyPath = JSON.parse(textDecoder.decode(kpjb)); 
    index += kpjbLength;
    index = align4(index);

    const kbLength = dataView.getUint32(index, true);
    index += Uint32Array.BYTES_PER_ELEMENT;
    const kb = new Uint8Array(uint8Array.buffer, uint8Array.byteOffset + index, kbLength);
    const key = textDecoder.decode(kb);
    index += vbLength;
    index = align4(index);

    const vbLength = dataView.getUint32(index, true);
    index += Uint32Array.BYTES_PER_ELEMENT;
    const vb = new Uint8Array(uint8Array.buffer, uint8Array.byteOffset + index, vbLength);
    const value = zbdecode(vb);
    index += vbLength;
    index = align4(index);
    
    const impl = doc.getImplFromKeyPath(keyPath);
    
    return new this(
      impl,
      keyPath,
      key,
      value
    );
  }
}
class ZMapDeleteEvent extends ZMapEvent {
  constructor(impl, keyPath, key) {
    super(impl);

    this.keyPath = keyPath;
    this.key = key;
  }
  static METHOD = ++zEventsIota;
  apply() {
    delete this.impl.binding[this.key];
  }
}
class ZArrayInsertEvent extends ZArrayEvent {
  constructor(impl, keyPath, index, arr) {
    super(impl);

    this.keyPath = keyPath;
    this.index = index;
    this.arr = arr;
  }
  static METHOD = ++zEventsIota;
  apply() {
    this.impl.binding.splice.apply(this.impl.binding, [this.index, 0].concat(this.arr));
  }
}
class ZArrayDeleteEvent extends ZArrayEvent {
  constructor(impl, keyPath, index, length) {
    super(impl);

    this.keyPath = keyPath;
    this.index = index;
    this.length = length;
  }
  static METHOD = ++zEventsIota;
  apply() {
    this.impl.binding.splice.apply(this.impl.binding, [this.index, this.length]);
  }
}
class ZArrayPushEvent extends ZArrayEvent {
  constructor(impl, keyPath, arr) {
    super(impl);

    this.keyPath = keyPath;
    this.arr = arr;
  }
  static METHOD = ++zEventsIota;
  apply() {
    this.impl.binding.push.apply(this.impl.binding, this.arr);
  }
}
class ZArrayUnshiftEvent extends ZArrayEvent {
  constructor(impl, keyPath, arr) {
    super(impl);

    this.keyPath = keyPath;
    this.arr = arr;
  }
  static METHOD = ++zEventsIota;
  apply() {
    this.impl.binding.unshift.apply(this.impl.binding, this.arr);
  }
}
const ZEVENT_CONSTRUCTORS = [
  null, // start at 1
  ZMapSetEvent,
  ZMapDeleteEvent,
  ZArrayInsertEvent,
  ZArrayDeleteEvent,
  ZArrayPushEvent,
  ZArrayUnshiftEvent,
];

class ZDoc extends ZEventEmitter {
  constructor() {
    super();

    this.state = {};
    this.clock = 0;
    this.history = []; // XXX track this
    this.transactionDepth = 0;
    this.transactionCache = null;
  }
  get(k, Type) {
    let binding = this.state[k];
    if (binding === undefined) {
      binding = Type.nativeConstructor();
      this.state[k] = binding;
    }
    return new Type(binding, this);
  }
  getArray(k) {
    return this.get(k, ZArray);
  }
  getMap(k) {
    return this.get(k, ZMap);
  }
  pushTransaction(origin) {
    if (++this.transactionDepth === 1) {
      this.transactionCache = new TransactionCache(this, origin);
    }
  }
  popTransaction() {
    if (--this.transactionDepth === 0) {
      this.clock++;
      this.transactionCache.triggerEvents();
      const uint8Array = this.transactionCache.serializeUpdate();
      if (uint8Array) {
        this.dispatchEvent('update', uint8Array, this.transactionCache.origin, this, null);
      }
      this.transactionCache = null;
    }
  }
  transact(fn, origin) {
    this.pushTransaction(origin);
    fn();
    this.popTransaction();
  }
  setClockState(clock, state) {
    this.clock = clock;
    this.state = state; // XXX need to trigger observers from the old state
  }
  getImplFromKeyPath(keyPath) {
    return null; // XXX return the correct impl by walking the key path downwards
  }
}

class ZObservable {
  constructor(binding, doc) {
    this.binding = binding;
    this.doc = doc;
  }
  observe(fn) {
    let observers = observersMap.get(this);
    if (!observers) {
      observers = [];
      observersMap.set(this, observers);
    }
    observers.push(fn);
  }
  unobserve(fn) {
    const observers = observersMap.get(this);
    if (observers) {
      const index = observers.indexOf(fn);
      if (index !== -1) {
        observers.splice(index, 1);
      }
    }
  }
  getKeyPath() {
    return []; // XXX return the correct key path by walking the binding upwards
  }
  toJSON() {
    return this.binding;
  }
}

class ZMap extends ZObservable {
  constructor(binding = ZMap.nativeConstructor(), doc = null) {
    super(binding, doc);
  }
  static nativeConstructor = () => ({});
  has(k) {
    return k in this.binding;
  }
  get(k) {
    return this.binding[k];
  }
  set(k, v) {
    const keyPath = this.getKeyPath();
    keyPath.push(k + ':k');
    const event = new ZMapSetEvent(
      this,
      keyPath,
      k,
      v
    );
    if (this.doc) {
      this.doc.pushTransaction('mapSet'); // XXX make these symbols and have one for update
      this.doc.transactionCache.pushEvent(event);
    }
    event.apply();
    if (this.doc) {
      this.doc.popTransaction();
    }
  }
  delete(k) {
    delete this.binding[k];
    const keyPath = this.getKeyPath();
    keyPath.push(k + ':k');
    const event = new ZMapDeleteEvent(
      this,
      keyPath,
      k
    );
    if (this.doc) {
      this.doc.pushTransaction('mapDelete');
      this.doc.transactionCache.pushEvent(event);
    }
    event.apply();
    if (this.doc) {
      this.doc.popTransaction();
    }
  }
  keys() {
    const keys = Object.keys(this.binding);
    let i = 0;
    const next = () => {
      if (i < keys.length) {
        const key = keys[i++];
        return {
          done: false,
          value: key,
        };
      } else {
        return {
          done: true,
          value: null,
        };
      }
    };
    return {
      next,
      [Symbol.iterator]: () => ({next}),
    };
  }
  values() {
    const keys = Object.keys(this.binding);
    let i = 0;
    const next = () => {
      if (i < keys.length) {
        const key = keys[i++];
        const value = this.get(key);
        return {
          done: false,
          value,
        };
      } else {
        return {
          done: true,
          value: null,
        };
      }
    };
    return {
      next,
      [Symbol.iterator]: () => ({next}),
    };
  }
  entries() {
    const keys = Object.keys(this.binding);
    let i = 0;
    const next = () => {
      if (i < keys.length) {
        const key = keys[i++];
        const value = this.get(key);
        return {
          done: false,
          value: [key, value],
        };
      } else {
        return {
          done: true,
          value: null,
        };
      }
    };
    return {
      next,
      [Symbol.iterator]: () => ({next}),
    };
  }
}

class ZArray extends ZObservable {
  constructor(binding = ZArray.nativeConstructor(), doc = null) {
    super(binding, doc);
  }
  static nativeConstructor = () => [];
  get length() {
    return this.binding.length;
  }
  set length(length) {
    this.binding.length = length;
  }
  get(index) {
    return this.binding[index];
  }
  insert(index, arr) {
    if (arr.length !== 1) {
      throw new Error('only length 1 is supported');
    }
    const keyPath = this.getKeyPath();
    keyPath.push(keyPath.length + ':i');
    const event = new ZArrayInsertEvent(
      this,
      keyPath,
      arr
    );
    if (this.doc) {
      this.doc.pushTransaction('arrayInsert');
      this.doc.transactionCache.pushEvent(event);
    }
    event.apply();
    if (this.doc) {
      this.doc.popTransaction();
    }
  }
  delete(index, length = 1) {
    if (length !== 1) {
      throw new Error('only length 1 is supported');
    }
    const keyPath = this.getKeyPath();
    keyPath.push(keyPath.length + ':i');
    const event = new ZArrayDeleteEvent(
      this,
      keyPath,
      index,
      length
    );
    if (this.doc) {
      this.doc.pushTransaction('arrayDelete');
      this.doc.transactionCache.pushEvent(event);
    }
    event.apply();
    if (this.doc) {
      this.doc.popTransaction();
    }
  }
  push(arr) {
    if (arr.length !== 1) {
      throw new Error('only length 1 is supported');
    }
    const keyPath = this.getKeyPath();
    keyPath.push(keyPath.length + ':i');
    const event = new ZArrayPushEvent(
      this,
      keyPath,
      arr
    );
    if (this.doc) {
      this.doc.pushTransaction('arrayPush');
      this.doc.transactionCache.pushEvent(event);
    }
    event.apply();
    if (this.doc) {
      this.doc.popTransaction();
    }
  }
  unshift(arr) {
    if (arr.length !== 1) {
      throw new Error('only length 1 is supported');
    }
    const keyPath = this.getKeyPath();
    keyPath.push(keyPath.length + ':i');
    const event = new ZArrayUnshiftEvent(
      this,
      keyPath,
      arr
    );
    if (this.doc) {
      this.doc.pushTransaction('arrayUnshift');
      this.doc.transactionCache.pushEvent(event);
    }
    event.apply();
    if (this.doc) {
      this.doc.popTransaction();
    }
  }
  [Symbol.Iterator] = () => {
    let i = 0;
    return {
      next: () => {
        if (i < this.length) {
          return {
            done: false,
            value: this.get(i++),
          };
        } else {
          return {
            done: true,
            value: null,
          };
        }
      },
    };
  }
}

function applyUpdate(doc, uint8Array, transactionOrigin) {
  const dataView = _makeDataView(uint8Array);
  
  let index = 0;
  const method = dataView.getUint32(index, true);
  index += Uint32Array.BYTES_PER_ELEMENT;
  
  const _handleStateMessage = () => {
    const clock = dataView.getUint32(index, true);
    index += Uint32Array.BYTES_PER_ELEMENT;
    
    const encodedData = new Uint8Array(uint8Array.buffer, uint8Array.byteOffset + index, uint8Array.byteLength);
    const state = zbdecode(encodedData);
    doc.setClockState(clock, state);
  };
  const _handleTransactionMessage = () => {
    const clock = dataView.getUint32(index, true);
    index += Uint32Array.BYTES_PER_ELEMENT;
    
    const numEvents = dataView.getUint32(index, true);
    index += Uint32Array.BYTES_PER_ELEMENT;
    
    for (let i = 0; i < numEvents; i++) {
      const eventLength = dataView.getUint32(index, true);
      index += Uint32Array.BYTES_PER_ELEMENT;
      
      const encodedEventData = new Uint8Array(uint8Array.buffer, uint8Array.byteOffset + index, eventLength);
      const event = _parseBoundEvent(doc, encodedEventData);
      event.apply(); // XXX handle conflicts
      index += eventLength;
      index = align4(index);
    }
  };
  switch (method) {
    case MESSAGES.STATE_RESET: {
      _handleStateMessage();
      break;
    }
    case MESSAGES.TRANSACTION: {
      _handleTransactionMessage();
      break;
    }
    default: {
      console.warn('unknown method:', method);
      break;
    }
  }
}

function encodeStateAsUpdate(doc) {
  const encodedData = zbencode(doc.state);
  
  const totalSize = Uint32Array.BYTES_PER_ELEMENT + encodedData.byteLength;
  const ab = new ArrayBuffer(totalSize);
  const uint8Array = new Uint8Array(ab);
  const dataView = new DataView(ab);
  
  let index = 0;
  dataView.setUint32(index, MESSAGES.STATE_RESET, true);
  index += Uint32Array.BYTES_PER_ELEMENT;
  
  dataView.setUint32(index, doc.clock, true);
  index += Uint32Array.BYTES_PER_ELEMENT;
  
  uint8Array.set(new Uint8Array(encodedData.buffer, encodedData.byteOffset, encodedData.byteLength), index);
  index += encodedData.byteLength;
  
  return uint8Array;
}

export {
  ZDoc as Doc,
  ZMap as Map,
  ZArray as Array,
  applyUpdate,
  encodeStateAsUpdate,
  zbencode,
  zbdecode,
};

const Z = {
  Doc: ZDoc,
  Map: ZMap,
  Array: ZArray,
  applyUpdate,
  encodeStateAsUpdate,
  zbencode,
  zbdecode,
};
export default Z;
globalThis.Z = Z;

import * as Y from 'yjs';
globalThis.Y = Y;