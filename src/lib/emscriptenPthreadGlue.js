/**
 * Source patches for emsdk 5.0.7 pthread glue (DeFi `/node/defi/wart-node.js`).
 *
 * Chrome / Brave stable kill DeFi Start with:
 *   Pthread 0x… wart-node.js:401  TypeError: Cannot read properties of undefined (reading 'buffer')
 * Line 401 is `self.onunhandledrejection` rethrowing. The real access is
 * `growMemViews()` (`wasmMemory.buffer != HEAP8.buffer`) or `createWasm()`
 * running before HEAP views exist.
 *
 * Official1 0.9.6 glue is a different toolchain — do not apply these there.
 */

const GROW_MEM_VIEWS_OLD = `function growMemViews() {
  // \`updateMemoryViews\` updates all the views simultaneously, so it's enough to check any of them.
  if (wasmMemory.buffer != HEAP8.buffer) {
    updateMemoryViews();
  }
}`;

const GROW_MEM_VIEWS_NEW = `function growMemViews() {
  // HEAP8 is unset until the pthread "load" message installs wasmMemory.
  // Chrome/Brave stable can run growMemViews in that window; .buffer on
  // undefined becomes an unhandledrejection (glue line ~401).
  if (!wasmMemory) return;
  if (!HEAP8 || wasmMemory.buffer != HEAP8.buffer) {
    updateMemoryViews();
  }
}`;

const PTHREAD_LOAD_OLD = `        wasmMemory = msgData.wasmMemory;
        updateMemoryViews();
        wasmModule = msgData.wasmModule;
        createWasm();
        run();`;

const PTHREAD_LOAD_NEW = `        wasmMemory = msgData.wasmMemory;
        wasmModule = msgData.wasmModule;
        if (!wasmMemory) {
          throw new Error("pthread load: wasmMemory missing from main thread");
        }
        updateMemoryViews();
        // createWasm is async; a throw becomes an unhandled rejection (line 401)
        // if we do not chain. Do not call run() until the instance exists.
        Promise.resolve(createWasm()).then(() => {
          run();
        }).catch((ex) => {
          err(\`worker: createWasm failed: \${ex}\`);
          if (ex?.stack) err(ex.stack);
          throw ex;
        });`;

const UPDATE_MEMORY_VIEWS_STOCK = `function updateMemoryViews() {
  var b = wasmMemory.buffer;
  Module["HEAP8"] = HEAP8 = new Int8Array(b);
  Module["HEAP16"] = HEAP16 = new Int16Array(b);
  Module["HEAPU8"] = HEAPU8 = new Uint8Array(b);
  Module["HEAPU16"] = HEAPU16 = new Uint16Array(b);
  Module["HEAP32"] = HEAP32 = new Int32Array(b);
  Module["HEAPU32"] = HEAPU32 = new Uint32Array(b);
  Module["HEAPF32"] = HEAPF32 = new Float32Array(b);
  Module["HEAPF64"] = HEAPF64 = new Float64Array(b);
  Module["HEAP64"] = HEAP64 = new BigInt64Array(b);
  Module["HEAPU64"] = HEAPU64 = new BigUint64Array(b);
}`;

const UPDATE_MEMORY_VIEWS_GUARDED = `function updateMemoryViews() {
  if (!wasmMemory) {
    abort("updateMemoryViews: wasmMemory is not set (pthread load race)");
  }
  var b = wasmMemory.buffer;
  Module["HEAP8"] = HEAP8 = new Int8Array(b);
  Module["HEAP16"] = HEAP16 = new Int16Array(b);
  Module["HEAPU8"] = HEAPU8 = new Uint8Array(b);
  Module["HEAPU16"] = HEAPU16 = new Uint16Array(b);
  Module["HEAP32"] = HEAP32 = new Int32Array(b);
  Module["HEAPU32"] = HEAPU32 = new Uint32Array(b);
  Module["HEAPF32"] = HEAPF32 = new Float32Array(b);
  Module["HEAPF64"] = HEAPF64 = new Float64Array(b);
  Module["HEAP64"] = HEAP64 = new BigInt64Array(b);
  Module["HEAPU64"] = HEAPU64 = new BigUint64Array(b);
}`;

