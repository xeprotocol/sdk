#!/usr/bin/env python3
"""Generate src/pow-wasm.ts: a WebAssembly proof-of-work search loop.

The digest input is nonce_LE(8) || hash(32) — a single BLAKE2b block with an
8-byte digest — so the compression is fully unrolled with the message words
fixed: m0 is the nonce, m1..m4 the block hash, the rest zero. Requires wat2wasm.

    python3 scripts/gen-pow-wasm.py
"""
import base64, os, subprocess, tempfile

IV = [0x6a09e667f3bcc908, 0xbb67ae8584caa73b, 0x3c6ef372fe94f82b, 0xa54ff53a5f1d36f1,
      0x510e527fade682d1, 0x9b05688c2b3e6c1f, 0x1f83d9abfb41bd6b, 0x5be0cd19137e2179]
SIGMA = [
    [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
    [14, 10, 4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11, 7, 5, 3],
    [11, 8, 12, 0, 5, 2, 15, 13, 10, 14, 3, 6, 7, 1, 9, 4],
    [7, 9, 3, 1, 13, 12, 11, 14, 2, 6, 5, 10, 4, 0, 15, 8],
    [9, 0, 5, 7, 2, 4, 10, 15, 14, 1, 11, 12, 6, 8, 3, 13],
    [2, 12, 6, 10, 0, 11, 8, 3, 4, 13, 7, 5, 15, 14, 1, 9],
    [12, 5, 1, 15, 14, 13, 4, 10, 0, 7, 6, 3, 9, 2, 8, 11],
    [13, 11, 7, 14, 12, 1, 3, 9, 5, 0, 15, 4, 8, 6, 2, 10],
    [6, 15, 14, 9, 11, 3, 0, 8, 12, 2, 13, 7, 1, 4, 10, 5],
    [10, 2, 8, 4, 7, 6, 1, 5, 15, 11, 9, 14, 3, 12, 13, 0],
]
SIGMA += SIGMA[:2]

def c(x):
    x &= (1 << 64) - 1
    return f"(i64.const {x - (1 << 64) if x >= 1 << 63 else x})"

def m(i):
    return f"(local.get $m{i})" if i <= 4 else None

def add3(a, b, mi):
    e = f"(i64.add (local.get $v{a}) (local.get $v{b}))"
    if m(mi):
        e = f"(i64.add {e} {m(mi)})"
    return f"(local.set $v{a} {e})"

def g(a, b, cc, d, x, y):
    out = [add3(a, b, x),
           f"(local.set $v{d} (i64.rotr (i64.xor (local.get $v{d}) (local.get $v{a})) (i64.const 32)))",
           f"(local.set $v{cc} (i64.add (local.get $v{cc}) (local.get $v{d})))",
           f"(local.set $v{b} (i64.rotr (i64.xor (local.get $v{b}) (local.get $v{cc})) (i64.const 24)))",
           add3(a, b, y),
           f"(local.set $v{d} (i64.rotr (i64.xor (local.get $v{d}) (local.get $v{a})) (i64.const 16)))",
           f"(local.set $v{cc} (i64.add (local.get $v{cc}) (local.get $v{d})))",
           f"(local.set $v{b} (i64.rotr (i64.xor (local.get $v{b}) (local.get $v{cc})) (i64.const 63)))"]
    return "\n".join(out)

h0 = IV[0] ^ 0x01010008
body = []
init = [h0] + IV[1:] + IV[:4] + [IV[4] ^ 40, IV[5], (~IV[6]) & ((1 << 64) - 1), IV[7]]
for i, val in enumerate(init):
    body.append(f"(local.set $v{i} {c(val)})")
for s in SIGMA:
    body += [g(0, 4, 8, 12, s[0], s[1]), g(1, 5, 9, 13, s[2], s[3]),
             g(2, 6, 10, 14, s[4], s[5]), g(3, 7, 11, 15, s[6], s[7]),
             g(0, 5, 10, 15, s[8], s[9]), g(1, 6, 11, 12, s[10], s[11]),
             g(2, 7, 8, 13, s[12], s[13]), g(3, 4, 9, 14, s[14], s[15])]

locals_ = " ".join(f"(local $v{i} i64)" for i in range(16))
bswap = """
  (func $bswap (param $x i64) (result i64)
    (i64.or
      (i64.or
        (i64.or (i64.shl (local.get $x) (i64.const 56))
                (i64.shl (i64.and (local.get $x) (i64.const 0xff00)) (i64.const 40)))
        (i64.or (i64.shl (i64.and (local.get $x) (i64.const 0xff0000)) (i64.const 24))
                (i64.shl (i64.and (local.get $x) (i64.const 0xff000000)) (i64.const 8))))
      (i64.or
        (i64.or (i64.and (i64.shr_u (local.get $x) (i64.const 8)) (i64.const 0xff000000))
                (i64.and (i64.shr_u (local.get $x) (i64.const 24)) (i64.const 0xff0000)))
        (i64.or (i64.and (i64.shr_u (local.get $x) (i64.const 40)) (i64.const 0xff00))
                (i64.shr_u (local.get $x) (i64.const 56))))))"""

wat = f"""(module
  (memory (export "memory") 1)
  {bswap}
  ;; digest(nonce) with the block hash at memory[0..32): the BLAKE2b-64 output
  ;; word, read big-endian as the node does.
  (func $digest (param $m0 i64) (result i64)
    (local $m1 i64) (local $m2 i64) (local $m3 i64) (local $m4 i64) {locals_}
    (local.set $m1 (i64.load (i32.const 0)))
    (local.set $m2 (i64.load (i32.const 8)))
    (local.set $m3 (i64.load (i32.const 16)))
    (local.set $m4 (i64.load (i32.const 24)))
    {chr(10).join(body)}
    (call $bswap (i64.xor (i64.xor {c(h0)} (local.get $v0)) (local.get $v8))))
  (export "digest" (func $digest))
  ;; Try `count` nonces from `start`. Returns 1 and stores the nonce at
  ;; memory[64] when one meets `need` (unsigned), else 0.
  (func (export "search") (param $start i64) (param $count i32) (param $need i64) (result i32)
    (local $n i64)
    (local.set $n (local.get $start))
    (block $done
      (loop $next
        (br_if $done (i32.eqz (local.get $count)))
        (if (i64.ge_u (call $digest (local.get $n)) (local.get $need))
          (then (i64.store (i32.const 64) (local.get $n)) (return (i32.const 1))))
        (local.set $n (i64.add (local.get $n) (i64.const 1)))
        (local.set $count (i32.sub (local.get $count) (i32.const 1)))
        (br $next)))
    (i32.const 0)))
"""

root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
with tempfile.TemporaryDirectory() as d:
    src, out = os.path.join(d, "pow.wat"), os.path.join(d, "pow.wasm")
    open(src, "w").write(wat)
    subprocess.run(["wat2wasm", src, "-o", out], check=True)
    wasm = open(out, "rb").read()

b64 = base64.b64encode(wasm).decode()
lines = [b64[i:i + 100] for i in range(0, len(b64), 100)]
ts = "// Generated by scripts/gen-pow-wasm.py — do not edit.\n"
ts += f"// {len(wasm)} bytes: an unrolled single-block BLAKE2b-64 proof-of-work search.\n"
ts += "export const POW_WASM_BASE64 =\n" + " +\n".join(f"  '{l}'" for l in lines) + "\n"
open(os.path.join(root, "src", "pow-wasm.ts"), "w").write(ts)
print(f"wrote src/pow-wasm.ts ({len(wasm)} bytes of wasm)")
