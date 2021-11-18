import {
  zbencode,
  zbdecode,
  zbclone,
} from './encoding.mjs';
import {align4} from './util.mjs';

const MESSAGES = (() => {
  let iota = 0;
  return {
    STATE_RESET: ++iota,
    TRANSACTION: ++iota,
  };
})();
export const TRANSACTION_TYPES = {
  null: Symbol('null'),
  mapSet: Symbol('mapSet'),
  mapDelete: Symbol('mapDelete'),
  arrayPush: Symbol('arrayPush'),
  arrayRemove: Symbol('arrayRemove'),
};

// XXX can use a power-of-two buffer cache for memory

const _makeId = () => Math.round(Math.random() * 0xFFFFFF);
const _jsonify = o => {
  const impl = bindingsMap.get(o);
  if (impl?.isZArray) {
    return o.e.map(_jsonify);
  } else if (Array.isArray(o)) {
    return o.map(_jsonify);
  } else if (
    o instanceof Uint8Array ||
    o instanceof Uint16Array ||
    o instanceof Uint32Array ||
    o instanceof Int8Array ||
    o instanceof Int16Array ||
    o instanceof Int32Array ||
    o instanceof Float32Array ||
    o instanceof Float64Array
  ) {
    return o;
  } else if (o !== null && typeof o === 'object') {
    const result = {};
    for (const k in o) {
      result[k] = _jsonify(o[k]);
    }
    return result;
  } else {
    return o;
  }
};
const _getBindingForValue = e => {
  if (e?.isZMap || e?.isZArray) {
    return e.binding;
  } else {
    return e;
  }
};
const _getBindingForArray = arr => arr.map(_getBindingForValue);

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
  if (Cons) {
    return Cons.deserializeUpdate(doc, encodedEventData);
  } else {
    console.warn('could not parse bound event due to incorrect method', method, ZEVENT_CONSTRUCTORS);
    return null;
  }
};

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();
const observersMap = new WeakMap();
const bindingsMap = new WeakMap();
const bindingParentsMap = new WeakMap();

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

