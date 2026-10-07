/**
 * Rewrites a WAV file as the canonical 44-byte-header form (16 kHz mono PCM16, `fmt ` then
 * `data`, nothing else). Apple's recorders add padding chunks (`FLLR`) and use the
 * WAVE_FORMAT_EXTENSIBLE header, which strict consumers reject. Copies bytes; no decoding.
 */

const PCM = 0x0001
const EXTENSIBLE = 0xfffe

export const SAMPLE_RATE = 16_000

export class InvalidWav extends Error {}

export function canonicalWav(input: Uint8Array): Uint8Array {
  const view = new DataView(input.buffer, input.byteOffset, input.byteLength)
  const tag = (at: number) => String.fromCharCode(...input.subarray(at, at + 4))

  if (input.byteLength < 12 || tag(0) !== "RIFF" || tag(8) !== "WAVE") {
    throw new InvalidWav("not a RIFF/WAVE file")
  }

  let format: { tag: number; channels: number; rate: number; bits: number } | undefined
  let data: Uint8Array | undefined

  for (let at = 12; at + 8 <= input.byteLength;) {
    const id = tag(at)
    const size = view.getUint32(at + 4, true)
    const body = at + 8
    if (id === "fmt " && size >= 16) {
      let formatTag = view.getUint16(body, true)
      // Extensible: the real format is the first two bytes of the subformat GUID.
      if (formatTag === EXTENSIBLE && size >= 40) formatTag = view.getUint16(body + 24, true)
      format = {
        tag: formatTag,
        channels: view.getUint16(body + 2, true),
        rate: view.getUint32(body + 4, true),
        bits: view.getUint16(body + 14, true)
      }
    } else if (id === "data") {
      // Recorders that were cut off may leave a placeholder size; clamp to what arrived.
      data = input.subarray(body, Math.min(body + size, input.byteLength))
      break
    }
    at = body + size + (size & 1)
  }

  if (!format) throw new InvalidWav("missing fmt chunk")
  if (!data) throw new InvalidWav("missing data chunk")
  if (format.tag !== PCM || format.channels !== 1 || format.rate !== SAMPLE_RATE || format.bits !== 16) {
    throw new InvalidWav(
      `expected 16 kHz mono PCM16, got format ${format.tag}, ${format.channels} ch, ${format.rate} Hz, ${format.bits} bit`
    )
  }

  const length = data.byteLength - (data.byteLength & 1)
  const out = new Uint8Array(44 + length)
  const header = new DataView(out.buffer)
  const ascii = (at: number, text: string) => out.set([...text].map((c) => c.charCodeAt(0)), at)
  ascii(0, "RIFF")
  header.setUint32(4, 36 + length, true)
  ascii(8, "WAVE")
  ascii(12, "fmt ")
  header.setUint32(16, 16, true)
  header.setUint16(20, PCM, true)
  header.setUint16(22, 1, true)
  header.setUint32(24, SAMPLE_RATE, true)
  header.setUint32(28, SAMPLE_RATE * 2, true)
  header.setUint16(32, 2, true)
  header.setUint16(34, 16, true)
  ascii(36, "data")
  header.setUint32(40, length, true)
  out.set(data.subarray(0, length), 44)
  return out
}
