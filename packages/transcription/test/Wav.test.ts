import { describe, expect, it } from "@effect/vitest"
import { Result } from "effect"
import { Wav } from "../src/index.ts"

interface Format {
  readonly tag?: number
  readonly channels?: number
  readonly rate?: number
  readonly bits?: number
  /** WAVE_FORMAT_EXTENSIBLE header, with `tag` as the subformat. */
  readonly extensible?: boolean
}

const ascii = (text: string) => Uint8Array.from(text, (c) => c.charCodeAt(0))

const u16 = (n: number) => new Uint8Array(new Uint16Array([n]).buffer)

const u32 = (n: number) => new Uint8Array(new Uint32Array([n]).buffer)

const concat = (...parts: ReadonlyArray<Uint8Array>) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0))
  let at = 0

  for (const part of parts) {
    out.set(part, at)
    at += part.byteLength
  }

  return out
}

const chunk = (id: string, body: Uint8Array, size = body.byteLength) =>
  concat(ascii(id), u32(size), body, body.byteLength & 1 ? new Uint8Array(1) : new Uint8Array(0))

const fmt = ({ tag = 1, channels = 1, rate = 16_000, bits = 16, extensible = false }: Format = {}) => {
  const base = concat(
    u16(extensible ? 0xfffe : tag),
    u16(channels),
    u32(rate),
    u32(rate * channels * bits / 8),
    u16(channels * bits / 8),
    u16(bits)
  )

  // cbSize, valid bits, channel mask, then the subformat GUID, whose first two bytes are the format.
  return chunk("fmt ", extensible ? concat(base, u16(22), u16(bits), u32(0), u16(tag), new Uint8Array(14)) : base)
}

const riff = (...chunks: ReadonlyArray<Uint8Array>) => {
  const body = concat(ascii("WAVE"), ...chunks)

  return concat(ascii("RIFF"), u32(body.byteLength), body)
}

const samples = Uint8Array.from({ length: 64 }, (_, i) => i)

const canonical = (input: Uint8Array) => Result.getOrThrow(Wav.canonical(input))

const rejection = (input: Uint8Array) =>
  Result.match(Wav.canonical(input), {
    onSuccess: () => "accepted",
    onFailure: (e) => e.message
  })

describe("Wav.canonical", () => {
  it("writes the 44-byte header followed by the samples", () => {
    const out = canonical(riff(fmt(), chunk("data", samples)))
    const header = new DataView(out.buffer)

    expect(out.byteLength).toBe(44 + samples.byteLength)
    expect(String.fromCharCode(...out.subarray(0, 4), ...out.subarray(8, 16), ...out.subarray(36, 40))).toBe(
      "RIFFWAVEfmt data"
    )
    expect(header.getUint32(4, true)).toBe(36 + samples.byteLength)
    expect(header.getUint32(24, true)).toBe(Wav.SAMPLE_RATE)
    expect(header.getUint32(40, true)).toBe(samples.byteLength)
    expect(out.subarray(44)).toEqual(samples)
  })

  it("drops padding chunks and the extensible header", () => {
    const apple = riff(fmt({ extensible: true }), chunk("FLLR", new Uint8Array(4000)), chunk("data", samples))

    expect(canonical(apple)).toEqual(canonical(riff(fmt(), chunk("data", samples))))
  })

  it("is unchanged by a second pass", () => {
    const once = canonical(riff(fmt({ extensible: true }), chunk("data", samples)))

    expect(canonical(once)).toEqual(once)
  })

  it("keeps the samples that arrived when the data size overstates them", () => {
    const cutOff = riff(fmt(), chunk("data", samples, 1_000_000))

    expect(canonical(cutOff).subarray(44)).toEqual(samples)
  })

  it("drops a trailing odd byte, half a sample", () => {
    expect(canonical(riff(fmt(), chunk("data", samples.subarray(0, 63)))).subarray(44)).toEqual(
      samples.subarray(0, 62)
    )
  })

  it("rejects anything but 16 kHz mono PCM16", () => {
    const data = chunk("data", samples)

    expect(rejection(riff(fmt({ tag: 3, bits: 32 }), data))).toMatch(/^expected 16 kHz mono PCM16/)
    expect(rejection(riff(fmt({ tag: 3, bits: 32, extensible: true }), data))).toMatch(/format 3,/)
    expect(rejection(riff(fmt({ channels: 2 }), data))).toMatch(/2 ch/)
    expect(rejection(riff(fmt({ rate: 44_100 }), data))).toMatch(/44100 Hz/)
    expect(rejection(riff(fmt({ bits: 8 }), data))).toMatch(/8 bit/)
  })

  it("rejects files that aren't RIFF/WAVE or lack a chunk", () => {
    expect(rejection(ascii("ID3\u0004 not a wav"))).toBe("not a RIFF/WAVE file")
    expect(rejection(riff(chunk("data", samples)))).toBe("missing fmt chunk")
    expect(rejection(riff(fmt()))).toBe("missing data chunk")
    expect(rejection(riff(fmt()).subarray(0, 30))).toBe("truncated fmt chunk")
  })
})