const _keyPathEquals = (a, b) => {
  if (a.length === b.length) {
    for (let i = 0; i < a.length; i++) {
      const ae = a[i];
      const be = b[i];
      if (ae[0] !== be[0] /*|| ae[1] !== be[1]*/) {
        return false;
      }
    }
    return true;
  } else {
    return false;
  }
};
const _isKeyPathPrefix = (a, b) => {
  if (a.length < b.length) {
    for (let i = 0; i < a.length; i++) {
      const ae = a[i];
      const be = b[i];
      if (ae[0] !== be[0] /*|| ae[1] !== be[1]*/) {
        return false;
      }
    }
    return true;
  } else {
    return false;
  }
};
const _parentWasSet = (event, historyTail) => historyTail.some(historyEvent => {
  return _isKeyPathPrefix(historyEvent.keyPath, event.keyPath) &&
    (
      (historyEvent.isZMapSetEvent) ||
      (historyEvent.isZMapDeleteEvent) ||
      (historyEvent.isZArrayDeleteEvent)
    );
});
const _getConflict = (event, historyTail) => historyTail.find(historyEvent => {
  return ((historyEvent.isZMapSetEvent) || (historyEvent.isZMapDeleteEvent)) &&
    _keyPathEquals(historyEvent.keyPath, event.keyPath);
});
const _alreadyDeleted = (event, historyTail) => historyTail.some(historyEvent => {
  return (historyEvent.isZArrayDeleteEvent) &&
    _keyPathEquals(historyEvent.keyPath, event.keyPath);
});
class TransactionCache {
  constructor(doc, origin, startClock = doc.clock, resolvePriority = doc.resolvePriority, events = []) {
    this.doc = doc;
    this.origin = origin;
    this.startClock = startClock;
    this.resolvePriority = resolvePriority;
    this.events = events;
  }
  pushEvent(event) {
    this.events.push(event);
  }
  bindEventsToDoc() {
    for (const event of this.events) {
      event.bindToDoc(this.doc);
    }
  }
  rebase(historyTail) {
    const rebasedEvents = this.events.map(event => {
      if (event.isZMapSetEvent || event.isZMapDeleteEvent) {
        let conflict;
        if (_parentWasSet(event, historyTail)) {
          // console.log('torpedo self due to parent conflict');
          return new ZNullEvent();
        } else if (conflict = _getConflict(event, historyTail)) {
          if (this.resolvePriority < this.doc.resolvePriority) {
            // console.log('torpedo remote due to high prio');
            while (conflict) {
              const nullEvent = new ZNullEvent();
              {
                const index = historyTail.indexOf(conflict);
                historyTail.splice(index, 1, nullEvent);
              }
              {
                const index = this.history.indexOf(conflict);
                this.history.splice(index, 1, nullEvent);
              }
              conflict = _getConflict(event, historyTail);
            }
            
            return event;
          } else {
            // console.log('torpedo self due to low prio');
            return new ZNullEvent();
          }
        } else {
          // console.log('no conflicts');
          return event;
        }
      } else if (event.isZArrayPushEvent) {
        if (_parentWasSet(event, historyTail)) {
          return new ZNullEvent();
        } else {
          // console.log('no conflicts');
          return event;
        }
      } else if (event.isZArrayDeleteEvent) {
        if (_parentWasSet(event, historyTail) || _alreadyDeleted(event, historyTail)) {
          // console.log('torpedo self due to parent conflict');
          return new ZNullEvent();
        } else {
          // console.log('no conflicts');
          return event;
        }
      } else if (event.isZNullEvent) {
        // console.log('skip null event');
        return event;
      } else {
        console.warn('unknown event type', event);
        return event;
      }
    });
    this.events = rebasedEvents;
    this.startClock += historyTail.length;
  }
  serializeUpdate() {    
    let totalSize = 0;
    totalSize += Uint32Array.BYTES_PER_ELEMENT; // method
    totalSize += Uint32Array.BYTES_PER_ELEMENT; // clock
    totalSize += Uint32Array.BYTES_PER_ELEMENT; // resolve priority
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
    
    // XXX setBigUint64
    dataView.setUint32(index, this.startClock, true);
    index += Uint32Array.BYTES_PER_ELEMENT;
    
    dataView.setUint32(index, this.resolvePriority, true);
    index += Uint32Array.BYTES_PER_ELEMENT;
    
    dataView.setUint32(index, this.events.length, true);
    index += Uint32Array.BYTES_PER_ELEMENT;
    for (let i = 0; i < this.events.length; i++) {
      const event = this.events[i];
      const updateByteLength = updateByteLengths[i];
      
      dataView.setUint32(index, updateByteLength, true);
      index += Uint32Array.BYTES_PER_ELEMENT; // length
      
      event.serializeUpdate(new Uint8Array(uint8Array.buffer, uint8Array.byteOffset + index, updateByteLength));
      index += updateByteLength;
    }
    return uint8Array;
  }
  static deserializeUpdate(doc, uint8Array) {
    const dataView = _makeDataView(uint8Array);
    
    let index = 0;
    // skip method
    index += Uint32Array.BYTES_PER_ELEMENT;
    
    const startClock = dataView.getUint32(index, true);
    index += Uint32Array.BYTES_PER_ELEMENT;
    
    const resolvePriority = dataView.getUint32(index, true);
    index += Uint32Array.BYTES_PER_ELEMENT;
    
    const numEvents = dataView.getUint32(index, true);
    index += Uint32Array.BYTES_PER_ELEMENT;
    const events = Array(numEvents);
    for (let i = 0; i < numEvents; i++) {
      const eventLength = dataView.getUint32(index, true);
      index += Uint32Array.BYTES_PER_ELEMENT;
      
      const encodedEventData = new Uint8Array(uint8Array.buffer, uint8Array.byteOffset + index, eventLength);
      const event = _parseBoundEvent(doc, encodedEventData);
      events[i] = event;
      index += eventLength;
      index = align4(index);
    }
    
    const transactionCache = new TransactionCache(doc, undefined, startClock, resolvePriority, events);
    return transactionCache;
  }
}

