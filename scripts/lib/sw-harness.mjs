// Minimal Service Worker sandbox for behavioural tests of dist/sw.js:
// in-memory CacheStorage (insertion-ordered, put() moves an entry to the end
// like the spec), scripted fetch, and fetch/install/activate dispatch.
import vm from 'node:vm';

class MockResponse {
  constructor(body = '', { status = 200, type = 'basic' } = {}) {
    this.body = String(body);
    this.status = status;
    this.ok = status >= 200 && status < 300;
    this.type = type;
  }
  clone() {
    return new MockResponse(this.body, { status: this.status, type: this.type });
  }
  static error() {
    return new MockResponse('', { status: 0, type: 'error' });
  }
}

class MockCache {
  constructor() {
    this.entries = new Map();
  }
  async match(request) {
    return this.entries.get(keyOf(request))?.clone();
  }
  async put(request, response) {
    const key = keyOf(request);
    this.entries.delete(key);
    this.entries.set(key, response);
  }
  async keys() {
    return [...this.entries.keys()].map((url) => ({ url }));
  }
  async delete(request) {
    return this.entries.delete(keyOf(request));
  }
}

function keyOf(request) {
  return typeof request === 'string' ? request : request.url;
}

export function createServiceWorkerSandbox(source, { origin = 'https://routebook.test', network }) {
  const listeners = {};
  const stores = new Map();
  const fetchLog = [];
  const caches = {
    async open(name) {
      if (!stores.has(name)) stores.set(name, new MockCache());
      return stores.get(name);
    },
    async match(request) {
      for (const cache of stores.values()) {
        const hit = await cache.match(request);
        if (hit) return hit;
      }
      return undefined;
    },
    async keys() {
      return [...stores.keys()];
    },
    async delete(name) {
      return stores.delete(name);
    }
  };
  const self = {
    registration: { scope: `${origin}/` },
    location: new URL(`${origin}/sw.js`),
    clients: { claim: async () => {} },
    skipWaiting: async () => {},
    addEventListener: (type, handler) => {
      listeners[type] = handler;
    }
  };
  const context = vm.createContext({
    self,
    caches,
    URL,
    Set,
    Promise,
    Response: MockResponse,
    Request: class {
      constructor(url) {
        this.url = url;
      }
    },
    fetch: async (request) => {
      const url = keyOf(request);
      fetchLog.push(url);
      return network(url);
    }
  });
  vm.runInContext(source, context);

  async function dispatchFetch(path, { mode = 'no-cors', method = 'GET' } = {}) {
    const url = new URL(path, origin).href;
    const pending = [];
    let responded = null;
    listeners.fetch({
      request: { url, method, mode },
      respondWith: (value) => {
        responded = Promise.resolve(value);
      },
      waitUntil: (promise) => pending.push(promise)
    });
    if (!responded) return { intercepted: false, response: MockResponse.error() };
    const response = await responded;
    await Promise.all(pending);
    return { intercepted: true, response };
  }

  async function dispatchLifecycle(type) {
    let pending;
    listeners[type]({ waitUntil: (promise) => (pending = promise) });
    await pending;
  }

  return { MockResponse, stores, fetchLog, dispatchFetch, dispatchLifecycle };
}
