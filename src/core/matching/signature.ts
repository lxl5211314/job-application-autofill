// T010: 字段签名生成（contracts/semantic-fields.md §5）
// signature = sha1(norm(label) + "|" + controlKind + "|" + norm(nameIdPlaceholder) + "|" + optionSetFingerprint)

import type { ControlKind } from "./vocabulary"

/** 全角→半角、转小写、去标点与空白 */
export function normLabel(input: string): string {
  let out = ""
  for (const ch of input) {
    const code = ch.codePointAt(0) ?? 0
    if (code >= 0xff01 && code <= 0xff5e) {
      out += String.fromCharCode(code - 0xfee0)
    } else if (code === 0x3000) {
      out += " "
    } else {
      out += ch
    }
  }
  return out
    .toLowerCase()
    .replace(/[（）()【】[\]{}·、，,。.．;；:：'"/\\|!?！？*~`^&%$#@<>]/g, "")
    .replace(/\s+/g, "")
    .trim()
}

/** 同步 SHA-1（纯 TS，无外部依赖；仅用于本地签名，非安全用途） */
export function sha1Hex(message: string): string {
  return sha1Bytes(utf8Bytes(message))
}

function utf8Bytes(str: string): Uint8Array {
  const out: number[] = []
  for (const ch of str) {
    const cp = ch.codePointAt(0) as number
    if (cp < 0x80) out.push(cp)
    else if (cp < 0x800) out.push(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f))
    else if (cp < 0x10000)
      out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f))
    else
      out.push(
        0xf0 | (cp >> 18),
        0x80 | ((cp >> 12) & 0x3f),
        0x80 | ((cp >> 6) & 0x3f),
        0x80 | (cp & 0x3f)
      )
  }
  return new Uint8Array(out)
}

function sha1Bytes(msg: Uint8Array): string {
  const ml = msg.length
  const bitLen = ml * 8
  const padded = new Uint8Array((((ml + 8) >> 6) << 6) + 64)
  padded.set(msg)
  padded[ml] = 0x80
  const dv = new DataView(padded.buffer)
  dv.setUint32(padded.length - 8, Math.floor(bitLen / 0x100000000), false)
  dv.setUint32(padded.length - 4, bitLen >>> 0, false)

  let h0 = 0x67452301
  let h1 = 0xefcdab89
  let h2 = 0x98badcfe
  let h3 = 0x10325476
  let h4 = 0xc3d2e1f0

  const w = new Array<number>(80)
  for (let off = 0; off < padded.length; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = dv.getUint32(off + i * 4, false)
    for (let i = 16; i < 80; i++) {
      const x =
        ((w[i - 3] as number) ^
          (w[i - 8] as number) ^
          (w[i - 14] as number) ^
          (w[i - 16] as number)) >>>
        0
      w[i] = ((x << 1) | (x >>> 31)) >>> 0
    }
    let a = h0
    let b = h1
    let c = h2
    let d = h3
    let e = h4
    for (let i = 0; i < 80; i++) {
      let f: number
      let k: number
      if (i < 20) {
        f = (b & c) | (~b & d)
        k = 0x5a827999
      } else if (i < 40) {
        f = b ^ c ^ d
        k = 0x6ed9eba1
      } else if (i < 60) {
        f = (b & c) | (b & d) | (c & d)
        k = 0x8f1bbcdc
      } else {
        f = b ^ c ^ d
        k = 0xca62c1d6
      }
      const temp = ((((a << 5) | (a >>> 27)) >>> 0) + f + e + k + (w[i] as number)) >>> 0
      e = d
      d = c
      c = ((b << 30) | (b >>> 2)) >>> 0
      b = a
      a = temp
    }
    h0 = (h0 + a) >>> 0
    h1 = (h1 + b) >>> 0
    h2 = (h2 + c) >>> 0
    h3 = (h3 + d) >>> 0
    h4 = (h4 + e) >>> 0
  }

  return [h0, h1, h2, h3, h4]
    .map((n) => (n >>> 0).toString(16).padStart(8, "0"))
    .join("")
}

/** 选项集指纹：排序后选项文本的短哈希；无选项返回 "-" */
export function optionSetFingerprint(optionTexts: string[] | undefined): string {
  if (!optionTexts || optionTexts.length === 0) return "-"
  const sorted = optionTexts
    .map((t) => normLabel(t))
    .filter((t) => t !== "")
    .sort()
  if (sorted.length === 0) return "-"
  return sha1Hex(sorted.join(",")).slice(0, 8)
}

export interface SignatureInput {
  labelText: string
  controlKind: ControlKind
  nameIdPlaceholder: string
  optionTexts?: string[]
}

export function fieldSignature(input: SignatureInput): string {
  const parts = [
    normLabel(input.labelText),
    input.controlKind,
    normLabel(input.nameIdPlaceholder),
    optionSetFingerprint(input.optionTexts)
  ]
  return sha1Hex(parts.join("|"))
}