class ZDoc extends ZEventEmitter {
  constructor(state = {}, clock = 0, history = []) {
    super();

    this.state = state;
    this.clock = clock;
    this.history = history;
    this.transactionDepth = 0;
    this.transactionCache = null;
    this.resolvePriority = _makeId();
    
    this.isZDoc = true;
    
    bindingsMap.set(this.state, this);
  }
  get(k, Type) {
    let binding = this.state[k];
    if (binding === undefined) {
      binding = Type.nativeConstructor();
      this.state[k] = binding;
    }
    let impl = bindingsMap.get(binding);
    if (!impl) {
      impl = new Type(binding, this);
      bindingsMap.set(binding, impl);
      bindingParentsMap.set(binding, this.state);
    }
    return impl;
  }
  getArray(k) {
    return this.get(k, ZArray);
  }
  getMap(k) {
    return this.get(k, ZMap);
  }
  transact(fn, origin) {
    this.pushTransaction(origin);
    fn();
    this.popTransaction();
  }
  setResolvePriority(resolvePriority) {
    this.resolvePriority = resolvePriority;
  }
  toJSON() {
    return _jsonify(this.state);
  }
  pushTransaction(origin) {
    if (++this.transactionDepth === 1) {
      this.transactionCache = new TransactionCache(this, origin);
    }
  }
  popTransaction() {
    if (--this.transactionDepth === 0) {
      this.clock++;
      const uint8Array = this.transactionCache.serializeUpdate();
      if (uint8Array) {
        this.dispatchEvent('update', uint8Array, this.transactionCache.origin, this, null);
      }
      this.history.push.apply(this.history, this.transactionCache.events);
      this.transactionCache = null;
    }
  }
  setClockState(clock, state) {
    const _emitDeleteEvents = state => {
      const _recurse = binding => {
        const impl = bindingsMap.get(binding);
        
        if (impl.isZDoc) {
          for (const k in impl.state) {
            _recurse(impl.state[k]);
          }
        } else if (impl.isZArray) {
          if (impl.length > 0) {
            const e = {
              added: new Set([]),
              deleted: new Set(impl.binding.e.map(e => bindingsMap.get(e) ?? e)),
              changes: {
                keys: new Map(),
                values: new Map(impl.binding.e.map(e => {
                  return [
                    e,
                    {
                      action: 'delete',
                    },
                  ];
                })),
              },
            };
            impl.triggerObservers(e);
          }
          
          for (let i = 0; i < impl.binding.length; i++) {
            _recurse(impl.binding[i]);
          }
        } else if (impl.isZMap) {
          const keys = Array.from(impl.keys());
          if (keys.length > 0) {
            const e = {
              added: new Set([]),
              deleted: new Set(keys),
              changes: {
                keys: new Map(keys.map(key => {
                  return [
                    key,
                    {
                      action: 'delete',
                    },
                  ];
                })),
                values: new Map(),
              },
            };
            impl.triggerObservers(e);
          }

          for (const k in impl.binding) {
            _recurse(impl.binding[k]);
          }
        } else {
          // nothing
        }
      };
      _recurse(state);
    };
    const _emitAddEvents = state => {
      const _recurse = binding => {
        const impl = bindingsMap.get(binding);
        
        if (impl?.isZDoc) {
          for (const k in impl.state) {
            _recurse(impl.state[k]);
          }
        } else if (impl?.isZArray) {
          if (impl.length > 0) {
            const e = {
              added: new Set(impl.binding.e.map(e => bindingsMap.get(e) ?? e)),
              deleted: new Set([]),
              changes: {
                keys: new Map(),
                values: new Map(impl.binding.e.map(e => {
                  return [
                    e,
                    {
                      action: 'add',
                    },
                  ];
                })),
              },
            };
            impl.triggerObservers(e);
          }
          
          for (let i = 0; i < impl.binding.length; i++) {
            _recurse(impl.binding[i]);
          }
        } else if (impl?.isZMap) {
          const keys = Array.from(impl.keys());
          if (keys.length > 0) {
            const e = {
              added: new Set(keys),
              deleted: new Set([]),
              changes: {
                keys: new Map(keys.map(key => {
                  return [
                    key,
                    {
                      action: 'add',
                    },
                  ];
                })),
                values: new Map(),
              },
            };
            impl.triggerObservers(e);
          }

          for (const k in impl.binding) {
            _recurse(impl.binding[k]);
          }
        } else {
          // nothing
        }
      };
      _recurse(state);
    };
    const _remapState = (oldState, newState) => {
      // remap old impls onto new bindings
      const _lookupKeyPath = (binding, keyPath) => {
        for (const key of keyPath) {
          if (key in binding) {
            binding = binding[key];
          } else {
            return undefined;
          }
        }
        return binding;
      };
      const _recurse = (newBinding, keyPath) => {
        const oldBinding = _lookupKeyPath(oldState, keyPath);
        const newParent = keyPath.length > 0 ? _lookupKeyPath(newState, keyPath.slice(0, -1)) : null;
        let oldImpl;
        if (oldBinding !== undefined) {
          oldImpl = bindingsMap.get(oldBinding);
          oldImpl.binding = newBinding;
          bindingsMap.set(newBinding, oldImpl);
          if (newParent) {
            bindingParentsMap.set(newBinding, newParent);
          }
        }
        
        if (oldImpl?.isZArray) {
          for (let i = 0; i < newBinding.e.length; i++) {
            const zid = newBinding.i[i];
            const index = oldBinding.i.indexOf(zid);
            _recurse(newBinding.e[i], keyPath.concat(['e', index]));
          }
        } else if (Array.isArray(newBinding)) {
          for (let i = 0; i < newBinding.length; i++) {
            _recurse(newBinding[i], keyPath.concat([i]));
          }
        } else if (newBinding !== null && typeof newBinding === 'object') {
          for (const k in newBinding) {
            _recurse(newBinding[k], keyPath.concat([k]));
          }
        } else {
          // nothing
        }
      };
      _recurse(newState, []);
    };
    
    _emitDeleteEvents(this.state);
    _remapState(this.state, state);
    _emitAddEvents(state);
    
    this.clock = clock;
    this.state = state;
    this.history = [];
  }
  getImplByKeyPath(keyPath) {
    let binding = this.state;
    let impl = bindingsMap.get(binding);
    for (let [key, type] of keyPath) {
      let value = binding[key];
      
      const child = (() => {
        switch (type) {
          case 'a': return impl.get(key, ZArray);
          case 'm': return impl.get(key, ZMap);
          case 'ea':
          case 'em':
          case 'ev': {
            switch (type.slice(1)) {
              case 'a': return impl.getId(key, ZArray);
              case 'm': return impl.getId(key, ZMap);
              case 'v': return impl.getId(key);
              default: return undefined;
            }
          }
          case 'v': return impl.get(key);
          default: return undefined;
        }
      })();
      if (child) {
        impl = child;
        binding = child.binding;
      } else {
        // console.warn('could not look up key path', [key, type], impl);
        return undefined;
      }
    }
    return impl;
  }
  clone() {
    return new ZDoc(
      zbclone(this.state),
      this.clock,
      this.history.map(e => {
        return e.clone();
      })
    );
  }
}