const UPDATE_MEMORY_VIEWS_LIVE = `function updateMemoryViews() {
  if (!wasmMemory) {
    abort("updateMemoryViews: wasmMemory is not set (pthread load race)");
  }
  var b = wasmMemory.buffer;
  // Locals only. Module.HEAP* are getters (installLiveHeapExports) so WebRTC
  // never reads a stale/undefined snapshot after growth.
  HEAP8 = new Int8Array(b);
  HEAP16 = new Int16Array(b);
  HEAPU8 = new Uint8Array(b);
  HEAPU16 = new Uint16Array(b);
  HEAP32 = new Int32Array(b);
  HEAPU32 = new Uint32Array(b);
  HEAPF32 = new Float32Array(b);
  HEAPF64 = new Float64Array(b);
  HEAP64 = new BigInt64Array(b);
  HEAPU64 = new BigUint64Array(b);
}`;

const HEAP_EXPORTS_OLD = `Module["HEAP16"] = (growMemViews(), HEAP16);

Module["HEAP32"] = (growMemViews(), HEAP32);

Module["HEAP64"] = (growMemViews(), HEAP64);

Module["HEAP8"] = (growMemViews(), HEAP8);

Module["HEAPF32"] = (growMemViews(), HEAPF32);

Module["HEAPF64"] = (growMemViews(), HEAPF64);

Module["HEAPU16"] = (growMemViews(), HEAPU16);

Module["HEAPU32"] = (growMemViews(), HEAPU32);

Module["HEAPU64"] = (growMemViews(), HEAPU64);

Module["HEAPU8"] = (growMemViews(), HEAPU8);`;

const HEAP_EXPORTS_NEW = `function installLiveHeapExports() {
  var specs = [
    ["HEAP8", () => HEAP8],
    ["HEAP16", () => HEAP16],
    ["HEAPU8", () => HEAPU8],
    ["HEAPU16", () => HEAPU16],
    ["HEAP32", () => HEAP32],
    ["HEAPU32", () => HEAPU32],
    ["HEAPF32", () => HEAPF32],
    ["HEAPF64", () => HEAPF64],
    ["HEAP64", () => HEAP64],
    ["HEAPU64", () => HEAPU64]
  ];
  for (const spec of specs) {
    Object.defineProperty(Module, spec[0], {
      configurable: true,
      enumerable: true,
      get: () => {
        growMemViews();
        return spec[1]();
      }
    });
  }
}
installLiveHeapExports();`;

const RTC_SEND_OLD = `    var heapBytes = new Uint8Array(Module["HEAPU8"].buffer, pBuffer, size);
    if (heapBytes.buffer instanceof ArrayBuffer) {
      dataChannel.send(heapBytes);
    } else {
      var byteArray = new Uint8Array(new ArrayBuffer(size));
      byteArray.set(heapBytes);
      dataChannel.send(byteArray);
    }`;

const RTC_SEND_NEW = `    growMemViews();
    if (!HEAPU8) return -1;
    var heapBytes = HEAPU8.subarray(pBuffer, pBuffer + size);
    var byteArray = new Uint8Array(size);
    byteArray.set(heapBytes);
    dataChannel.send(byteArray);`;

const RTC_RECV_OLD = `      var heapBytes = new Uint8Array(Module["HEAPU8"].buffer, pBuffer, size);
      heapBytes.set(byteArray);`;

const RTC_RECV_NEW = `      growMemViews();
      if (!HEAPU8) return;
      HEAPU8.subarray(pBuffer, pBuffer + size).set(byteArray);`;

const RTC_ICE_OLD = `    var heap = Module["HEAPU32"];`;

const RTC_ICE_NEW = `    growMemViews();
    var heap = HEAPU32;
    if (!heap) return 0;`;

const OPFS_READ_OLD = `function __wasmfs_opfs_read_access(accessID, bufPtr, len, pos) {
  pos = bigintToI53Checked(pos);
  let accessHandle = wasmfsOPFSAccessHandles.get(accessID);
  let data = (growMemViews(), HEAPU8).subarray(bufPtr, bufPtr + len);
  try {
    return accessHandle.read(data, {
      at: pos
    });
  } catch (e) {
    if (e.name == "TypeError") {
      return -28;
    }
    err("unexpected error:", e, e.stack);
    return -29;
  }
}`;

