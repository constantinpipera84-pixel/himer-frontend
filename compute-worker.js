/**
 * HIMER Compute Worker
 * Runs inside a WebWorker in the contributor's browser.
 * Receives chunk payloads, executes real computation, returns result + hash.
 *
 * This is sandboxed: no DOM, no file access, no cookies. Pure computation.
 */

// SHA-256 implementation (synchronous, for hashing workloads + result hashing)
async function sha256(str) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

// Deterministic PRNG (seeded) so witness verification is reproducible
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ============================================================
// WORKLOADS
// ============================================================

// Matrix multiplication (ML primitive)
function workloadMatrix(payload) {
  const n = Math.min(payload.size || 64, 256);
  const rng = mulberry32(payload.seed || 1);
  const A = new Float64Array(n * n);
  const B = new Float64Array(n * n);
  for (let i = 0; i < n * n; i++) { A[i] = rng(); B[i] = rng(); }
  const C = new Float64Array(n * n);
  for (let i = 0; i < n; i++) {
    for (let k = 0; k < n; k++) {
      const a = A[i * n + k];
      for (let j = 0; j < n; j++) {
        C[i * n + j] += a * B[k * n + j];
      }
    }
  }
  // Result = checksum of matrix (deterministic)
  let sum = 0;
  for (let i = 0; i < n * n; i++) sum += C[i];
  return { checksum: sum.toFixed(6), size: n };
}

// Monte Carlo simulation (estimate Pi — science/finance primitive)
function workloadMonteCarlo(payload) {
  const samples = Math.min(payload.samples || 500000, 5000000);
  const rng = mulberry32(payload.seed || 1);
  let inside = 0;
  for (let i = 0; i < samples; i++) {
    const x = rng(), y = rng();
    if (x * x + y * y <= 1) inside++;
  }
  const piEstimate = (4 * inside) / samples;
  return { pi: piEstimate.toFixed(8), samples, inside };
}

// Data processing (map/filter/reduce)
function workloadDataProcess(payload) {
  const count = Math.min(payload.count || 100000, 2000000);
  const rng = mulberry32(payload.seed || 1);
  const transform = payload.transform || 'sum';
  let acc = 0;
  for (let i = 0; i < count; i++) {
    const v = rng() * 1000;
    if (transform === 'sum') acc += v;
    else if (transform === 'sumsq') acc += v * v;
    else if (transform === 'max') acc = Math.max(acc, v);
    else acc += v;
  }
  return { result: acc.toFixed(4), count, transform };
}

// Hashing (proof-of-work style)
function workloadHashingSync(payload) {
  // Simple synchronous hash chain (avoid async in tight loop)
  const start = payload.nonce_start || 0;
  const iterations = 50000;
  let h = start;
  for (let i = 0; i < iterations; i++) {
    h = ((h << 5) - h + i) | 0;
    h = (h ^ (h >>> 13)) | 0;
  }
  return { hashResult: (h >>> 0).toString(16), iterations };
}

// Prime search
function workloadPrimes(payload) {
  const from = payload.from || 0;
  const to = Math.min(payload.to || 100000, from + 200000);
  let count = 0;
  let largest = 0;
  for (let n = Math.max(2, from); n < to; n++) {
    let isPrime = true;
    for (let d = 2; d * d <= n; d++) {
      if (n % d === 0) { isPrime = false; break; }
    }
    if (isPrime) { count++; largest = n; }
  }
  return { primeCount: count, largest, range: [from, to] };
}

// ============================================================
// DISPATCHER
// ============================================================
async function executeWorkload(workload, payload) {
  switch (workload) {
    case 'matrix': return workloadMatrix(payload);
    case 'montecarlo': return workloadMonteCarlo(payload);
    case 'dataprocess': return workloadDataProcess(payload);
    case 'hashing': return workloadHashingSync(payload);
    case 'primes': return workloadPrimes(payload);
    default: return workloadMatrix(payload);
  }
}

// ============================================================
// MESSAGE HANDLER
// ============================================================
self.onmessage = async function (e) {
  const { chunkId, jobId, workload, payload, index, total } = e.data;
  const startTime = performance.now();
  try {
    const result = await executeWorkload(workload, payload);
    const computeMs = performance.now() - startTime;
    // Hash the result for proof-of-compute
    const resultStr = JSON.stringify(result);
    const hash = await sha256(resultStr + ':' + chunkId);
    self.postMessage({
      type: 'CHUNK_DONE',
      chunkId, jobId, index, total,
      result, hash,
      computeMs: Math.round(computeMs),
    });
  } catch (err) {
    self.postMessage({
      type: 'CHUNK_ERROR',
      chunkId, jobId,
      error: err.message,
    });
  }
};