const _getImplKeyType = impl => {
  if (impl?.isZArray) {
    return 'a';
  } else if (impl?.isZMap) {
    return 'm';
  } else {
    return null;
  }
};
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
  triggerObservers(e) {
    const observers = observersMap.get(this);
    if (observers) {
      for (const fn of observers) {
        fn(e);
      }
    }
  }
  getKeyPath() {
    const keyPath = [];
    for (let binding = this.binding;;) {
      const parentBinding = bindingParentsMap.get(binding);

      if (parentBinding) {
        const parentImpl = bindingsMap.get(parentBinding);
        if (parentImpl.isZDoc) {
          const impl = bindingsMap.get(binding);
          const keyType = _getImplKeyType(impl);
          if (keyType !== null) {
            const keys = Object.keys(parentBinding);
            const matchingKeys = keys.filter(k => parentBinding[k] === binding);
            if (matchingKeys.length === 1) {
              const key = matchingKeys[0];
              keyPath.push([key, keyType]);
            } else {
              console.warn('unexpected number of matching keys; duplicate or corruption', matchingKeys, parentBinding, binding);
              throw new Error('zarray did not have unique key (had ' + matchingKeys.length + ')');
            }
          } else {
            console.warn('unknown key type for doc set', impl, parentImpl);
          }
        } else if (parentImpl.isZArray) {
          const index = parentImpl.binding.e.indexOf(binding);
          const zid = parentImpl.binding.i[index];
          const impl = bindingsMap.get(binding);
          const type = 'e' + (_getImplKeyType(impl) || 'v');
          keyPath.push([zid, type]);
        } else if (parentImpl.isZMap) {
          const keys = Object.keys(parentBinding);
          const matchingKeys = keys.filter(k => parentBinding[k] === binding);
          if (matchingKeys.length === 1) {
            const key = matchingKeys[0];
            const impl = bindingsMap.get(binding);
            const type = _getImplKeyType(impl) || 'v';
            keyPath.push([key, type]);
          } else {
            console.warn('unexpected number of matching keys; duplicate or corruption', matchingKeys, parentBinding, binding);
            throw new Error('zmap did not have unique key (had ' + matchingKeys.length + ')');
          }
        } else {
          console.log('failed to find binding getting key path', binding);
        }
        binding = parentBinding;
      } else {
        break;
      }
    }
    return keyPath.reverse();
  }
  toJSON() {
    return this.binding;
  }
}