const OPFS_READ_NEW = `function __wasmfs_opfs_read_access(accessID, bufPtr, len, pos) {
  pos = bigintToI53Checked(pos);
  let accessHandle = wasmfsOPFSAccessHandles.get(accessID);
  growMemViews();
  if (!HEAPU8) return -28;
  // Chrome stable rejects SharedArrayBuffer views on SyncAccessHandle.
  let data = new Uint8Array(len);
  try {
    let nread = accessHandle.read(data, {
      at: pos
    });
    growMemViews();
    if (nread > 0 && HEAPU8) HEAPU8.set(data.subarray(0, nread), bufPtr);
    return nread;
  } catch (e) {
    if (e.name == "TypeError") {
      return -28;
    }
    err("unexpected error:", e, e.stack);
    return -29;
  }
}`;

const OPFS_WRITE_OLD = `function __wasmfs_opfs_write_access(accessID, bufPtr, len, pos) {
  pos = bigintToI53Checked(pos);
  let accessHandle = wasmfsOPFSAccessHandles.get(accessID);
  let data = (growMemViews(), HEAPU8).subarray(bufPtr, bufPtr + len);
  try {
    return accessHandle.write(data, {
      at: pos
    });
  } catch (e) {
    if (e.name == "TypeError") {
      return -28;
    }
    err("unexpected error:", e, e.stack);
    return -29;
  }
}`;

const OPFS_WRITE_NEW = `function __wasmfs_opfs_write_access(accessID, bufPtr, len, pos) {
  pos = bigintToI53Checked(pos);
  let accessHandle = wasmfsOPFSAccessHandles.get(accessID);
  growMemViews();
  if (!HEAPU8) return -28;
  let data = new Uint8Array(HEAPU8.subarray(bufPtr, bufPtr + len));
  try {
    return accessHandle.write(data, {
      at: pos
    });
  } catch (e) {
    if (e.name == "TypeError") {
      return -28;
    }
    err("unexpected error:", e, e.stack);
    return -29;
  }
}`;

function replaceOnce(haystack, oldStr, newStr) {
  if (!oldStr || haystack.includes(newStr) && !haystack.includes(oldStr)) {
    return haystack;
  }
  if (!haystack.includes(oldStr)) return haystack;
  return haystack.replace(oldStr, newStr);
}

export function patchEmscriptenPthreadGlue(source) {
  let out = String(source);
  // Official1 0.9.6 uses GROWABLE_HEAP_* not growMemViews — leave it alone.
  if (!out.includes('function growMemViews()')) return out;
  out = replaceOnce(out, GROW_MEM_VIEWS_OLD, GROW_MEM_VIEWS_NEW);
  out = replaceOnce(out, PTHREAD_LOAD_OLD, PTHREAD_LOAD_NEW);
  if (out.includes(UPDATE_MEMORY_VIEWS_STOCK)) {
    out = replaceOnce(out, UPDATE_MEMORY_VIEWS_STOCK, UPDATE_MEMORY_VIEWS_LIVE);
  } else {
    out = replaceOnce(out, UPDATE_MEMORY_VIEWS_GUARDED, UPDATE_MEMORY_VIEWS_LIVE);
  }
  out = replaceOnce(out, HEAP_EXPORTS_OLD, HEAP_EXPORTS_NEW);
  out = replaceOnce(out, RTC_SEND_OLD, RTC_SEND_NEW);
  out = replaceOnce(out, RTC_RECV_OLD, RTC_RECV_NEW);
  out = replaceOnce(out, RTC_ICE_OLD, RTC_ICE_NEW);
  out = replaceOnce(out, OPFS_READ_OLD, OPFS_READ_NEW);
  out = replaceOnce(out, OPFS_WRITE_OLD, OPFS_WRITE_NEW);
  return out;
}

export function pthreadGluePatchApplied(source) {
  const s = String(source);
  return s.includes('if (!wasmMemory) return;')
    && s.includes('pthread load: wasmMemory missing from main thread')
    && s.includes('installLiveHeapExports')
    && s.includes('Chrome stable rejects SharedArrayBuffer views');
}