const _ensureImplBound = (v, parent) => {
  if (
    v?.isZMap ||
    v?.isZArray
  ) {
    const impl = bindingsMap.get(v.binding);
    if (!impl) {
      bindingsMap.set(v.binding, v);
      bindingParentsMap.set(v.binding, parent.binding);
      v.doc = parent.doc;
    } else {
      throw new Error('already bound');
    }
  }
};
class ZMap extends ZObservable {
  constructor(binding = ZMap.nativeConstructor(), doc = null) {
    super(binding, doc);
    
    this.isZMap = true;
  }
  static nativeConstructor = () => ({});
  has(k) {
    return k in this.binding;
  }
  get(k, Type) {
    if (Type) {
      let binding = this.binding[k];
      if (binding === undefined) {
        // binding = Type.nativeConstructor();
        // this.binding[k] = binding;
        throw new Error('map lookup nonexistent typed element');
      }
      let impl = bindingsMap.get(binding);
      if (!impl) {
        impl = new Type(binding, this);
        bindingsMap.set(binding, impl);
        bindingParentsMap.set(binding, this.binding);
      }
      return impl;
    } else {
      const v = this.binding[k];
      return bindingsMap.get(v) ?? v;
    }
  }
  set(k, v) {
    _ensureImplBound(v, this);
    
    const keyPath = this.getKeyPath();
    const keyType = _getImplKeyType(v) || 'v';
    keyPath.push([k, keyType]);
    const event = new ZMapSetEvent(
      keyPath,
      k,
      v
    );
    event.bindToImpl(this);
    if (this.doc) {
      this.doc.pushTransaction(TRANSACTION_TYPES.mapSet);
      this.doc.transactionCache.pushEvent(event);
    }
    event.apply();
    event.triggerObservers();
    event.gc();
    if (this.doc) {
      this.doc.popTransaction();
    }
  }
  delete(k) {
    delete this.binding[k];
    const keyPath = this.getKeyPath();
    keyPath.push([k, 'v']);
    const event = new ZMapDeleteEvent(
      keyPath,
      k
    );
    event.bindToImpl(this);
    if (this.doc) {
      this.doc.pushTransaction(TRANSACTION_TYPES.mapDelete);
      this.doc.transactionCache.pushEvent(event);
    }
    event.apply();
    event.triggerObservers();
    event.gc();
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
    
    this.isZArray = true;
  }
  static nativeConstructor = () => ({
    e: [],
    i: [],
  });
  get length() {
    return this.binding.e.length;
  }
  set length(length) {
    this.binding.e.length = length;
  }
  get(index) {
    return this.binding.e[index];
  }
  getId(zid, Type) {
    if (Type) {
      const index = this.binding.i.indexOf(zid);
      let binding = this.binding.e[index];
      if (binding === undefined) {
        // binding = Type.nativeConstructor();
        // this.state[k] = binding;
        throw new Error('array lookup nonexistent typed element');
      }
      let impl = bindingsMap.get(binding);
      if (!impl) {
        impl = new Type(binding, this);
        bindingsMap.set(binding, impl);
        bindingParentsMap.set(binding, this.state);
      }
      return impl;
    } else {
      const index = this.binding.i.indexOf(zid);
      if (index !== -1) {
        return this.binding.e[index];
      } else {
        return undefined;
      }
    }
  }
  push(arr) {
    if (arr.length !== 1) {
      throw new Error('only length 1 is supported');
    }
    
    arr.forEach(e => _ensureImplBound(e, this));
    
    const zid = _makeId();
    
    const keyPath = this.getKeyPath();
    const impl = bindingsMap.get(arr[0]);
    const type = 'e' + (_getImplKeyType(impl) || 'v');
    keyPath.push([zid, type]);
    const event = new ZArrayPushEvent(
      keyPath,
      arr
    );
    event.bindToImpl(this);
    if (this.doc) {
      this.doc.pushTransaction(TRANSACTION_TYPES.arrayPush);
      this.doc.transactionCache.pushEvent(event);
    }
    event.apply();
    event.triggerObservers();
    event.gc();
    if (this.doc) {
      this.doc.popTransaction();
    }
  }
  delete(index, length = 1) {
    if (length !== 1) {
      throw new Error('only length 1 is supported');
    }
    
    const zid = this.binding.i[index];
    
    const keyPath = this.getKeyPath();
    keyPath.push([zid, 'ev']);
    const event = new ZArrayDeleteEvent(
      keyPath
    );
    event.bindToImpl(this);
    if (this.doc) {
      this.doc.pushTransaction(TRANSACTION_TYPES.arrayDelete);
      this.doc.transactionCache.pushEvent(event);
    }
    event.apply();
    event.triggerObservers();
    event.gc();
    if (this.doc) {
      this.doc.popTransaction();
    }
  }
  toJSON() {
    return this.binding.e.map(_jsonify);
  }
  [Symbol.iterator] = () => {
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

let zEventsIota = 0;
class ZEvent {
  constructor(keyPath) {
    this.keyPath = keyPath;

    this.impl = null;
    this.keyPathBuffer = null;
  }
  bindToDoc(doc) {
    if (doc) {
      this.impl = doc.getImplByKeyPath(this.keyPath.slice(0, -1));
      // this.doc = doc;
    } else {
      this.impl = null;
      // this.doc = null;
    }
    /* if (!this.impl) {
      if (!doc) {
        doc = new Y.Doc();
      }
      
      const Type = this.constructor.Type;
      const binding = Type.nativeConstructor();
      this.impl = new Type(binding, doc);
      bindingsMap.set(binding, this.impl);
      bindingParentsMap.set(binding, doc.state);
    } */
  }
  bindToImpl(impl) {
    this.impl = impl;
  }
  gc() {
    this.impl = null;
    this.keyPathBuffer = null;
  }
  getEvent() {
    const actionSpec = this.getAction();
    if (actionSpec) {
      if (actionSpec.key) {
        return {
          added: new Set(actionSpec.action === 'add' ? [actionSpec.key] : []),
          deleted: new Set(actionSpec.action === 'delete' ? [actionSpec.key] : []),
          changes: {
            keys: new Map([[
              actionSpec.key,
              {
                action: actionSpec.action,
              },
            ]]),
            values: new Map(),
          },
        };
      } else if (actionSpec.value) {
        return {
          added: new Set(actionSpec.action === 'add' ? [actionSpec.value] : []),
          deleted: new Set(actionSpec.action === 'delete' ? [actionSpec.value] : []),
          changes: {
            keys: new Map(),
            values: new Map([[
              actionSpec.value,
              {
                action: actionSpec.action,
              },
            ]]),
          },
        };
      } else {
        console.warn('unknown action spec format', actionSpec, new Error().stack);
        return null;
      }
    } else {
      return null;
    }
  }
  triggerObservers() {
    const e = this.getEvent();
    if (e !== null) {
      this.impl.triggerObservers(e);
    }
  }
  getKeyPathBuffer() {
    if (this.keyPathBuffer === null) {
      this.keyPathBuffer = textEncoder.encode(
        JSON.stringify(this.keyPath)
      );
    }
    return this.keyPathBuffer;
  }
  computeUpdateByteLength() {
    throw new Error('not implemented');
  }
  serializeUpdate(uint8Array) {
    throw new Error('not implemented');
  }
  static deserializeUpdate(doc, uint8Array) {
    throw new Error('not implemented');
  }
  clone() {
    const event = new ZEvent(this.keyPath);
    event.impl = this.impl;
    return event;
  }
}
class ZNullEvent extends ZEvent {
  constructor() {
    super([]);
    
    this.isZNullEvent = true;
  }
  static METHOD = ++zEventsIota;
  apply() {
    // nothing
  }
  getAction() {
    return null;
  }
  computeUpdateByteLength() {
    let totalSize = 0;
    totalSize += Uint32Array.BYTES_PER_ELEMENT; // method
    
    return totalSize;
  }
  serializeUpdate(uint8Array) {
    const dataView = _makeDataView(uint8Array);
    
    let index = 0;
    dataView.setUint32(index, this.constructor.METHOD, true);
    index += Uint32Array.BYTES_PER_ELEMENT;
  }
  static deserializeUpdate(doc, uint8Array) {
    return new this();
  }
}
class ZMapEvent extends ZEvent {
  constructor(keyPath) {
    super(keyPath);
  
    this.keyBuffer = null;
    this.valueBuffer = null;
    
    this.isZMapEvent = true;
  }
  getKeyBuffer() {
    if (this.keyBuffer === null) {
      this.keyBuffer = textEncoder.encode(this.key);
    }
    return this.keyBuffer;
  }
  getValueBuffer() {
    if (this.valueBuffer === null) {
      this.valueBuffer = zbencode(_getBindingForValue(this.value));
    }
    return this.valueBuffer;
  }
  gc() {
    super.gc();
    
    this.keyBuffer = null;
    this.valueBuffer = null;
  }
}
class ZArrayEvent extends ZEvent {
  constructor(keyPath) {
    super(keyPath);
    
    this.arrBuffer = null;
    
    this.isZArrayEvent = true;
  }
  getArrBuffer() {
    if (this.arrBuffer === null) {
      this.arrBuffer = zbencode(_getBindingForArray(this.arr));
    }
    return this.arrBuffer;
  }
  gc() {
    super.gc();
    
    this.arrBuffer = null;
  }
}
class ZMapSetEvent extends ZMapEvent {
  constructor(keyPath, key, value) {
    super(keyPath);
    
    this.key = key;
    this.value = value;
    
    this.isZMapSetEvent = true;
  }
  static METHOD = ++zEventsIota;
  static Type = ZMap;
  apply() {
    const valueBinding = _getBindingForValue(this.value);
    this.impl.binding[this.key] = valueBinding;
  }
  getAction() {
    return {
      action: 'update',
      key: this.key,
    };
  }
  computeUpdateByteLength() {
    let totalSize = 0;
    totalSize += Uint32Array.BYTES_PER_ELEMENT; // method
    
    totalSize += Uint32Array.BYTES_PER_ELEMENT; // key path length
    totalSize += this.getKeyPathBuffer().byteLength; // key path data
    totalSize = align4(totalSize);
    
    totalSize += Uint32Array.BYTES_PER_ELEMENT; // key length
    totalSize += this.getKeyBuffer().byteLength; // key data
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
    uint8Array.set(kb, index);
    index += kb.byteLength;
    index = align4(index);
    
    const vb = this.getValueBuffer();
    dataView.setUint32(index, vb.byteLength, true);
    index += Uint32Array.BYTES_PER_ELEMENT;
    uint8Array.set(vb, index);
    index += vb.byteLength;
    index = align4(index);
  }
  static deserializeUpdate(doc, uint8Array) {
    const dataView = _makeDataView(uint8Array);
    
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
    index += kbLength;
    index = align4(index);

    const vbLength = dataView.getUint32(index, true);
    index += Uint32Array.BYTES_PER_ELEMENT;
    const vb = new Uint8Array(uint8Array.buffer, uint8Array.byteOffset + index, vbLength);
    const value = zbdecode(vb);
    index += vbLength;
    index = align4(index);

    return new this(
      keyPath,
      key,
      value
    );
  }
}
class ZMapDeleteEvent extends ZMapEvent {
  constructor(keyPath, key) {
    super(keyPath);

    this.key = key;
    
    this.isZMapDeleteEvent = true;
  }
  static METHOD = ++zEventsIota;
  static Type = ZMap;
  apply() {
    delete this.impl.binding[this.key];
  }
  getAction() {
    return {
      action: 'update',
      key: this.key,
    };
  }
  computeUpdateByteLength() {
    let totalSize = 0;
    totalSize += Uint32Array.BYTES_PER_ELEMENT; // method
    
    totalSize += Uint32Array.BYTES_PER_ELEMENT; // key path length
    totalSize += this.getKeyPathBuffer().byteLength; // key path data
    totalSize = align4(totalSize);
    
    totalSize += Uint32Array.BYTES_PER_ELEMENT; // key length
    totalSize += this.getKeyBuffer().byteLength; // key data
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
    uint8Array.set(kb, index);
    index += kb.byteLength;
    index = align4(index);
  }
  static deserializeUpdate(doc, uint8Array) {
    const dataView = _makeDataView(uint8Array);
    
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
    index += kbLength;
    index = align4(index);
    
    return new this(
      keyPath,
      key
    );
  }
}
class ZArrayPushEvent extends ZArrayEvent {
  constructor(keyPath, arr) {
    super(keyPath);

    this.arr = arr;
    
    this.isZArrayPushEvent = true;
  }
  static METHOD = ++zEventsIota;
  static Type = ZArray;
  apply() {
    const arrBinding = _getBindingForArray(this.arr);
    this.impl.binding.e.push.apply(this.impl.binding.e, arrBinding);
    const zid = this.keyPath[this.keyPath.length - 1][0];
    this.impl.binding.i.push(zid);
  }
  getAction() {
    return {
      action: 'add',
      value: this.arr[0],
    };
  }
  computeUpdateByteLength() {
    let totalSize = 0;
    totalSize += Uint32Array.BYTES_PER_ELEMENT; // method
    
    totalSize += Uint32Array.BYTES_PER_ELEMENT; // key path length
    totalSize += this.getKeyPathBuffer().byteLength; // key path data
    totalSize = align4(totalSize);
    
    totalSize += Uint32Array.BYTES_PER_ELEMENT; // arr length
    totalSize += this.getArrBuffer().byteLength; // arr data
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
    
    const arrb = this.getArrBuffer();
    dataView.setUint32(index, arrb.byteLength, true);
    index += Uint32Array.BYTES_PER_ELEMENT;
    
    uint8Array.set(arrb, index);
    index += arrb.byteLength;
    index = align4(index);
  }
  static deserializeUpdate(doc, uint8Array) {
    const dataView = _makeDataView(uint8Array);
    
    let index = 0;
    // skip method
    index += Uint32Array.BYTES_PER_ELEMENT;
    
    const kpjbLength = dataView.getUint32(index, true);
    index += Uint32Array.BYTES_PER_ELEMENT;
    
    const kpjb = new Uint8Array(uint8Array.buffer, uint8Array.byteOffset + index, kpjbLength);
    const keyPath = JSON.parse(textDecoder.decode(kpjb)); 
    index += kpjbLength;
    index = align4(index);

    const arrLength = dataView.getUint32(index, true);
    index += Uint32Array.BYTES_PER_ELEMENT;
    
    const arrb = new Uint8Array(uint8Array.buffer, uint8Array.byteOffset + index, arrLength);
    const arr = zbdecode(arrb);
    index += arrLength;
    index = align4(index);
    
    return new this(
      keyPath,
      arr
    );
  }
}
class ZArrayDeleteEvent extends ZArrayEvent {
  constructor(keyPath) {
    super(keyPath);

    this.oldValue = null;
    
    this.isZArrayDeleteEvent = true;
  }
  static METHOD = ++zEventsIota;
  static Type = ZArray;
  apply() {
    const zid = this.keyPath[this.keyPath.length - 1][0];
    const index = this.impl.binding.i.indexOf(zid);
    this.oldValue = this.impl.binding.e.splice(index, 1)[0];
    this.impl.binding.i.splice(index, 1);
  }
  getAction() {
    return {
      action: 'delete',
      value: this.oldValue,
    };
  }
  computeUpdateByteLength() {
    let totalSize = 0;
    totalSize += Uint32Array.BYTES_PER_ELEMENT; // method
    
    totalSize += Uint32Array.BYTES_PER_ELEMENT; // key path length
    totalSize += this.getKeyPathBuffer().byteLength; // key path data
    totalSize = align4(totalSize);
    
    totalSize += Uint32Array.BYTES_PER_ELEMENT; // op index
    totalSize += Uint32Array.BYTES_PER_ELEMENT; // op length
    
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
  }
  static deserializeUpdate(doc, uint8Array) {
    const dataView = _makeDataView(uint8Array);
    
    let index = 0;
    // skip method
    index += Uint32Array.BYTES_PER_ELEMENT;
    
    const kpjbLength = dataView.getUint32(index, true);
    index += Uint32Array.BYTES_PER_ELEMENT;
    
    const kpjb = new Uint8Array(uint8Array.buffer, uint8Array.byteOffset + index, kpjbLength);
    const keyPath = JSON.parse(textDecoder.decode(kpjb)); 
    index += kpjbLength;
    index = align4(index);
    
    return new this(
      keyPath
    );
  }
}
const ZEVENT_CONSTRUCTORS = [
  null, // start at 1
  ZNullEvent,
  ZMapSetEvent,
  ZMapDeleteEvent,
  ZArrayPushEvent,
  ZArrayDeleteEvent,
];

function applyUpdate(doc, uint8Array, transactionOrigin) {
  const dataView = _makeDataView(uint8Array);
  
  let index = 0;
  const method = dataView.getUint32(index, true);
  index += Uint32Array.BYTES_PER_ELEMENT;
  
  const _handleStateMessage = () => {
    const clock = dataView.getUint32(index, true);
    index += Uint32Array.BYTES_PER_ELEMENT;
    
    const encodedData = new Uint8Array(uint8Array.buffer, uint8Array.byteOffset + index);
    const state = zbdecode(encodedData);
    doc.setClockState(clock, state);
  };
  const _handleTransactionMessage = () => {
    let transactionCache = TransactionCache.deserializeUpdate(doc, uint8Array);
    transactionCache.origin = transactionOrigin;
    
    // rebase on top of local history as needed
    if (transactionCache.startClock === doc.clock) {
      // nothing
    } else if (transactionCache.startClock < doc.clock) {
      const historyTail = doc.history.slice(doc.history.length - (doc.clock - transactionCache.startClock));
      transactionCache.rebase(historyTail);
    } else {
      console.warn('transaction skipped clock ticks; desynced', [transactionCache.startClock, doc.clock]);
      throw new Error('transaction skipped clock ticks; desynced');
    }
    
    transactionCache.bindEventsToDoc();
    for (const event of transactionCache.events) {
      event.apply();
      doc.clock++;
      event.triggerObservers();
      event.gc();
    }
    
    {
      const uint8Array = transactionCache.serializeUpdate();
      doc.dispatchEvent('update', uint8Array, transactionCache.origin, this, null);
    }

    doc.history.push.apply(doc.history, transactionCache.events);
    
    if (doc.clock !== transactionCache.startClock + transactionCache.events.length) {
      console.warn('clock out of sync', doc.clock, transactionCache.startClock + transactionCache.events.length);
      throw new Error('clock out of sync');
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
  
  const totalSize =
    Uint32Array.BYTES_PER_ELEMENT +
    Uint32Array.BYTES_PER_ELEMENT +
    encodedData.byteLength;
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
globalThis.Z = Z; // XXX testing only

import * as Y from 'yjs'; // XXX testing only
globalThis.Y = Y;